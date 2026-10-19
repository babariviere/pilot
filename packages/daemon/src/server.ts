/** HTTP API and WebSocket event streams. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { getLibraryAsset, isArtifactLibrary } from "@pilot/artifacts";
import type {
	ArtifactLibrary,
	AttachmentChatPayload,
	AttachmentUpload,
	BindPullRequestRequest,
	ChangeModelRequest,
	ClientMessage,
	CompactRequest,
	CreateMissionRequest,
	DaemonHello,
	DatabaseAccessDecision,
	DetachBranchRequest,
	DiagnosticsHandoffRequest,
	DurableOperation,
	EditQueuedMessageRequest,
	Inbox,
	JoinMissionRequest,
	McpCheckRequest,
	McpSignInRequest,
	MemoryNoteRequest,
	MemoryRange,
	MergePullRequestRequest,
	MissionArtifactLinkWrite,
	MissionBriefWrite,
	MissionCommentWrite,
	MissionDecisionWrite,
	MissionEventWrite,
	MissionPhaseWrite,
	MissionResourceUpdate,
	MissionResourceWrite,
	MissionTaskWrite,
	NativeDiagnosticsBatch,
	OperationHost,
	ProjectRequest,
	RenameSessionRequest,
	RepositorySelection,
	ReviewRequest,
	RewindRequest,
	SchedulePatch,
	ScheduleRequest,
	SendRequest,
	ServerMessage,
	SessionCommandsResponse,
	SessionHistoryPage,
	SessionJobsResponse,
	SessionSummary,
	SourcePollRequest,
	SourceSignInRequest,
	SpawnRequest,
	StartMissionCoordinatorRequest,
	StartMissionTaskRequest,
	SubagentMessageRequest,
	SubscriptionForceRequest,
	TerminalSocketMessage,
	UnbindPullRequestRequest,
	UpdateMissionRequest,
} from "@pilot/protocol";
import { nodeTelemetry, traceCarrier } from "@pilot/telemetry";
import { type WebSocket, WebSocketServer } from "ws";
import { AttachmentStore } from "./attachment-store.ts";
import { boundedSender } from "./backpressure.ts";
import { RepositoryChanges } from "./changes.ts";
import { ChatStreams } from "./chat-streams.ts";
import type { DaemonConfig } from "./config.ts";
import type { ControlExecutor } from "./control-executor.ts";
import { controlBody, controlHeaders, controlHostRoute, controlJSON } from "./control-host-http.ts";
import { ControlHostError } from "./control-host-policy.ts";
import type { ControlHosts } from "./control-hosts.ts";
import { DatabaseSettingsError } from "./databases.ts";
import { awaitDiagnosticRead, diagnosticContextResponse } from "./diagnostic-context.ts";
import { EnvironmentApprovalRequired } from "./environment-profile.ts";
import { Conflict, ServiceUnavailable } from "./errors.ts";
import { daemonPerformance, operations } from "./event-loop-watchdog.ts";
import type { GitHubImportService } from "./github-import.ts";
import type { GitHubSetupService } from "./github-setup.ts";
import { MachineInformationReader } from "./machine.ts";
import { McpSetupError, McpSetupStore } from "./mcp-setup.ts";
import { type McpStatusService, SignInUnavailable } from "./mcp-status.ts";
import type { MissionService } from "./mission-service.ts";
import type { MissionStore } from "./missions.ts";
import { ModelScopeConflictError, ModelScopeSettingsError, modelScopeUpdate } from "./model-scope.ts";
import type { ModelCatalog } from "./models.ts";
import { MAX_NATIVE_DIAGNOSTIC_BYTES } from "./native-diagnostics.ts";
import { OperationJournal, OperationRejected } from "./operation-journal.ts";
import { isAllowedOrigin } from "./origin.ts";
import type { PowerService } from "./power.ts";
import { type DashboardProviders, ProjectDashboardService } from "./project-dashboard.ts";
import type { ProjectMemoryService } from "./project-memory.ts";
import { EnvironmentRevisionConflict, expandHome, type ProjectStore } from "./projects.ts";
import { PTY_INPUT_CHUNK } from "./pty-input.ts";
import { RepositoryBrowser } from "./repository-browser.ts";
import { ReviewStore } from "./reviews.ts";
import { RuntimeAdmission, RuntimeResources } from "./runtime-admission.ts";
import type { RuntimeMaintenance } from "./runtime-maintenance.ts";
import type { ScheduleService } from "./schedules.ts";
import { NotFound, type SessionManager } from "./sessions.ts";
import { SetupError, type SetupService } from "./setup.ts";
import { parseSlackMessageLink } from "./slack-format.ts";
import type { SourceRegistry } from "./sources.ts";
import type { TelemetrySettingsService } from "./telemetry-settings.ts";
import { terminalSender } from "./terminal-output.ts";
import type { TerminalManager } from "./terminals.ts";
import { validatePatch } from "./tracked-items.ts";

const MAX_BODY = 1024 * 1024;
const HISTORY_PAGE_DEFAULT = 100;
const HISTORY_PAGE_MAX = 500;
const REVIEW_MARKS_MAX = 1000;
/** Dashboards are recomputed at most this often after changes, and only pushed when their content differs. */
const DASHBOARD_DEBOUNCE_MS = 250;

function requestedDiagnosticHost(url: URL, hello: DaemonHello | undefined): OperationHost {
	if (!hello?.lineageId) throw new ServiceUnavailable("Diagnostic host identity is unavailable");
	const hostId = url.searchParams.get("hostId");
	const daemonId = url.searchParams.get("daemonId");
	const lineageId = url.searchParams.get("lineageId");
	if (!hostId || hostId.length > 128 || !daemonId || !lineageId)
		throw new HttpError(400, "hostId, daemonId and lineageId are required");
	if (daemonId !== hello.daemonId || lineageId !== hello.lineageId)
		throw new HttpError(409, "Host identity changed; reconnect before reading diagnostics");
	return { hostId, daemonId, lineageId };
}

/** Telemetry and generated titles are not evidence of a changed working copy. */
function repositoryVersion(session: SessionSummary): string {
	return JSON.stringify([
		session.cwd,
		session.state,
		session.updatedAt,
		session.outcome,
		session.outcomeAt,
		session.branch,
		session.sourceBranch,
		session.sourceCommit,
	]);
}

class HttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/**
 * Mission writes commit without waiting for the disk, which a worker thread syncs. Hold a mutating request's
 * response until they are durable, so no client sees a write acknowledged that a power loss could undo.
 */
export function acknowledgeWhenDurable(res: ServerResponse, store: Pick<MissionStore, "durable">): void {
	const end = res.end.bind(res) as (...args: unknown[]) => ServerResponse;
	res.end = ((...args: unknown[]) => {
		store.durable().then(
			() => end(...args),
			(error: unknown) => {
				console.warn(`pilotd: response withheld, mission store not durable: ${error}`);
				res.destroy(error instanceof Error ? error : new Error(String(error)));
			},
		);
		return res;
	}) as typeof res.end;
}

function json(res: ServerResponse, status: number, body: unknown): void {
	jsonText(res, status, JSON.stringify(body));
}

/** Workspace chats show the branch they recorded, not whatever the checkout currently points at. */
function recordedBranch<T extends { branch?: string }>(value: T, recorded: { name?: string } | undefined): T {
	if (!recorded) return value;
	const { branch: _, ...rest } = value;
	return (recorded.name ? { ...rest, branch: recorded.name } : rest) as T;
}

function jsonText(res: ServerResponse, status: number, body: string): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(body);
}

async function readJson<T>(req: IncomingMessage, maxBytes = MAX_BODY): Promise<T> {
	if (!req.headers["content-type"]?.startsWith("application/json"))
		throw new HttpError(415, "Expected application/json");
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > maxBytes) throw new HttpError(413, "Request body too large");
		chunks.push(chunk as Buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
	} catch {
		throw new HttpError(400, "Invalid JSON");
	}
}

type MissionClientMessage = Extract<ClientMessage, { missionId: string }>;
type FocusClientMessage = Extract<ClientMessage, { type: "focus" }>;
type DashboardClientMessage = Extract<ClientMessage, { projectId: string }>;

function isDashboardClientMessage(value: unknown): value is DashboardClientMessage {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const message = value as Record<string, unknown>;
	return (
		(message.type === "dashboard.subscribe" || message.type === "dashboard.unsubscribe") &&
		typeof message.projectId === "string" &&
		message.projectId.length > 0 &&
		message.projectId.length <= 128
	);
}

function isFocusClientMessage(value: unknown): value is FocusClientMessage {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const message = value as Record<string, unknown>;
	return (
		message.type === "focus" &&
		Array.isArray(message.sessionIds) &&
		message.sessionIds.length <= 50 &&
		message.sessionIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128)
	);
}

function isMissionClientMessage(value: unknown): value is MissionClientMessage {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const message = value as Record<string, unknown>;
	return (
		(message.type === "mission.subscribe" || message.type === "mission.unsubscribe") &&
		typeof message.missionId === "string" &&
		message.missionId.length > 0 &&
		message.missionId.length <= 128
	);
}

/** Final close codes for dedicated sockets. Clients must not reconnect. */
export const SOCKET_NOT_FOUND = 4404;
export const SOCKET_REFUSED = 4409;

export type StreamSocketRoute =
	| { kind: "chat"; sessionId: string }
	| { kind: "terminal"; sessionId: string }
	| { kind: "subagent"; sessionId: string; name: string };

/** Route a dedicated socket path: `/api/sessions/:id/ws`, `…/terminal/ws` or `…/subagents/:name/ws`. */
export function streamSocketRoute(pathname: string): StreamSocketRoute | undefined {
	const raw = pathname.split("/");
	if (raw[0] !== "" || raw[1] !== "api" || raw[2] !== "sessions" || raw.at(-1) !== "ws") return undefined;
	let parts: string[];
	try {
		parts = raw.map((part) => decodeURIComponent(part));
	} catch {
		return undefined;
	}
	const sessionId = parts[3];
	if (!sessionId?.trim() || sessionId.length > 128 || sessionId.includes("/")) return undefined;
	if (parts.length === 5) return { kind: "chat", sessionId };
	if (parts.length === 6 && parts[4] === "terminal") return { kind: "terminal", sessionId };
	const name = parts[5];
	if (parts.length === 7 && parts[4] === "subagents" && name && name.length <= 128)
		return { kind: "subagent", sessionId, name };
	return undefined;
}

function terminalSize(value: string | null): number | undefined {
	const size = value === null ? Number.NaN : Number(value);
	return Number.isInteger(size) && size > 0 && size <= 1000 ? size : undefined;
}

/** Messages a client may send on a terminal socket. Untrusted input. */
function isTerminalSocketMessage(value: unknown): value is TerminalSocketMessage {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const message = value as Record<string, unknown>;
	const id = (value: unknown) => typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value);
	if (message.type === "terminal.open")
		return (
			id(message.bootId) &&
			id(message.requestId) &&
			(message.terminalId === undefined || id(message.terminalId)) &&
			(message.restart === undefined || typeof message.restart === "boolean")
		);
	if (!id(message.terminalId)) return false;
	if (message.type === "terminal.close") return true;
	if (message.type === "terminal.input")
		return typeof message.data === "string" && Buffer.byteLength(message.data) <= PTY_INPUT_CHUNK;
	return (
		message.type === "terminal.resize" &&
		[message.cols, message.rows].every(
			(size) => typeof size === "number" && Number.isInteger(size) && size > 0 && size <= 1000,
		)
	);
}

/** WebSocket close reasons are limited to 123 UTF-8 bytes. */
function closeReason(message: string): string {
	let reason = message.slice(0, 123);
	while (Buffer.byteLength(reason) > 123) reason = reason.slice(0, -1);
	return reason;
}

export function createDaemonServer(
	_config: DaemonConfig,
	sessions: SessionManager,
	projects: ProjectStore,
	models: ModelCatalog,
	terminals: TerminalManager,
	missions?: { service: MissionService; store: MissionStore },
	dashboardProviders?: DashboardProviders,
	memory?: ProjectMemoryService,
	schedules?: ScheduleService,
	tracking?: SourceRegistry,
	power?: PowerService,
	mcp?: McpStatusService,
	hello?: DaemonHello,
	setup?: SetupService,
	sharing?: import("./shared-context.ts").SharedContextService,
	maintenance?: RuntimeMaintenance,
	watches?: import("./watch-service.ts").WatchService,
	telemetry?: TelemetrySettingsService,
	githubSetup?: GitHubSetupService,
	githubImport?: GitHubImportService,
	control?: { hosts: ControlHosts; executor: ControlExecutor },
	environment?: import("./environment.ts").EnvironmentService,
): Server & { runtimeResources: RuntimeResources } {
	sessions.setWorkspaceProcessGuard((id) => terminals.isRunning(id));
	sessions.diagnosticFeatureUsage = telemetry ? (host) => telemetry.featureUsage.snapshot(host) : undefined;
	sessions.diagnosticDomainRead = async (request) => {
		const host = request.host!;
		const limit = request.limit ?? 8,
			offset = request.before ?? 0;
		const response = (data: unknown, count: number, more: boolean) =>
			diagnosticContextResponse(host, data, { scanned: count, more, ...(more ? { before: offset + count } : {}) });
		if (request.action === "refresh_health" && tracking) {
			const snapshot = tracking.refreshHealth({
				projectId: request.projectId,
				kind: request.query as "slack" | "linear" | undefined,
				offset,
				limit,
				channelOffset: request.channelOffset,
			});
			return response(snapshot, snapshot.scanned, snapshot.more);
		}
		if (request.action === "features" && telemetry) {
			const snapshot = telemetry.featureUsage.snapshot(host);
			const cells = snapshot.cells.filter(
				(cell) =>
					(!request.query || cell.feature === request.query) &&
					(!request.since || cell.day >= request.since) &&
					(!request.until || cell.day <= request.until),
			);
			const rows = cells.slice(offset, offset + limit);
			return response(
				{
					...snapshot,
					cells: rows,
					requestedWindow: { since: request.since, until: request.until },
					coverage: "partial_native_ui_observations_only_missing_cells_are_unknown_not_zero",
				},
				rows.length,
				offset + rows.length < cells.length,
			);
		}
		if (request.action === "projects") {
			const list = projects.list();
			const rows = list.slice(offset, offset + limit).map((p) => ({ id: p.id, name: p.name }));
			return response({ projects: rows }, rows.length, offset + rows.length < list.length);
		}
		if (request.action === "missions" && missions) {
			const list = missions.store.list(request.projectId);
			const rows = list.slice(offset, offset + limit);
			return response({ missions: rows }, rows.length, offset + rows.length < list.length);
		}
		if (request.action === "mission" && missions) {
			if (!missions.store.get(request.missionId!))
				return { ...response(null, 0, false), status: "missing", reason: "deleted" };
			const tasks = missions.store.tasks(request.missionId!);
			const rows = tasks.slice(offset, offset + limit);
			return response(
				{
					mission: missions.store.get(request.missionId!),
					brief: missions.store.brief(request.missionId!),
					tasks: rows,
				},
				rows.length,
				offset + rows.length < tasks.length,
			);
		}
		if (request.action === "issues" && tracking) {
			projects.require(request.projectId!);
			const items = await tracking.listItems({ projectId: request.projectId!, limit, offset, dismissed: false });
			return response(
				{ ...items, coverage: "retained_current_integration_binding_only_no_network_fetch" },
				items.items.length,
				items.items.length === limit,
			);
		}
		return { ...response(null, 0, false), status: "unavailable", reason: "unsupported" };
	};
	const machine = new MachineInformationReader(_config.home, hello?.daemonVersion ?? "unknown");
	const reviews = new ReviewStore(_config.home);
	const mcpSetup = new McpSetupStore(_config.agentDir);
	const dashboards = new ProjectDashboardService({
		sessions,
		projects,
		reviews,
		...(missions ? { missions: missions.store } : {}),
		providers: {
			...dashboardProviders,
			...(tracking ? { tracked: (id: string) => tracking.dashboard(id) } : {}),
			...(tracking ? { inbox: (id: string) => tracking.inboxCount(id) } : {}),
			...(memory ? { memory: (id: string) => memory.summary(id) } : {}),
			...(schedules ? { scheduled: (id: string) => schedules.dashboard(id) } : {}),
			onChange(listener) {
				const stops = [
					dashboardProviders?.onChange?.(listener),
					memory?.onChange(listener),
					schedules?.onChange(listener),
					tracking?.onChange(listener),
				];
				return () => {
					for (const stop of stops) stop?.();
				};
			},
		},
	});
	const repositoryChanges = new RepositoryChanges();
	const repositories = new RepositoryBrowser(projects);
	const attachments = new AttachmentStore(_config.home);
	const transfers = new RuntimeAdmission();
	const mutations = new RuntimeAdmission();
	const runtimeResources = new RuntimeResources([
		terminals,
		attachments,
		sessions,
		transfers,
		mutations,
		...(githubSetup ? [githubSetup] : []),
		...(githubImport ? [githubImport] : []),
		...(setup ? [setup] : []),
	]);
	maintenance?.bind(runtimeResources);
	const journal = hello?.lineageId
		? new OperationJournal(join(_config.home, "operations"), {
				hostId: "daemon",
				daemonId: hello.daemonId,
				lineageId: hello.lineageId,
			})
		: undefined;
	const admitOperation = async (op: DurableOperation): Promise<unknown> => {
		const end = mutations.begin({ kind: "operation", id: op.operationId });
		try {
			return await admitOperationHeld(op);
		} finally {
			end();
		}
	};
	const admitOperationHeld = async (op: DurableOperation): Promise<unknown> => {
		if (op.kind.startsWith("control.")) {
			if (!control) throw new OperationRejected("Control executor unavailable");
			return control.executor.handle(op);
		}
		if (op.kind.startsWith("share-")) {
			if (!sharing) throw new OperationRejected("Shared context unavailable");
			return sharing.handle(op);
		}
		let payload: unknown;
		try {
			payload = JSON.parse(op.payload);
		} catch {
			throw new OperationRejected("Invalid payload JSON");
		}
		if (!payload || typeof payload !== "object" || Array.isArray(payload))
			throw new OperationRejected("Expected operation object");
		const attached = op.kind === "chat-create-attached" || op.kind === "chat-send-attached";
		if (attached) {
			const body = payload as AttachmentChatPayload<SpawnRequest | SendRequest>;
			if (!body.request || typeof body.request.message !== "string")
				throw new OperationRejected("Invalid attached message");
			const paths = await attachments.adopt(op, body.attachments);
			const suffix = paths.length
				? "\n\nAttached images (use the read tool to view these files):\n" +
					paths.map((path) => `- \`${path}\``).join("\n")
				: "";
			payload = { ...body.request, message: body.request.message + suffix };
		}
		if (
			op.kind === "chat-create" ||
			op.kind === "chat-create-attached" ||
			op.kind === "diagnostics-create" ||
			op.kind === "repair-create"
		) {
			const request = payload as SpawnRequest;
			if (typeof request.message !== "string" || !request.message.trim())
				throw new OperationRejected("message is required");
			if (op.kind === "diagnostics-create" && request.role !== "diagnostics")
				throw new OperationRejected("diagnostics-create requires a diagnostics specialist");
			if (
				op.kind === "repair-create" &&
				(request.role !== undefined || request.mode !== "build" || request.diagnosticRepair === undefined)
			)
				throw new OperationRejected("repair-create requires an ordinary Build chat");
			if (op.kind !== "repair-create" && request.diagnosticRepair !== undefined)
				throw new OperationRejected("diagnostic repair authority requires repair-create");
			const session = await sessions.spawnDurable(request, op.targetId, op.operationId);
			return { sessionId: session.id };
		}
		if (op.kind === "chat-send" || op.kind === "chat-send-attached") {
			const request = payload as SendRequest;
			if (
				typeof request.message !== "string" ||
				!request.message.trim() ||
				(request.mode !== undefined && request.mode !== "steer" && request.mode !== "followUp")
			)
				throw new OperationRejected("Invalid message");
			await sessions.sendDurable(op.targetId, request.message, request.mode ?? "followUp", op.operationId);
			return { sessionId: op.targetId };
		}
		throw new OperationRejected("Unsupported operation kind");
	};
	// Only registered idempotent handlers resume. An interrupted handler always retains the same target.
	const recoverOperations = () => {
		if (journal && !maintenance?.frozen)
			void journal.recover(admitOperation).catch((error) => console.warn("pilotd: operation recovery", error));
	};
	recoverOperations();
	const stopRecoveryWatch = maintenance?.onOpen(recoverOperations);
	const route = async (req: IncomingMessage, res: ServerResponse) => {
		if (!isAllowedOrigin(req.headers.origin)) throw new HttpError(403, "Browser requests are not allowed");
		const url = new URL(req.url ?? "/", "http://localhost");
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts[0] !== "api") throw new HttpError(404, "Not found");
		if (control && (await controlHostRoute(control.hosts, req, res))) return;
		if (parts[1] === "github-import") {
			res.setHeader("cache-control", "no-store");
			if (!githubSetup || !githubImport) throw new SetupError(503, "GitHub import is unavailable on this host.");
			await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
			if (parts.length === 3 && parts[2] === "preview" && req.method === "POST") {
				const body = await readJson<{ url: string; destination?: string }>(req);
				return json(res, 200, await githubImport.preview(body.url, body.destination));
			}
			if (parts.length === 3 && parts[2] === "repositories" && req.method === "GET")
				return json(res, 200, await githubImport.repositories(url.searchParams.get("q") ?? ""));
			if (parts.length === 2 && req.method === "GET") return json(res, 200, await githubImport.list());
			if (parts.length === 2 && req.method === "POST")
				return json(res, 201, await githubImport.start(await readJson(req)));
			if (parts.length === 4 && req.method === "POST")
				return json(res, 200, await githubImport.action(parts[2]!, parts[3]!));
			throw new SetupError(404, "Unknown GitHub import operation.");
		}
		if (parts[1] === "runtime-update" && maintenance) {
			res.setHeader("cache-control", "no-store");
			if (parts.length === 2 && req.method === "GET")
				return json(res, 200, await maintenance.status(url.searchParams.get("id") ?? undefined));
			if (parts.length === 3 && parts[2] === "cancel" && req.method === "POST") {
				const body = await readJson<{ id: string }>(req);
				return json(res, 202, await maintenance.cancel(body.id));
			}
			if (parts.length === 3 && req.method === "POST" && ["drain", "commit"].includes(parts[2]!)) {
				const body = await readJson<{ id: string }>(req);
				return json(res, 200, await maintenance.inspect(body.id, parts[2] === "commit"));
			}
			throw new HttpError(404, "Unknown update action");
		}
		if (parts[1] === "shared-contexts") {
			if (!sharing) throw new ServiceUnavailable("Shared context unavailable");
			if (parts.length === 2 && req.method === "GET") return json(res, 200, await sharing.summaries());
			if (
				req.method === "GET" &&
				((parts.length === 5 && parts[3] === "memory") ||
					((parts.length === 5 || parts.length === 6) && parts[3] === "missions"))
			) {
				const allowed =
					parts[3] === "memory"
						? parts[4] === "tree"
							? ["lo", "hi", "depth", "reveal"]
							: parts[4] === "recall"
								? ["regex", "lines"]
								: parts[4] === "wake"
									? ["lines"]
									: parts[4] === "zoom"
										? ["lo", "hi"]
										: []
						: parts.length === 6 && parts[5] === "versions"
							? ["after", "limit", "sequence"]
							: [];
				for (const name of url.searchParams.keys())
					if (!allowed.includes(name) || url.searchParams.getAll(name).length !== 1)
						throw new HttpError(400, "Unknown or duplicate shared read parameter");
				const args: Record<string, unknown> = {};
				for (const [name, value] of url.searchParams) {
					if (name === "regex") args[name] = value;
					else if (name === "reveal") {
						if (value !== "" && !/^\d+(,\d+)*$/.test(value)) throw new HttpError(400, "Invalid reveal indices");
						args[name] = value === "" ? [] : value.split(",").map(Number);
					} else {
						if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
							throw new HttpError(400, "Invalid shared read number");
						args[name] = Number(value);
					}
				}
				if (parts[3] === "memory") {
					if (parts[4] === "tree") return json(res, 200, await sharing.readMemoryTree(parts[2]!, args));
					if (parts[4] === "wake" || parts[4] === "recall" || parts[4] === "zoom")
						return json(res, 200, await sharing.readMemory(parts[2]!, parts[4], args));
				} else {
					if (parts.length === 5) return json(res, 200, await sharing.readMission(parts[2]!, parts[4]!));
					if (parts[5] === "versions")
						return json(res, 200, await sharing.readMissionVersions(parts[2]!, parts[4]!, args));
				}
				throw new HttpError(404, "Unknown shared read operation");
			}
			if (parts.length === 4 && parts[3] === "conflicts" && req.method === "GET")
				return json(res, 200, sharing.conflicts(parts[2]!));
			if (parts.length === 5 && parts[3] === "events" && req.method === "GET")
				return json(res, 200, sharing.audit(parts[2]!, parts[4]!, Number(url.searchParams.get("after") ?? 0)));
			if (parts.length === 6 && parts[3] === "proposals" && parts[5] === "resolve" && req.method === "POST")
				return json(res, 200, await sharing.resolveProposal(parts[2]!, parts[4]!, await readJson(req)));
			if (parts.length === 2 && req.method === "POST") {
				await sharing.enroll(await readJson(req));
				return json(res, 201, { ok: true });
			}
			if (parts.length === 4 && parts[3] === "exchange" && req.method === "POST") {
				const body = await readJson<{ peer: import("@pilot/protocol").OperationHost }>(req);
				return json(res, 200, await sharing.exchange(parts[2]!, body.peer));
			}
			if (parts.length === 4 && parts[3] === "ack" && req.method === "POST") {
				await sharing.acknowledge(parts[2]!, await readJson(req));
				return json(res, 200, { ok: true });
			}
			throw new HttpError(404, "Unknown shared context operation");
		}
		if (
			parts[1] === "missions" &&
			parts[3] === "tasks" &&
			parts[5] === "delegations" &&
			parts.length === 6 &&
			req.method === "POST"
		) {
			if (!sharing) throw new ServiceUnavailable("Delegation unavailable");
			return json(res, 201, await sharing.reserve(parts[2]!, parts[4]!, await readJson(req)));
		}
		if (parts[1] === "delegations" && parts.length === 4 && req.method === "POST") {
			if (!sharing) throw new ServiceUnavailable("Delegation unavailable");
			if (parts[3] === "cancel") {
				const grant = sharing.cancel(parts[2]!);
				await missions?.store.durable();
				return json(res, 200, grant);
			}
			if (parts[3] === "seal") {
				const body =
					req.headers["content-length"] === undefined || req.headers["content-length"] === "0"
						? {}
						: await readJson<{ bindingId?: string }>(req);
				return json(res, 200, await sharing.seal(parts[2]!, body.bindingId));
			}
		}
		if (parts[0] !== "api") throw new HttpError(404, "Not found");
		if (parts[1] === "setup") {
			res.setHeader("cache-control", "no-store");
			if (parts[2] === "github" && parts.length === 3) {
				if (!githubSetup) throw new SetupError(503, "GitHub setup requires a paired host identity.");
				await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
				if (req.method === "GET") return json(res, 200, await githubSetup.status());
				if (req.method === "POST") return json(res, 200, await githubSetup.act(await readJson(req)));
				throw new SetupError(404, "Unknown GitHub setup operation.");
			}
			if (!setup) throw new HttpError(503, "Host setup is unavailable.");
			if (parts.length === 2 && req.method === "GET") return json(res, 200, await setup.readiness());
			if (parts[2] === "runs") {
				if (parts.length === 3 && req.method === "GET") return json(res, 200, setup.list());
				if (parts.length === 3 && req.method === "POST") return json(res, 201, setup.start(await readJson(req)));
				if (parts.length === 4 && req.method === "GET") return json(res, 200, setup.get(parts[3]!));
				if (parts.length === 4 && req.method === "DELETE") return json(res, 200, await setup.cancel(parts[3]!));
			}
			if (parts.length === 5 && parts[2] === "providers" && parts[4] === "credential" && req.method === "DELETE")
				return json(res, 200, await setup.logout(decodeURIComponent(parts[3]!)));
			if (
				parts.length === 5 &&
				parts[2] === "integrations" &&
				parts[4] === "sign-in" &&
				req.method === "POST" &&
				["linear", "slack"].includes(parts[3]!)
			)
				throw new HttpError(
					409,
					"This integration's browser callback cannot be relayed between hosts. Configure and sign in independently on this host.",
				);
			throw new HttpError(404, "Unknown setup operation.");
		}
		if (parts[1] === "attachments" && parts.length === 3) {
			if (req.method === "PUT") {
				const header = req.headers["x-pilot-attachment"];
				if (typeof header !== "string" || header.length > 2048)
					throw new HttpError(400, "Missing attachment metadata");
				const metadata = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as AttachmentUpload;
				if (metadata.uploadId !== parts[2] || Number(req.headers["content-length"]) !== metadata.bytes)
					throw new HttpError(400, "Attachment resource/length mismatch");
				const result = await attachments.stage(metadata, req);
				req.resume();
				return json(res, 201, result);
			}
			if (req.method === "DELETE") {
				await attachments.discard(parts[2]!);
				return json(res, 200, { ok: true });
			}
		}
		if (parts[1] === "repositories" && parts.length === 3) {
			if (parts[2] === "directories" && req.method === "GET") {
				return json(
					res,
					200,
					await repositories.directory(
						{
							rootId: url.searchParams.get("rootId") ?? "home",
							path: url.searchParams.get("path") ?? "",
						},
						Number(url.searchParams.get("offset") ?? "0"),
					),
				);
			}
			if (parts[2] === "projects" && req.method === "POST") {
				const body = await readJson<{ selection: RepositorySelection; name?: string }>(req);
				const path = await repositories.selection(body.selection);
				return json(res, 201, await projects.create({ path, name: body.name }));
			}
		}
		if (parts[1] === "sessions" && parts.length === 4 && parts[3] === "files" && req.method === "GET") {
			const session = sessions.get(parts[2]!);
			if (!session) throw new NotFound("Unknown session");
			return json(res, 200, await repositories.file(session.cwd, url.searchParams.get("path") ?? ""));
		}
		if (parts[1] === "operations" && req.method === "POST" && parts.length <= 3) {
			if (!journal) throw new ServiceUnavailable("Durable operation domain unavailable");
			if (parts[2] === "release-attachments") {
				const body = await readJson<{
					operation: DurableOperation;
					attachments: import("@pilot/protocol").StagedAttachmentRef[];
				}>(req);
				const receipt = await journal.lookup(body.operation);
				if (receipt?.state !== "rejected") throw new Conflict("Only rejected receipts can release attachments");
				await attachments.releaseRejected(body.operation, body.attachments);
				return json(res, 200, { ok: true });
			}
			const bytes = await controlBody(req, MAX_BODY);
			const operation = controlJSON<DurableOperation>(bytes);
			if (operation?.kind === "repair-create" && parts[2] !== "receipt") {
				if (!githubSetup) throw new ServiceUnavailable("Native repair confirmation is unavailable");
				await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
			}
			if (operation?.kind?.startsWith("control.")) {
				try {
					if (!control) throw new ControlHostError("capability_denied", "Control executor unavailable", 403);
					await control.hosts.authenticate(controlHeaders(req), req.method!, req.url!, bytes, {
						bindingId: operation.bindingId!,
						kind: parts[2] === "receipt" ? "receipts" : "exchange",
					});
				} catch (error) {
					if (error instanceof ControlHostError) return json(res, error.status, error.response());
					throw error;
				}
			}
			if (parts.length === 3 && parts[2] !== "receipt") throw new HttpError(404, "Not found");
			const receipt =
				parts[2] === "receipt" ? await journal.lookup(operation) : await journal.execute(operation, admitOperation);
			res.setHeader("cache-control", "no-store");
			return json(res, 200, receipt ?? { state: "unknown" });
		}
		if (parts[1] === "hello" && parts.length === 2) {
			if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
			if (!hello) throw new ServiceUnavailable("Daemon handshake is unavailable");
			res.setHeader("cache-control", "no-store");
			return json(res, 200, hello);
		}
		if (parts[1] === "machine" && parts.length === 2) {
			if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
			res.setHeader("cache-control", "no-store");
			return json(res, 200, await machine.read());
		}
		if (parts[1] === "power" && parts.length === 2) {
			if (!power) throw new ServiceUnavailable("Energy management is unavailable");
			if (req.method === "GET") return json(res, 200, power.status());
			if (req.method === "PATCH") return json(res, 200, await power.configure(await readJson(req)));
			throw new HttpError(405, "Method not allowed");
		}
		if (parts[1] === "mcp" && parts[2] === "setup" && parts.length === 3) {
			res.setHeader("cache-control", "no-store");
			if (!githubSetup) return json(res, 503, { error: "mcp_setup_unavailable" });
			try {
				await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
			} catch {
				return json(res, 403, { error: "native_action_required" });
			}
			if (req.method === "PUT" && _config.mcpSetupReadOnly) return json(res, 403, { error: "mcp_setup_read_only" });
			let input: unknown;
			if (req.method === "PUT") {
				try {
					input = await readJson(req, 160 * 1024);
				} catch {
					return json(res, 400, { error: "invalid_mcp_setup" });
				}
			}
			try {
				if (req.method === "GET") return json(res, 200, await mcpSetup.read());
				if (req.method === "PUT") {
					const result = await mcpSetup.apply(input);
					mcp?.check();
					return json(res, 200, result);
				}
			} catch (error) {
				if (error instanceof McpSetupError) return json(res, error.status, { error: error.code });
				return json(res, 503, { error: "mcp_setup_unavailable" });
			}
			return json(res, 405, { error: "mcp_setup_method" });
		}
		if (parts[1] === "mcp") {
			if (!mcp) throw new ServiceUnavailable("MCP status is unavailable");
			if (parts.length === 2 && req.method === "GET") return json(res, 200, mcp.status());
			if (parts.length === 3 && parts[2] === "check" && req.method === "POST") {
				const body = await readJson<McpCheckRequest | null>(req);
				if (body !== null && (typeof body !== "object" || Array.isArray(body)))
					throw new HttpError(400, "Expected an object");
				if (body?.server !== undefined && typeof body.server !== "string")
					throw new HttpError(400, "server must be a string");
				return json(res, 200, mcp.check(body?.server));
			}
			// Browser sign-in through pi's MCP OAuth flow. Progress arrives with the status.
			if (parts.length === 5 && parts[2] === "servers" && parts[4] === "sign-in") {
				const name = decodeURIComponent(parts[3]!);
				try {
					if (req.method === "POST") {
						const body = await readJson<McpSignInRequest | null>(req);
						if (body !== null && (typeof body !== "object" || Array.isArray(body)))
							throw new HttpError(400, "Expected an object");
						if (body?.again !== undefined && typeof body.again !== "boolean")
							throw new HttpError(400, "again must be a boolean");
						return json(res, 200, mcp.signIn(name, body?.again === true));
					}
					if (req.method === "DELETE") {
						let expectedStartedAt: number | undefined;
						if (req.headers["content-type"]?.startsWith("application/json")) {
							const body = await readJson<{ expectedStartedAt?: unknown }>(req);
							if (
								!body ||
								typeof body.expectedStartedAt !== "number" ||
								!Number.isFinite(body.expectedStartedAt)
							)
								throw new HttpError(400, "Invalid sign-in cancellation");
							expectedStartedAt = body.expectedStartedAt;
						}
						return json(res, 200, mcp.cancelSignIn(name, expectedStartedAt) ?? null);
					}
				} catch (error) {
					if (error instanceof SignInUnavailable) throw new HttpError(409, error.message);
					throw error;
				}
			}
			throw new HttpError(404, "Unknown MCP operation");
		}
		if (parts[1] === "schedules" && parts.length <= 3) {
			if (!schedules) throw new ServiceUnavailable("Scheduling is unavailable");
			const id = parts[2];
			if (!id && req.method === "GET")
				return jsonText(res, 200, await schedules.snapshot(url.searchParams.get("projectId") ?? undefined));
			if (!id && req.method === "POST")
				return json(res, 201, await schedules.create(await readJson<ScheduleRequest>(req)));
			if (id && req.method === "GET") return json(res, 200, schedules.require(id));
			if (id && req.method === "PATCH")
				return json(res, 200, await schedules.update(id, await readJson<SchedulePatch>(req)));
			if (id && req.method === "DELETE") {
				await schedules.remove(id);
				return json(res, 200, { ok: true });
			}
			throw new HttpError(404, "Unknown schedule operation");
		}
		if (parts[1] === "sources" || parts[1] === "tracked-items" || parts[1] === "tracking") {
			if (!tracking) throw new ServiceUnavailable("Tracking is unavailable");
			if (parts[1] === "tracking") {
				if (parts.length === 4 && parts[2] === "slack" && parts[3] === "search" && req.method === "GET") {
					const projectId = url.searchParams.get("projectId") ?? undefined;
					if (projectId) projects.require(projectId);
					const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 20;
					if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new HttpError(400, "limit must be 1..50");
					return json(res, 200, await tracking.searchSlack(url.searchParams.get("query") ?? "", projectId, limit));
				}
				if (parts.length === 4 && parts[2] === "slack" && parts[3] === "messages" && req.method === "POST") {
					const body = await readJson<import("@pilot/protocol").SlackMessageAddRequest | null>(req);
					if (
						!body ||
						typeof body !== "object" ||
						typeof body.projectId !== "string" ||
						typeof body.url !== "string"
					)
						throw new HttpError(400, "projectId and url are required");
					projects.require(body.projectId);
					if (!parseSlackMessageLink(body.url)) throw new HttpError(400, "Paste a link to a Slack message");
					return json(res, 200, await tracking.addSlackMessage(body.projectId, body.url));
				}
				if (parts[2] === "slack" && parts[3] === "cases") {
					const projectId = url.searchParams.get("projectId") ?? "";
					projects.require(projectId);
					if (parts.length === 4 && req.method === "GET")
						return json(res, 200, await tracking.commonCases(projectId));
					if (parts.length === 5 && req.method === "PATCH") {
						await tracking.items.editCase(
							projectId,
							decodeURIComponent(parts[4]!),
							await readJson<import("@pilot/protocol").SlackCaseEdit>(req),
						);
						return json(res, 200, await tracking.commonCases(projectId));
					}
				}
				if (parts.length === 4 && (parts[2] === "slack" || parts[2] === "linear") && parts[3] === "guide") {
					const projectId = url.searchParams.get("projectId") ?? "";
					projects.require(projectId);
					if (req.method === "GET")
						return json(res, 200, (await tracking.items.triageInput(projectId, parts[2])).guide);
					if (req.method === "POST" && tracking.triage)
						return json(res, 202, await tracking.triage.rebuild(projectId, parts[2]));
				}
				if (
					parts.length === 4 &&
					(parts[2] === "slack" || parts[2] === "linear") &&
					parts[3] === "corrections" &&
					req.method === "GET"
				) {
					const projectId = url.searchParams.get("projectId");
					if (!projectId) throw new HttpError(400, "projectId is required");
					projects.require(projectId);
					const corrections =
						parts[2] === "linear"
							? await tracking.items.linearSizeCorrections(projectId)
							: await tracking.items.corrections(projectId);
					return json(res, 200, corrections);
				}
				// Read-only pickers for project settings. Nothing is stored until the project is saved.
				const query = url.searchParams.get("query")?.trim().slice(0, 100) || undefined;
				if (parts.length === 4 && parts[2] === "linear" && parts[3] === "states" && req.method === "GET") {
					const team = url.searchParams.get("team")?.trim();
					if (!team || team.length > 200) throw new HttpError(400, "team is required (at most 200 characters)");
					return json(res, 200, await tracking.linearStates(team));
				}
				if (parts.length === 4 && parts[2] === "linear" && parts[3] === "teams" && req.method === "GET")
					return json(res, 200, await tracking.linearTeams(query));
				if (parts.length === 4 && parts[2] === "slack" && parts[3] === "channels" && req.method === "GET")
					return json(res, 200, await tracking.slackChannelOptions(query));
				// Browser sign-in through pi's MCP OAuth flow. Progress arrives with the sources list.
				if (parts.length === 4 && (parts[2] === "linear" || parts[2] === "slack") && parts[3] === "sign-in") {
					if (req.method === "POST") {
						const body = await readJson<SourceSignInRequest | null>(req);
						if (body !== null && (typeof body !== "object" || Array.isArray(body)))
							throw new HttpError(400, "Expected an object");
						if (body?.again !== undefined && typeof body.again !== "boolean")
							throw new HttpError(400, "again must be a boolean");
						return json(res, 200, tracking.signIn(parts[2], body?.again === true));
					}
					if (req.method === "DELETE") return json(res, 200, tracking.cancelSignIn(parts[2]));
				}
			} else if (parts[1] === "sources") {
				if (parts.length === 2 && req.method === "GET")
					return json(res, 200, tracking.list(url.searchParams.get("projectId") ?? undefined));
				if (parts.length === 4 && parts[3] === "poll" && req.method === "POST") {
					const hasBody =
						req.headers["transfer-encoding"] !== undefined || Number(req.headers["content-length"] ?? 0) > 0;
					const body = hasBody ? await readJson<SourcePollRequest | null>(req) : null;
					if (body !== null && (typeof body !== "object" || Array.isArray(body)))
						throw new HttpError(400, "Expected an object");
					if (body?.force !== undefined && typeof body.force !== "boolean")
						throw new HttpError(400, "force must be a boolean");
					return json(res, 200, await tracking.poll(decodeURIComponent(parts[2]!), body?.force === true));
				}
			} else {
				if (parts.length === 2 && req.method === "GET") {
					const projectId = url.searchParams.get("projectId");
					if (!projectId) throw new HttpError(400, "projectId is required");
					projects.require(projectId);
					const kind = url.searchParams.get("kind") ?? undefined;
					if (kind !== undefined && kind !== "linear" && kind !== "slack")
						throw new HttpError(400, "Unknown tracking kind");
					const dismissed = url.searchParams.get("dismissed");
					if (dismissed !== null && dismissed !== "true" && dismissed !== "false")
						throw new HttpError(400, "Invalid dismissed filter");
					const closedByLabel = url.searchParams.get("closedByLabel");
					if (closedByLabel !== null && closedByLabel !== "true" && closedByLabel !== "false")
						throw new HttpError(400, "Invalid closedByLabel filter");
					// A chat's own Slack messages, for its header: the ones whose latest chat it is, dismissed or not.
					const sessionId = url.searchParams.get("sessionId") ?? undefined;
					if (sessionId !== undefined && (!sessionId || sessionId.length > 200))
						throw new HttpError(400, "Invalid sessionId filter");
					return json(
						res,
						200,
						await tracking.listItems({
							projectId,
							kind,
							caseId: url.searchParams.get("caseId") ?? undefined,
							dismissed: dismissed === "true",
							...(closedByLabel === "true" ? { closedByLabel: true } : {}),
							...(sessionId ? { sessionId } : {}),
							limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 100,
							offset: url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0,
						}),
					);
				}
				if (parts.length === 4 && parts[3] === "prefill" && req.method === "GET")
					return json(res, 200, await tracking.prefill(decodeURIComponent(parts[2]!)));
				if (parts.length === 4 && parts[3] === "excerpt" && req.method === "GET")
					return json(res, 200, await tracking.slackExcerpt(decodeURIComponent(parts[2]!)));
				if (parts.length === 3 && req.method === "GET") {
					const item = await tracking.items.require(decodeURIComponent(parts[2]!));
					projects.require(item.projectId);
					return json(res, 200, item);
				}
				if (parts.length === 3 && req.method === "PATCH") {
					const item = await tracking.items.require(parts[2]!);
					projects.require(item.projectId);
					const patch: unknown = await readJson(req);
					validatePatch(patch);
					if (
						patch.slack?.label &&
						!projects
							.require(item.projectId)
							.tracking?.slackLabels?.some((label) => label.name === patch.slack!.label)
					)
						throw new HttpError(400, "Unknown project Slack label");
					if (patch.sessionId && sessions.get(patch.sessionId)?.projectId !== item.projectId)
						throw new HttpError(400, "Chat must belong to this project");
					if (patch.missionId && missions?.store.get(patch.missionId)?.projectId !== item.projectId)
						throw new HttpError(400, "Mission must belong to this project");
					return json(res, 200, await tracking.patch(item.id, patch));
				}
			}
			throw new HttpError(404, "Unknown tracking operation");
		}
		if (missions && (await missionRoute(missions, parts, url, req, res))) return;
		if (parts[1] === "projects" && parts[3] === "databases" && parts.length === 4) {
			res.setHeader("cache-control", "no-store");
			projects.require(parts[2]!);
			if (!githubSetup) return json(res, 503, { error: "Native host actions are unavailable." });
			try {
				await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
			} catch {
				return json(res, 403, { error: "Database settings require a native app action." });
			}
			try {
				if (req.method === "GET") return json(res, 200, await sessions.projectDatabases(parts[2]!));
				if (req.method === "PUT")
					return json(res, 200, await sessions.updateProjectDatabases(parts[2]!, await readJson(req, 96 * 1024)));
			} catch (error) {
				if (error instanceof DatabaseSettingsError) return json(res, error.status, { error: error.message });
				throw error;
			}
			throw new HttpError(405, "Method not allowed");
		}
		if (parts[1] === "projects" && parts[3] === "memory" && parts.length <= 5) {
			const id = parts[2]!;
			projects.require(id);
			if (!memory) throw new ServiceUnavailable("Project memory is unavailable");
			const action = parts[4];
			const lines = url.searchParams.has("lines") ? Number(url.searchParams.get("lines")) : 96;
			if (!action && req.method === "GET") return json(res, 200, await memory.load(id));
			if (action === "note" && req.method === "POST") {
				const body = await readJson<MemoryNoteRequest>(req);
				const session = typeof body?.sessionId === "string" ? sessions.get(body.sessionId) : undefined;
				if (!session || session.projectId !== id)
					throw new HttpError(400, "Origin chat must belong to this project");
				return json(res, 201, await memory.note(id, body.text, body.sessionId, body.replaces));
			}
			if (action === "wake" && req.method === "GET") return json(res, 200, await memory.wake(id, lines));
			if (action === "recall" && req.method === "GET")
				return json(res, 200, await memory.recall(id, url.searchParams.get("regex") ?? "", lines));
			if (action === "zoom" && req.method === "GET")
				return json(
					res,
					200,
					await memory.zoom(
						id,
						Number(url.searchParams.get("lo") ?? NaN),
						Number(url.searchParams.get("hi") ?? NaN),
					),
				);
			if (action === "tree" && req.method === "GET") {
				const number = (name: string) =>
					url.searchParams.has(name) ? Number(url.searchParams.get(name)) : undefined;
				const reveal = url.searchParams.get("reveal");
				return json(
					res,
					200,
					await memory.tree(id, {
						lo: number("lo"),
						hi: number("hi"),
						depth: number("depth"),
						reveal: reveal ? reveal.split(",").map(Number) : [],
					}),
				);
			}
			if (action === "forget" && req.method === "POST") {
				const body = await readJson<MemoryRange>(req);
				return json(res, 200, await memory.forget(id, body?.lo, body?.hi));
			}
			throw new HttpError(404, "Unknown memory operation");
		}
		if (parts[1] === "update" && parts[2] === "pause" && parts.length === 3 && req.method === "POST")
			return json(res, 200, sessions.pauseForUpdate());
		if (
			parts[1] === "diagnostics" &&
			parts[2] === "repair-project" &&
			parts.length === 3 &&
			(req.method === "GET" || req.method === "PUT")
		) {
			if (!githubSetup) throw new ServiceUnavailable("Native repair project setup is unavailable");
			await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
			res.setHeader("cache-control", "no-store");
			return json(
				res,
				200,
				req.method === "GET"
					? await sessions.diagnosticRepairProjectStatus()
					: await sessions.configureDiagnosticRepairProject(
							await readJson<import("@pilot/protocol").DiagnosticRepairProjectSetup>(req, 8192),
						),
			);
		}
		if (parts[1] === "diagnostics" && parts[2] === "app" && parts.length === 3 && req.method === "GET") {
			res.setHeader("cache-control", "no-store");
			return json(res, 200, sessions.appDiagnosticEvidence(requestedDiagnosticHost(url, hello)));
		}
		if (
			parts[1] === "diagnostics" &&
			(parts[2] === "read" || parts[2] === "read-response") &&
			parts.length === 3 &&
			req.method === "POST"
		) {
			if (!githubSetup) throw new ServiceUnavailable("Protected native diagnostic reads are unavailable");
			await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
			if (parts[2] === "read") {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), 10_000);
				try {
					return json(
						res,
						200,
						await awaitDiagnosticRead(
							sessions.readDiagnosticContext(await readJson(req, 8192), controller.signal),
							controller.signal,
						),
					);
				} finally {
					clearTimeout(timer);
				}
			}
			const response = await readJson<{ id: string; result: unknown }>(req, 65536);
			if (!response || typeof response.id !== "string") throw new HttpError(400, "Invalid diagnostic response");
			sessions.diagnosticReadBroker.respond(response.id, response.result);
			return json(res, 200, { accepted: true });
		}
		if (parts[1] === "diagnostics" && parts[2] === "feature-usage" && parts.length === 3 && req.method === "PUT") {
			if (!telemetry || !githubSetup) throw new ServiceUnavailable("Native feature collection is unavailable");
			await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
			await telemetry.featureUsage.replace(await readJson(req, 96 * 1024));
			return json(res, 200, { accepted: true });
		}
		if (parts[1] === "diagnostics" && parts[2] === "performance" && parts.length === 3 && req.method === "GET") {
			const performance = daemonPerformance();
			if (!performance) throw new ServiceUnavailable("Performance diagnostics are not running");
			return json(res, 200, performance);
		}
		if (parts[1] === "telemetry" && parts.length === 2) {
			if (!telemetry) throw new ServiceUnavailable("Telemetry settings are unavailable");
			if (req.method === "GET") return json(res, 200, telemetry.settings());
			if (req.method === "PUT") {
				try {
					return json(res, 200, await telemetry.update(await readJson(req)));
				} catch {
					throw new HttpError(400, "Invalid telemetry settings");
				}
			}
		}
		if (parts[1] === "diagnostics" && parts[2] === "native" && parts.length === 3 && req.method === "PUT") {
			await sessions.replaceNativeDiagnostics(
				await readJson<NativeDiagnosticsBatch>(req, MAX_NATIVE_DIAGNOSTIC_BYTES),
			);
			return json(res, 200, { accepted: true });
		}
		if (parts[1] === "diagnostics" && parts.length === 2 && req.method === "DELETE") {
			await sessions.clearDiagnostics();
			await telemetry?.featureUsage.clear();
			tracking?.refreshDiagnostics?.clear();
			return json(res, 200, { cleared: true });
		}
		if (parts[1] === "update" && parts[2] === "prepare" && parts.length === 3 && req.method === "POST")
			return json(res, 200, sessions.prepareUpdate());
		if (parts[1] === "artifacts" && parts.length === 3 && req.method === "GET")
			return json(res, 200, await sessions.resolveArtifact(parts[2]!));
		if (parts[1] === "artifact-libraries" && parts.length === 3 && req.method === "GET") {
			const name = parts[2]!;
			if (!isArtifactLibrary(name)) throw new HttpError(404, "Unknown artifact library");
			const { source, etag } = await getLibraryAsset(name as ArtifactLibrary);
			// Clients keep the bundle and revalidate it cheaply; a daemon upgrade changes the validator.
			const headers = { etag, "cache-control": "no-cache", "x-content-type-options": "nosniff" };
			if (req.headers["if-none-match"] === etag) {
				res.writeHead(304, headers);
				return res.end();
			}
			res.writeHead(200, { ...headers, "content-type": "text/javascript" });
			return res.end(source);
		}
		if (parts[1] === "model-scope" && parts.length === 2) {
			res.setHeader("cache-control", "no-store");
			const projectId = url.searchParams.get("projectId");
			const cwd = projectId
				? projects.require(projectId).path
				: url.searchParams.has("cwd")
					? expandHome(url.searchParams.get("cwd")!)
					: undefined;
			if (req.method === "GET") {
				try {
					return json(res, 200, await models.scope(cwd));
				} catch (error) {
					if (error instanceof ModelScopeSettingsError)
						return json(res, error.status, { error: "settings_unreadable" });
					return json(res, 503, { error: "model_scope_unavailable" });
				}
			}
			if (req.method === "PUT") {
				if (_config.modelScopeReadOnly) return json(res, 403, { error: "read_only" });
				// Reuse the native host-action boundary, not a chat grant or an agent-supplied identity.
				// The capability's historical filename/header is shared with GitHub setup/import.
				if (!githubSetup) return json(res, 503, { error: "model_scope_unavailable" });
				try {
					await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
				} catch {
					return json(res, 403, { error: "native_action_required" });
				}
				const input = await readJson(req, 160 * 1024);
				try {
					modelScopeUpdate(input);
				} catch {
					return json(res, 400, { error: "invalid_scope" });
				}
				try {
					return json(res, 200, await models.updateScope(cwd, input));
				} catch (error) {
					if (error instanceof ModelScopeConflictError) return json(res, 409, error.conflict);
					if (error instanceof ModelScopeSettingsError)
						return json(res, error.status, { error: "settings_unreadable" });
					// No raw SDK/provider/configuration errors may escape this settings-only API.
					return json(res, 503, { error: "model_scope_unavailable" });
				}
			}
		}
		if (parts[1] === "models" && parts.length === 2 && req.method === "GET") {
			const projectId = url.searchParams.get("projectId");
			const cwd = projectId ? projects.require(projectId).path : expandHome(url.searchParams.get("cwd") || "~");
			return json(
				res,
				200,
				await (url.searchParams.get("purpose") === "task-start" ? models.listTaskModels(cwd) : models.list(cwd)),
			);
		}
		if (parts[1] === "projects" && parts.length === 2) {
			if (req.method === "GET") return json(res, 200, projects.list());
			if (req.method === "POST") return json(res, 201, await projects.create(await readJson<ProjectRequest>(req)));
		}
		if (parts[1] === "projects" && parts.length === 3) {
			const id = parts[2]!;
			if (req.method === "GET") return json(res, 200, projects.require(id));
			if (req.method === "PATCH")
				return json(res, 200, await projects.update(id, await readJson<Partial<ProjectRequest>>(req)));
			if (req.method === "DELETE") {
				await projects.remove(id);
				return json(res, 200, { ok: true });
			}
		}
		if (parts[1] === "projects" && parts.length === 4 && parts[3] === "artifacts" && req.method === "GET")
			return json(res, 200, await sessions.projectArtifacts(parts[2]!));
		if (parts[1] === "projects" && parts.length === 4 && parts[3] === "github" && req.method === "GET")
			return json(res, 200, await projects.github(parts[2]!));
		if (parts[1] === "projects" && parts.length === 4 && parts[3] === "origin" && req.method === "GET")
			return json(res, 200, await projects.origin(parts[2]!));
		if (parts[1] === "projects" && parts[3] === "environment") {
			// Off unless this host advertises DaemonCapabilities.environmentSetup.
			if (!environment) return json(res, 404, { error: "environment_unavailable" });
			if (parts.length === 5 && parts[4] === "discovery" && req.method === "GET")
				return json(res, 200, await environment.discover(parts[2]!));
			if (parts.length === 5 && parts[4] === "plan" && req.method === "GET")
				return json(res, 200, await environment.plan(parts[2]!));
			if (parts.length === 4 && req.method === "PUT") {
				const body = await readJson<{ environment?: unknown; expectedRevision?: unknown }>(req);
				try {
					// Approvals (review pins) need the native host-action capability; this route grants none yet.
					return json(
						res,
						200,
						await projects.updateEnvironment(parts[2]!, body.environment, body.expectedRevision, {
							native: false,
						}),
					);
				} catch (error) {
					if (error instanceof EnvironmentRevisionConflict)
						return json(res, 409, {
							error: "environment_conflict",
							revision: error.revision,
							message: error.message,
						});
					if (error instanceof EnvironmentApprovalRequired)
						return json(res, 403, { error: "native_action_required", message: error.message });
					throw error;
				}
			}
			if (parts.length === 5 && parts[4] === "override" && req.method === "PUT") {
				const body = await readJson<{ override?: unknown; expectedRevision?: unknown }>(req);
				try {
					// This host's own layer: never synced, same revision and review-pin rules.
					return json(
						res,
						200,
						await projects.updateEnvironmentOverride(parts[2]!, body.override, body.expectedRevision, {
							native: false,
						}),
					);
				} catch (error) {
					if (error instanceof EnvironmentRevisionConflict)
						return json(res, 409, {
							error: "environment_conflict",
							revision: error.revision,
							message: error.message,
						});
					if (error instanceof EnvironmentApprovalRequired)
						return json(res, 403, { error: "native_action_required", message: error.message });
					throw error;
				}
			}
		}
		if (parts[1] === "environment" && parts.length === 3 && parts[2] === "tools" && req.method === "GET") {
			if (!environment) return json(res, 404, { error: "environment_unavailable" });
			return json(res, 200, await environment.tools());
		}
		if (parts[1] === "projects" && parts.length === 4 && parts[3] === "dashboard" && req.method === "GET") {
			const rawLimit = url.searchParams.get("limit");
			if (rawLimit !== null && (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100))
				throw new HttpError(400, "limit must be between 1 and 100");
			return json(res, 200, dashboards.dashboard(parts[2]!, rawLimit === null ? undefined : Number(rawLimit)));
		}
		if (parts[1] === "dashboard" && parts[2] === "counts" && parts.length === 3 && req.method === "GET")
			return json(res, 200, dashboards.counts());
		if (parts[1] === "inbox" && parts.length === 2 && req.method === "GET") {
			const projectId = url.searchParams.get("projectId") || undefined;
			const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50;
			if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, "limit must be 1..100");
			const inbox: Inbox = {
				...dashboards.inbox(projectId, limit),
				...(tracking ? await tracking.inbox(projectId, limit) : {}),
			};
			return json(res, 200, inbox);
		}
		if (parts[1] === "reviews" && parts.length === 2 && req.method === "POST") {
			const body = await readJson<ReviewRequest>(req);
			const marks = body?.marks;
			if (
				!Array.isArray(marks) ||
				marks.length > REVIEW_MARKS_MAX ||
				!marks.every(
					(mark) =>
						mark !== null &&
						typeof mark === "object" &&
						typeof mark.sessionId === "string" &&
						typeof mark.outcomeAt === "number" &&
						Number.isFinite(mark.outcomeAt),
				)
			)
				throw new HttpError(400, `marks must list at most ${REVIEW_MARKS_MAX} { sessionId, outcomeAt } entries`);
			// Chats that no longer exist have nothing to review.
			reviews.mark(marks.filter((mark) => sessions.get(mark.sessionId)));
			return json(res, 200, { ok: true });
		}
		if (parts[1] === "projects" && parts.length === 4 && parts[3] === "branches" && req.method === "GET")
			return json(
				res,
				200,
				await projects.branches(
					parts[2]!,
					url.searchParams.get("mode") === "ask" ||
						(url.searchParams.get("mode") === "build" && url.searchParams.get("workspace") === "clone"),
				),
			);
		if (parts[1] === "control-chat" && parts[2] === "dashboard" && parts.length === 3 && req.method === "GET") {
			const args: Record<string, string> = {};
			for (const [key, value] of url.searchParams) {
				if ((key !== "projectId" && key !== "missionId") || key in args)
					throw new HttpError(400, "Invalid dashboard parameters");
				args[key] = value;
			}
			return json(res, 200, sessions.controlDashboard(args));
		}
		if (parts[1] === "control-chat" && parts.length === 2 && (req.method === "POST" || req.method === "GET"))
			return json(
				res,
				200,
				req.method === "GET"
					? (sessions.getControlChat() ?? (await sessions.ensureControlChat()))
					: await sessions.ensureControlChat(),
			);
		if (parts[1] === "control-chat" && req.method !== "GET" && req.method !== "HEAD") sessions.assertControlActive();
		// Local app HTTP surface only. There is deliberately no agent tool to revoke or edit a grant.
		if (parts[1] === "control-chat" && parts[2] === "authorizations") {
			if (parts.length === 3 && req.method === "GET")
				return json(
					res,
					200,
					await sessions.controlAuthorizationPage(
						url.searchParams.get("after") ?? undefined,
						url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
					),
				);
			if (parts.length === 4 && req.method === "DELETE")
				return json(res, 200, {
					revoked: await sessions.controlAuthorizations().authorizationRevoke(parts[3]!),
				} satisfies import("@pilot/protocol").RevokeControlAuthorizationResponse);
		}
		if (parts[1] === "control-chat" && parts[2] === "watches") {
			if (!watches) throw new HttpError(503, "Watches unavailable");
			if (parts.length === 3 && req.method === "GET")
				return json(
					res,
					200,
					await watches.page(
						url.searchParams.get("after") ?? undefined,
						url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
					),
				);
			if (parts.length === 4 && req.method === "DELETE")
				return json(res, 200, {
					removed: await watches.remove(parts[3]!),
				} satisfies import("@pilot/protocol").CancelWatchResponse);
		}
		if (parts[1] === "control-chat" && parts[2] === "audit" && parts.length === 3 && req.method === "GET")
			return json(
				res,
				200,
				await sessions
					.controlAudit()
					.page(
						url.searchParams.has("before") ? Number(url.searchParams.get("before")) : undefined,
						url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
					),
			);
		if (parts[1] === "control-chat" && parts[2] === "memory" && req.method === "GET") {
			// Read-only browsing for the app. Agents read memory only through their own zoom/date tools.
			const integer = (name: string, value: string | null | undefined): number | undefined => {
				if (value === null || value === undefined) return undefined;
				if (!/^\d{1,15}$/.test(value)) throw new HttpError(400, `${name} must be a non-negative integer`);
				return Number(value);
			};
			if (parts.length === 4 && parts[3] === "view") {
				const lines = await sessions.controlMemory().viewLines();
				return json(res, 200, { lines } satisfies import("@pilot/protocol").ControlMemoryViewResponse);
			}
			if (parts.length === 4 && parts[3] === "stats") return json(res, 200, await sessions.controlMemory().stats());
			if (parts.length === 4 && parts[3] === "messages") {
				const q = url.searchParams.get("q") ?? undefined;
				const limit = integer("limit", url.searchParams.get("limit")) ?? 50;
				if (limit < 1 || limit > 100) throw new HttpError(400, "limit must be 1..100");
				if (q !== undefined && (!q || q.length > 200 || q.includes("\0")))
					throw new HttpError(400, "q must be 1..200 characters");
				return json(
					res,
					200,
					await sessions.controlMemory().messages(integer("before", url.searchParams.get("before")), limit, q),
				);
			}
			if (parts.length === 6 && parts[3] === "nodes") {
				const id = integer("id", parts[4])!,
					n = integer("n", parts[5])!,
					offset = integer("offset", url.searchParams.get("offset"));
				if (n < 1 || !Number.isInteger(Math.log2(n)) || id % n)
					throw new HttpError(400, "Expected id+n with an aligned power-of-two n");
				if (n > 1 && offset !== undefined) throw new HttpError(400, "offset is only allowed for n=1");
				return json(res, 200, await sessions.controlMemory().node(id, n, offset));
			}
		}
		if (parts[1] === "sessions" && parts.length === 2) {
			if (req.method === "GET") {
				const archived = url.searchParams.get("archived") ?? "false";
				if (archived !== "false" && archived !== "true" && archived !== "all")
					throw new HttpError(400, "archived must be false, true or all");
				return json(
					res,
					200,
					sessions.list({
						archived,
						projectId: url.searchParams.get("projectId") ?? undefined,
						missionId: url.searchParams.get("missionId") ?? undefined,
					}),
				);
			}
			if (req.method === "POST") return json(res, 201, await sessions.spawn(await readJson<SpawnRequest>(req)));
		}
		if (parts[1] === "sessions" && parts.length === 3 && req.method === "GET") {
			const session = sessions.get(parts[2]!);
			if (!session) throw new HttpError(404, "Unknown session");
			return json(res, 200, session);
		}
		if (parts[1] === "sessions" && parts.length === 4 && parts[3] === "diagnostics" && req.method === "GET") {
			const rawLimit = url.searchParams.get("limit");
			if (rawLimit !== null && (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 128))
				throw new HttpError(400, "limit must be between 1 and 128");
			res.setHeader("cache-control", "no-store");
			return json(
				res,
				200,
				await sessions.diagnostics(parts[2]!, {
					host: requestedDiagnosticHost(url, hello),
					...(rawLimit === null ? {} : { limit: Number(rawLimit) }),
				}),
			);
		}
		if (
			parts[1] === "sessions" &&
			parts.length === 5 &&
			parts[3] === "diagnostics" &&
			parts[4] === "handoff" &&
			req.method === "POST"
		) {
			res.setHeader("cache-control", "no-store");
			return json(
				res,
				200,
				await sessions.diagnosticsHandoff(parts[2]!, await readJson<DiagnosticsHandoffRequest>(req), {
					host: requestedDiagnosticHost(url, hello),
				}),
			);
		}
		if (parts[1] === "sessions" && parts.length === 4 && parts[3] === "changes" && req.method === "GET") {
			const { cwd, base, baseBranch, branch } = sessions.changeBase(parts[2]!);
			return json(res, 200, recordedBranch(await repositoryChanges.changes(cwd, base, baseBranch), branch));
		}
		if (parts[1] === "sessions" && parts.length === 4 && parts[3] === "commands" && req.method === "GET") {
			const response: SessionCommandsResponse = { commands: await sessions.commands(parts[2]!) };
			return json(res, 200, response);
		}
		if (parts[1] === "sessions" && parts.length === 4 && parts[3] === "jobs" && req.method === "GET") {
			const response: SessionJobsResponse = { jobs: await sessions.jobs(parts[2]!) };
			return json(res, 200, response);
		}
		if (
			parts[1] === "sessions" &&
			parts.length === 6 &&
			parts[3] === "jobs" &&
			parts[5] === "stop" &&
			req.method === "POST"
		) {
			let jobId: string;
			try {
				jobId = decodeURIComponent(parts[4]!);
			} catch {
				throw new HttpError(400, "Invalid job id");
			}
			await sessions.stopJob(parts[2]!, jobId);
			return json(res, 202, { ok: true });
		}
		if (parts[1] === "sessions" && parts.length === 4 && parts[3] === "history" && req.method === "GET") {
			const before = url.searchParams.get("before");
			if (before === null || !/^\d+$/.test(before) || !Number.isSafeInteger(Number(before)))
				throw new HttpError(400, "before must be a non-negative integer");
			const limit = url.searchParams.get("limit") ?? String(HISTORY_PAGE_DEFAULT);
			if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > HISTORY_PAGE_MAX)
				throw new HttpError(400, `limit must be between 1 and ${HISTORY_PAGE_MAX}`);
			const page: SessionHistoryPage = await sessions.history(parts[2]!, Number(before), Number(limit));
			return json(res, 200, page);
		}
		if (
			parts[1] === "sessions" &&
			parts.length === 5 &&
			parts[3] === "changes" &&
			(parts[4] === "summary" || parts[4] === "branch") &&
			req.method === "GET"
		) {
			const { cwd, base, baseBranch, branch } = sessions.changeBase(parts[2]!);
			if (parts[4] === "branch")
				return json(res, 200, branch ? recordedBranch({}, branch) : await repositoryChanges.branch(cwd));
			return json(res, 200, recordedBranch(await repositoryChanges.summary(cwd, base, baseBranch), branch));
		}
		if (parts[1] === "sessions" && parts[3] === "artifacts" && req.method === "GET") {
			if (parts.length === 4) return json(res, 200, await sessions.artifacts(parts[2]!));
			if (parts.length === 5) {
				const revisions = url.searchParams.getAll("revision");
				const value = revisions[0];
				if (
					revisions.length > 1 ||
					(value !== undefined && (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))))
				)
					throw new HttpError(400, "revision must be a positive integer");
				return json(
					res,
					200,
					await sessions.artifact(parts[2]!, parts[4]!, value === undefined ? undefined : Number(value)),
				);
			}
		}
		if (
			parts[1] === "sessions" &&
			parts.length === 5 &&
			parts[3] === "pull-requests" &&
			(parts[4] === "merge-preview" || parts[4] === "merge") &&
			req.method === "POST"
		) {
			const body = await readJson<MergePullRequestRequest>(req);
			if (!body || typeof body.url !== "string" || !body.url.trim() || body.url.length > 2048)
				throw new HttpError(400, "url must be a non-empty string of at most 2048 characters");
			if (parts[4] === "merge-preview")
				return json(res, 200, await sessions.previewPullRequestMerge(parts[2]!, body.url));
			if (
				!["squash", "merge", "rebase"].includes(body.method) ||
				typeof body.headSha !== "string" ||
				!/^[a-f0-9]{40,64}$/.test(body.headSha) ||
				typeof body.baseBranch !== "string" ||
				!body.baseBranch ||
				body.baseBranch.length > 1024
			)
				throw new HttpError(400, "A merge method, confirmed headSha and baseBranch are required");
			await sessions.mergePullRequest(parts[2]!, body);
			return json(res, 200, { merged: true });
		}
		if (
			parts[1] === "sessions" &&
			parts.length === 4 &&
			parts[3] === "pull-requests" &&
			(req.method === "POST" || req.method === "DELETE")
		) {
			const body = await readJson<BindPullRequestRequest | UnbindPullRequestRequest>(req);
			if (!body || typeof body.url !== "string" || !body.url.trim() || body.url.length > 2048)
				throw new HttpError(400, "url must be a non-empty string of at most 2048 characters");
			if (req.method === "POST") {
				const taskId = (body as BindPullRequestRequest).taskId;
				if (taskId !== undefined && (typeof taskId !== "string" || !taskId.trim() || taskId.length > 128))
					throw new HttpError(400, "taskId must be a non-empty string of at most 128 characters");
				return json(res, 200, await sessions.bindPullRequest(parts[2]!, body.url, {}, taskId));
			}
			return json(res, 200, await sessions.unbindPullRequest(parts[2]!, body.url, {}));
		}
		if (parts[1] === "sessions" && parts.length === 4 && parts[3] === "branches" && req.method === "DELETE") {
			const body = await readJson<DetachBranchRequest>(req);
			if (!body || typeof body.branch !== "string" || !body.branch.trim() || body.branch.length > 255)
				throw new HttpError(400, "branch must be a non-empty string of at most 255 characters");
			return json(res, 200, await sessions.detachBranch(parts[2]!, body.branch));
		}
		if (parts[1] === "sessions" && parts.length === 4 && req.method === "POST") {
			const id = parts[2]!;
			if (parts[3] === "subscription-force") {
				const body = await readJson<SubscriptionForceRequest>(req);
				if (!body || typeof body.force !== "boolean") throw new HttpError(400, "force must be a boolean");
				return json(res, 200, await sessions.forceSubscription(id, body.force));
			}
			if (parts[3] === "archive") return json(res, 200, await sessions.archive(id));
			if (parts[3] === "restore") return json(res, 200, await sessions.restore(id));
			if (parts[3] === "pin") return json(res, 200, await sessions.setPinned(id, true));
			if (parts[3] === "unpin") return json(res, 200, await sessions.setPinned(id, false));
			if (parts[3] === "title") {
				const body = await readJson<RenameSessionRequest>(req);
				if (!body || typeof body.title !== "string" || !body.title.trim())
					throw new HttpError(400, "title is required");
				return json(res, 200, await sessions.rename(id, body.title));
			}
			if (parts[3] === "reclaim-workspace") return json(res, 200, await sessions.reclaimWorkspace(id));
			if (parts[3] === "model" || parts[3] === "continue-model") {
				const body = await readJson<ChangeModelRequest>(req);
				if (!body || typeof body.model !== "string" || !body.model.trim())
					throw new HttpError(400, "model is required");
				if (body.thinking !== undefined && (typeof body.thinking !== "string" || !body.thinking))
					throw new HttpError(400, "thinking must be a supported level");
				return json(
					res,
					200,
					await (parts[3] === "continue-model"
						? sessions.continueModel(id, body.model, models, body.thinking)
						: sessions.changeModel(id, body.model, models, body.thinking)),
				);
			}
			if (parts[3] === "messages") {
				const parent = traceCarrier({ traceparent: req.headers.traceparent });
				const span = nodeTelemetry().startSpan(
					"pilot.message.send",
					{ "pilot.operation": "message.send", "pilot.phase": "api" },
					{ ...(parent ? { parent } : {}) },
				);
				try {
					const body = await readJson<SendRequest>(req);
					// User admission never accepts the internal automatic-producer namespaces.
					if (
						body.requestId !== undefined &&
						(typeof body.requestId !== "string" || !/^[\w-]{1,128}$/.test(body.requestId))
					)
						throw new HttpError(400, "requestId must be 1-128 letters, digits, dashes or underscores");
					await sessions.send(id, body.message, body.mode, body.requestId, span.carrier() ?? parent);
					span.end();
					return json(res, 202, { ok: true });
				} catch (error) {
					span.finish("failed");
					throw error;
				}
			}
			if (parts[3] === "database-access") {
				const body = await readJson<DatabaseAccessDecision | null>(req);
				if (!body || typeof body.id !== "string" || !body.id || typeof body.allow !== "boolean")
					throw new HttpError(400, "id and allow are required");
				await sessions.decideDatabaseAccess(id, body.id, body.allow);
				return json(res, 202, { ok: true });
			}
			if (parts[3] === "permission-upgrade") {
				if (!githubSetup) return json(res, 503, { error: "native_action_unavailable" });
				try {
					await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
				} catch {
					return json(res, 403, { error: "native_action_required" });
				}
				const body = await readJson<import("@pilot/protocol").PermissionUpgradeDecision | null>(req);
				if (!body || typeof body.id !== "string" || !body.id || typeof body.allow !== "boolean")
					throw new HttpError(400, "id and allow are required");
				await sessions.decideControlPermission(id, body.id, body.allow);
				return json(res, 202, { ok: true });
			}
			if (parts[3] === "stop") {
				return json(res, 202, await sessions.stop(id));
			}
			if (parts[3] === "retry-startup") return json(res, 200, await sessions.retryStartup(id));
			if (parts[3] === "compact") {
				const body = (await readJson<CompactRequest | null>(req)) ?? {};
				if (body.instructions !== undefined && typeof body.instructions !== "string")
					throw new HttpError(400, "instructions must be a string");
				await sessions.compact(id, body.instructions);
				return json(res, 202, { ok: true });
			}
			if (parts[3] === "rewind") {
				const body = await readJson<RewindRequest | null>(req);
				if (!body || (body.action !== "retry" && body.action !== "edit" && body.action !== "restore"))
					throw new HttpError(400, "action must be retry, edit or restore");
				if (typeof body.entryId !== "number" || !Number.isSafeInteger(body.entryId) || body.entryId <= 0)
					throw new HttpError(400, "entryId must be a positive integer");
				return json(res, 200, await sessions.rewind(id, body.action, body.entryId));
			}
		}
		if (
			parts[1] === "sessions" &&
			parts.length === 6 &&
			parts[3] === "attempts" &&
			parts[5] === "activate" &&
			req.method === "POST"
		) {
			if (!/^[1-9]\d*$/.test(parts[4]!) || !Number.isSafeInteger(Number(parts[4])))
				throw new HttpError(400, "Invalid attempt ID");
			return json(res, 200, await sessions.activateAttempt(parts[2]!, parts[4]!));
		}
		if (parts[1] === "sessions" && parts.length === 6 && parts[3] === "subagents") {
			const id = parts[2]!;
			let name: string;
			try {
				name = decodeURIComponent(parts[4]!);
			} catch {
				throw new HttpError(400, "Invalid subagent name");
			}
			if (parts[5] === "transcript" && req.method === "GET") {
				const after = url.searchParams.get("after");
				if (after !== null && (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after))))
					throw new HttpError(400, "after must be a non-negative integer");
				const ifNoneMatch = req.headers["if-none-match"]?.replace(/^W\//, "").replace(/^"|"$/g, "");
				const read = await sessions.subagentTranscript(id, name, {
					...(after === null ? {} : { after: Number(after) }),
					...(ifNoneMatch ? { ifNoneMatch } : {}),
				});
				if (read.signature) res.setHeader("etag", JSON.stringify(read.signature));
				if (read.unchanged) {
					res.writeHead(304);
					return res.end();
				}
				return json(res, 200, read.transcript);
			}
			if (parts[5] === "messages" && req.method === "POST") {
				const body = await readJson<SubagentMessageRequest>(req);
				if (!body || typeof body.message !== "string" || !body.message.trim())
					throw new HttpError(400, "message is required");
				if (body.mode !== undefined && body.mode !== "steer" && body.mode !== "followUp")
					throw new HttpError(400, "mode must be steer or followUp");
				if (
					body.requestId !== undefined &&
					(typeof body.requestId !== "string" || !/^[\w-]{1,128}$/.test(body.requestId))
				)
					throw new HttpError(400, "requestId must be 1-128 letters, digits, dashes or underscores");
				await sessions.subagentCommand(id, name, {
					action: "send",
					message: body.message,
					...(body.mode ? { mode: body.mode } : {}),
					...(body.requestId ? { requestId: body.requestId } : {}),
				});
				return json(res, 202, { ok: true });
			}
			if (parts[5] === "stop" && req.method === "POST") {
				await sessions.subagentCommand(id, name, { action: "stop" });
				return json(res, 202, { ok: true });
			}
		}
		if (parts[1] === "sessions" && parts.length === 5 && parts[3] === "queue" && req.method === "PATCH") {
			const body = await readJson<EditQueuedMessageRequest>(req);
			if (body?.mode !== undefined && body.mode !== "steer" && body.mode !== "followUp")
				throw new HttpError(400, "mode must be steer or followUp");
			await sessions.editQueuedMessage(parts[2]!, Number(parts[4]), body.message, body.mode);
			return json(res, 200, { ok: true });
		}
		if (
			parts[1] === "sessions" &&
			parts[3] === "held" &&
			parts.length === 5 &&
			req.method === "POST" &&
			parts[4] === "send"
		) {
			await sessions.heldMessages(parts[2]!, "send");
			return json(res, 200, { ok: true });
		}
		if (
			parts[1] === "sessions" &&
			parts[3] === "held" &&
			(parts.length === 4 || parts.length === 5) &&
			req.method === "DELETE"
		) {
			if (parts.length === 5 && (!/^[1-9]\d*$/.test(parts[4]!) || !Number.isSafeInteger(Number(parts[4]))))
				throw new HttpError(400, "Invalid held message ID");
			await sessions.heldMessages(parts[2]!, "discard", parts.length === 5 ? Number(parts[4]) : undefined);
			return json(res, 200, { ok: true });
		}
		if (parts[1] === "sessions" && parts.length === 5 && parts[3] === "queue" && req.method === "DELETE") {
			if (!/^[1-9]\d*$/.test(parts[4]!) || !Number.isSafeInteger(Number(parts[4])))
				throw new HttpError(400, "Invalid queued message ID");
			await sessions.removeQueuedMessage(parts[2]!, Number(parts[4]));
			return json(res, 200, { ok: true });
		}
		throw new HttpError(404, "Not found");
	};

	const server = createServer((req, res) => {
		// Requests still open when the event loop stalls are reported with it. IDs stay local to the log.
		const done = operations.begin(`${req.method} ${(req.url ?? "/").split("?")[0]}`);
		res.once("close", done);
		if (missions && req.method !== "GET" && req.method !== "HEAD") acknowledgeWhenDurable(res, missions.store);
		let release: (() => void) | undefined;
		const run = async () => {
			const path = new URL(req.url ?? "/", "http://localhost").pathname;
			const update = path.startsWith("/api/runtime-update");
			const control =
				/\/(stop|cancel|seal)$/.test(path) || (req.method === "DELETE" && path.startsWith("/api/setup/runs/"));
			if (!update && req.method !== "GET" && req.method !== "HEAD" && !control)
				release = mutations.begin({ kind: "request", id: path.slice(0, 180) });
			else if (
				(req.method === "GET" || req.method === "HEAD") &&
				/\/(artifacts|artifact-libraries|files)(\/|$)/.test(path)
			)
				release = transfers.begin({ kind: "download", id: path.slice(0, 180) });
			let routeDone = false;
			const settled = () => {
				if (routeDone) release?.();
			};
			res.once("finish", settled);
			res.once("close", settled);
			try {
				await route(req, res);
			} finally {
				routeDone = true;
				// A closed socket is not proof that queued filesystem/metadata work has settled.
				if (res.destroyed || res.writableFinished) release?.();
			}
		};
		run().catch((error: unknown) => {
			const status =
				error instanceof HttpError || error instanceof SetupError
					? error.status
					: error instanceof ServiceUnavailable
						? 503
						: error instanceof NotFound
							? 404
							: error instanceof Conflict
								? 409
								: 400;
			const message =
				((req.url ?? "").startsWith("/api/setup") || (req.url ?? "").startsWith("/api/github-import")) &&
				!(error instanceof SetupError || error instanceof HttpError)
					? "Setup operation failed. No credential details are returned."
					: error instanceof Error
						? error.message
						: String(error);
			if (!res.headersSent) json(res, status, { error: message });
			else res.end();
		});
	});

	// The control socket carries only small subscription messages. Terminal pastes use the terminal socket.
	const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
	// Dedicated chat, terminal and subagent sockets. Each has its own send queue, so one stream's large snapshot,
	// output burst or slow reader never delays another stream or the sidebar, and overload resets only that stream.
	const streamWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
	const terminalWss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
	server.on("close", () => {
		stopRecoveryWatch?.();
		for (const ws of terminalWss.clients) ws.terminate();
		terminalWss.close();
	});
	const setupWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
	server.on("close", () => {
		for (const ws of setupWss.clients) ws.terminate();
		setupWss.close();
	});
	const chatStreams = new ChatStreams((sessionId, listener, trace) => sessions.subscribe(sessionId, listener, trace));
	server.on("close", () => chatStreams.close());
	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (!isAllowedOrigin(req.headers.origin)) {
			socket.destroy();
			return;
		}
		const setupRoute = /^\/api\/setup\/runs\/([a-f0-9-]{36})\/terminal\/ws$/.exec(url.pathname);
		if (setupRoute && setup) {
			setupWss.handleUpgrade(req, socket, head, (ws) => {
				const send = boundedSender(ws, 64 * 1024);
				let detach: (() => void) | undefined;
				const report = () =>
					send(
						JSON.stringify({
							type: "setup.error",
							message: "Setup operation refused. Recheck this run on the selected host.",
						}),
					);
				try {
					detach = setup.attach(setupRoute[1]!, (message) => send(JSON.stringify(message)));
				} catch {
					report();
					ws.close(SOCKET_REFUSED, "Setup unavailable");
					return;
				}
				ws.on("close", () => detach?.());
				ws.on("message", (raw) => {
					try {
						const message = JSON.parse(String(raw));
						if (
							message.type === "setup.answer" &&
							typeof message.challengeId === "string" &&
							typeof message.answer === "string"
						)
							setup.answer(setupRoute[1]!, message.challengeId, message.answer);
						else if (message.type === "setup.resize") setup.resize(setupRoute[1]!, message.cols, message.rows);
						else report();
					} catch {
						report();
					}
				});
			});
			return;
		}
		if (url.pathname === "/api/ws") {
			wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
			return;
		}
		const route = streamSocketRoute(url.pathname);
		if (!route) {
			socket.destroy();
			return;
		}
		if (route.kind === "terminal" && terminalWss.clients.size >= 64) {
			socket.destroy();
			return;
		}
		(route.kind === "terminal" ? terminalWss : streamWss).handleUpgrade(req, socket, head, (ws) => {
			if (route.kind === "chat") openChat(ws, route.sessionId, url.searchParams, req.headers.traceparent);
			else if (route.kind === "terminal") openTerminal(ws, route.sessionId, url.searchParams);
			else openSubagent(ws, route.sessionId, route.name);
		});
	});

	const clients = new Map<WebSocket, (data: string) => void>();
	/** Open chat sockets per session, for artifact index updates that must stay ordered with the initial index. */
	const chatSenders = new Map<string, Set<(data: string) => void>>();
	const repositoryVersions = new Map(
		sessions
			.list({ archived: "all" })
			.map((session) => [session.id, { cwd: session.cwd, version: repositoryVersion(session) }]),
	);
	const artifactVersions = new Map<string, number>();
	const send = (ws: WebSocket, message: ServerMessage) => {
		if (ws.readyState === ws.OPEN) clients.get(ws)?.(JSON.stringify(message));
	};
	const broadcast = (message: ServerMessage) => {
		if (clients.size === 0) return;
		const data = JSON.stringify(message);
		for (const send of clients.values()) send(data);
	};
	const stopDiagnosticReads = sessions.diagnosticReadBroker?.onRead((dispatch) => {
		broadcast({ type: "diagnostics.read", dispatch });
	});
	let sharingInvalidationScheduled = false;
	let watchInvalidationScheduled = false;
	let controlDashboardTimer: NodeJS.Timeout | undefined;
	const invalidateControlDashboard = () => {
		if (clients.size === 0 || controlDashboardTimer) return;
		controlDashboardTimer = setTimeout(() => {
			controlDashboardTimer = undefined;
			broadcast({ type: "dashboard.changed" });
		}, DASHBOARD_DEBOUNCE_MS);
		controlDashboardTimer.unref();
	};
	const stopControlDashboard = sessions.onControlDashboardChange(invalidateControlDashboard);
	const stopWatches = watches?.onChange(() => {
		invalidateControlDashboard();
		if (watchInvalidationScheduled) return;
		watchInvalidationScheduled = true;
		queueMicrotask(() => {
			watchInvalidationScheduled = false;
			broadcast({ type: "watches.changed" });
		});
	});
	const stopControlAudit = sessions.onControlAudit(() => broadcast({ type: "control-audit.changed" }));
	// Appends and summaries can arrive in bursts while a turn streams: leading edge, then at most one per second.
	let memoryTimer: NodeJS.Timeout | undefined,
		memoryDirty = false;
	const memoryChanged = () => {
		if (memoryTimer) {
			memoryDirty = true;
			return;
		}
		broadcast({ type: "control-memory.changed" });
		memoryTimer = setTimeout(() => {
			memoryTimer = undefined;
			if (!memoryDirty) return;
			memoryDirty = false;
			memoryChanged();
		}, 1000);
		memoryTimer.unref();
	};
	const stopControlMemory = sessions.onControlMemory(memoryChanged);
	const invalidateSharing = () => {
		if (sharingInvalidationScheduled) return;
		sharingInvalidationScheduled = true;
		queueMicrotask(() => {
			sharingInvalidationScheduled = false;
			broadcast({ type: "shared-contexts.changed" });
		});
	};
	let recoveringSharing: Promise<void> | undefined;
	const stopSharingWatch = sharing?.onChange(() => {
		invalidateSharing();
		// A prerequisite/context change can unblock a reserved handler. Pending receipts are
		// not resubmitted by couriers; recovery belongs to this intact destination journal.
		if (journal && !recoveringSharing)
			recoveringSharing = journal
				.recover(admitOperation)
				.catch(() => {})
				.finally(() => {
					recoveringSharing = undefined;
				});
	});
	const stopSharingReceipts = journal?.onSettled((operation) => {
		if (operation.kind.startsWith("share-")) invalidateSharing();
	});
	server.on("close", () => {
		stopSharingWatch?.();
		stopDiagnosticReads?.();
		stopWatches?.();
		stopControlAudit();
		stopControlMemory();
		clearTimeout(memoryTimer);
		stopControlDashboard();
		stopSharingReceipts?.();
		clearTimeout(controlDashboardTimer);
	});
	const stopPowerWatch = power?.onChange(() => broadcast({ type: "power", power: power.status() }));
	server.on("close", () => stopPowerWatch?.());
	const stopMcpWatch = mcp?.onChange((status) => broadcast({ type: "mcp", mcp: status }));
	server.on("close", () => stopMcpWatch?.());
	// Coalesce claim/finalize and CRUD bursts. No serialization when no clients are connected.
	let schedulesTimer: NodeJS.Timeout | undefined;
	let schedulesVersion = 0;
	const stopSchedulesWatch = schedules?.onChange(() => {
		schedulesVersion++;
		if (schedulesTimer || clients.size === 0) return;
		schedulesTimer = setTimeout(() => {
			schedulesTimer = undefined;
			if (clients.size)
				void schedules!
					.snapshot(undefined, true)
					.then((data) => {
						for (const send of clients.values()) send(data);
					})
					.catch((error) => console.warn(`pilotd: schedule snapshot: ${error}`));
		}, DASHBOARD_DEBOUNCE_MS);
		schedulesTimer.unref();
	});
	server.on("close", () => {
		stopSchedulesWatch?.();
		clearTimeout(schedulesTimer);
	});
	// Coalesce source status changes and send list invalidations, never unbounded external text.
	let sourceTimer: NodeJS.Timeout | undefined;
	const changedTrackingProjects = new Set<string>();
	const stopTrackingWatch = tracking?.onChange((change) => {
		invalidateControlDashboard();
		if (clients.size === 0) return;
		if (change.type === "items") changedTrackingProjects.add(change.projectId);
		if (sourceTimer) return;
		sourceTimer = setTimeout(() => {
			sourceTimer = undefined;
			broadcast({ type: "sources", sources: tracking.list() });
			for (const projectId of changedTrackingProjects) broadcast({ type: "tracked.changed", projectId });
			changedTrackingProjects.clear();
		}, DASHBOARD_DEBOUNCE_MS);
		sourceTimer.unref();
	});
	server.on("close", () => {
		stopTrackingWatch?.();
		clearTimeout(sourceTimer);
	});
	projects.onChange((list) => {
		invalidateControlDashboard();
		broadcast({ type: "projects", projects: list });
	});
	sessions.onArtifactsChanged((sessionId, artifacts) => {
		artifactVersions.set(sessionId, (artifactVersions.get(sessionId) ?? 0) + 1);
		const message: ServerMessage = { type: "artifacts", sessionId, artifacts };
		broadcast(message);
		const chats = chatSenders.get(sessionId);
		if (chats?.size) {
			const data = JSON.stringify(message);
			for (const send of chats) send(data);
		}
	});
	/** Subscribed sockets per mission. Detail is read once per change and shared. */
	const missionSubscribers = new Map<string, Set<WebSocket>>();
	/** Subscribed sockets per project dashboard, and the last content sent for each (to push only real changes). */
	const dashboardSubscribers = new Map<string, Set<WebSocket>>();
	const dashboardSent = new Map<string, string>();
	let countsSent = "";
	let dashboardTimer: NodeJS.Timeout | undefined;
	const sendCounts = (targets?: WebSocket) => {
		const counts = dashboards.counts();
		const key = JSON.stringify(counts);
		if (targets) return send(targets, { type: "dashboard.counts", counts });
		if (key === countsSent) return;
		countsSent = key;
		broadcast({ type: "dashboard.counts", counts });
	};
	const pushDashboard = (projectId: string, targets: Iterable<WebSocket>, onlyChanged: boolean) => {
		try {
			const dashboard = dashboards.dashboard(projectId);
			const key = JSON.stringify(dashboard);
			if (onlyChanged && dashboardSent.get(projectId) === key) return;
			dashboardSent.set(projectId, key);
			for (const ws of targets) send(ws, { type: "dashboard", dashboard });
		} catch (error) {
			dashboardSent.delete(projectId);
			for (const ws of targets)
				send(ws, { type: "error", message: error instanceof Error ? error.message : String(error) });
			if (error instanceof NotFound) dashboardSubscribers.delete(projectId);
		}
	};
	const refreshDashboards = () => {
		dashboardTimer = undefined;
		if (clients.size === 0) return;
		try {
			sendCounts();
			for (const [projectId, subscribers] of [...dashboardSubscribers])
				if (subscribers.size) pushDashboard(projectId, [...subscribers], true);
		} catch (error) {
			console.warn(`pilotd: dashboard update failed: ${error}`);
		}
	};
	// Event-driven: any source change schedules one trailing recompute, so bursts cost a single pass.
	const stopDashboardWatch = dashboards.onChange(() => {
		if (clients.size === 0 || dashboardTimer) return;
		dashboardTimer = setTimeout(refreshDashboards, DASHBOARD_DEBOUNCE_MS);
		dashboardTimer.unref();
	});
	server.on("close", () => {
		stopDashboardWatch();
		clearTimeout(dashboardTimer);
		dashboardTimer = undefined;
	});
	// Keep this the last `sessions.onChange` registration: server.test.ts drives the most recent listener.
	sessions.onChange((session) => {
		invalidateControlDashboard();
		const previous = repositoryVersions.get(session.id);
		const version = repositoryVersion(session);
		if (previous?.version !== version) {
			if (previous && previous.cwd !== session.cwd) repositoryChanges.invalidate(previous.cwd);
			repositoryChanges.invalidate(session.cwd);
			repositoryVersions.set(session.id, { cwd: session.cwd, version });
		}
		broadcast({ type: "session", session });
	});
	const pushMission = (missionId: string, targets: Iterable<WebSocket>) => {
		if (!missions) return;
		const detail = missions.store.get(missionId) ? missions.store.detail(missionId) : undefined;
		for (const ws of targets)
			if (detail) send(ws, { type: "mission", mission: detail });
			else send(ws, { type: "error", message: `Unknown mission: ${missionId}` });
	};
	if (missions) {
		let pending = new Set<string>();
		let scheduled = false;
		// Coalesce bursts (a mission and its tasks created together) into one list and one detail per mission.
		missions.store.onChange((missionId) => {
			invalidateControlDashboard();
			pending.add(missionId);
			if (scheduled) return;
			scheduled = true;
			queueMicrotask(() => {
				const changed = pending;
				pending = new Set();
				scheduled = false;
				broadcast({ type: "missions", missions: missions.store.list() });
				for (const id of changed) {
					const subscribers = missionSubscribers.get(id);
					if (subscribers?.size) pushMission(id, subscribers);
				}
			});
		});
	}

	wss.on("connection", (ws: WebSocket) => {
		clients.set(ws, boundedSender(ws));
		if (power) send(ws, { type: "power", power: power.status() });
		if (mcp) send(ws, { type: "mcp", mcp: mcp.status() });
		send(ws, { type: "projects", projects: projects.list() });
		if (schedules) {
			const version = schedulesVersion;
			void schedules
				.snapshot(undefined, true)
				.then((data) => {
					// A coalesced update will deliver the newer index if this initial read was superseded.
					if (version === schedulesVersion && ws.readyState === ws.OPEN) clients.get(ws)?.(data);
				})
				.catch((error) => send(ws, { type: "error", message: String(error) }));
		}
		if (tracking) send(ws, { type: "sources", sources: tracking.list() });
		send(ws, { type: "sessions", sessions: sessions.list({ archived: "all" }) });
		if (missions) send(ws, { type: "missions", missions: missions.store.list() });
		sendCounts(ws);
		ws.on("message", (raw) => {
			if (ws.readyState !== ws.OPEN) return;
			let message: unknown;
			try {
				message = JSON.parse(String(raw));
			} catch {
				return send(ws, { type: "error", message: "Invalid JSON" });
			}
			if (isMissionClientMessage(message)) {
				if (!missions) return send(ws, { type: "error", message: "Missions are unavailable" });
				const { missionId } = message;
				if (message.type === "mission.unsubscribe") {
					missionSubscribers.get(missionId)?.delete(ws);
					return;
				}
				let subscribers = missionSubscribers.get(missionId);
				if (!subscribers) {
					subscribers = new Set();
					missionSubscribers.set(missionId, subscribers);
				}
				subscribers.add(ws);
				return pushMission(missionId, [ws]);
			}
			if (isFocusClientMessage(message)) return sessions.focusPullRequests(message.sessionIds);
			if (isDashboardClientMessage(message)) {
				const { projectId } = message;
				if (message.type === "dashboard.unsubscribe") {
					const subscribers = dashboardSubscribers.get(projectId);
					subscribers?.delete(ws);
					if (subscribers && !subscribers.size) {
						dashboardSubscribers.delete(projectId);
						dashboardSent.delete(projectId);
					}
					return;
				}
				let subscribers = dashboardSubscribers.get(projectId);
				if (!subscribers) {
					subscribers = new Set();
					dashboardSubscribers.set(projectId, subscribers);
				}
				subscribers.add(ws);
				return pushDashboard(projectId, [ws], false);
			}
			send(ws, { type: "error", message: "Invalid client message" });
		});
		ws.on("close", () => {
			clients.delete(ws);
			for (const [id, subscribers] of dashboardSubscribers) {
				subscribers.delete(ws);
				if (!subscribers.size) {
					dashboardSubscribers.delete(id);
					dashboardSent.delete(id);
				}
			}
			for (const [id, subscribers] of missionSubscribers) {
				subscribers.delete(ws);
				if (!subscribers.size) missionSubscribers.delete(id);
			}
		});
	});

	/** Report and close a dedicated socket: final for unknown or refused targets, otherwise retryable. */
	function refuse(ws: WebSocket, report: (message: string) => void, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		report(message);
		const code = error instanceof NotFound ? SOCKET_NOT_FOUND : error instanceof Conflict ? SOCKET_REFUSED : 1013;
		ws.close(code, closeReason(message));
	}

	/**
	 * Stream one session's transcript on its own socket. A new stream starts with a snapshot; a resume with
	 * `?stream=&after=` replays only the missed batches.
	 */
	function openChat(
		ws: WebSocket,
		sessionId: string,
		params: URLSearchParams,
		traceparent: string | string[] | undefined,
	): void {
		const sendData = boundedSender(ws);
		const send = (message: ServerMessage) => sendData(JSON.stringify(message));
		let detach: (() => void) | undefined;
		let closed = false;
		ws.on("message", () => undefined);
		ws.on("close", () => {
			closed = true;
			detach?.();
			const chats = chatSenders.get(sessionId);
			chats?.delete(sendData);
			if (chats && !chats.size) chatSenders.delete(sessionId);
		});
		const streamId = params.get("stream");
		const after = Number(params.get("after"));
		const parent = traceCarrier({ traceparent });
		const apiSpan = nodeTelemetry().startSpan(
			"pilot.chat.open",
			{ "pilot.operation": "chat.open", "pilot.phase": "api" },
			{ ...(parent ? { parent } : {}) },
		);
		const historyTrace = apiSpan.carrier() ?? parent;
		try {
			const attachment = chatStreams.attach(
				sessionId,
				sendData,
				streamId ? { streamId, after } : undefined,
				historyTrace,
			);
			detach = attachment.detach;
			if (attachment.resumed && historyTrace) {
				const history = nodeTelemetry().startSpan(
					"pilot.chat.open",
					{ "pilot.operation": "chat.open", "pilot.phase": "history_read", "pilot.cold": false },
					{ parent: historyTrace },
				);
				history.end();
			}
			apiSpan.end();
		} catch (error) {
			apiSpan.finish("failed");
			refuse(ws, (message) => send({ type: "error", sessionId, message }), error);
			return;
		}
		let chats = chatSenders.get(sessionId);
		if (!chats) {
			chats = new Set();
			chatSenders.set(sessionId, chats);
		}
		chats.add(sendData);
		// An opened chat should show a fresh PR badge.
		sessions.focusPullRequests([sessionId]);
		const version = artifactVersions.get(sessionId);
		void sessions.artifacts(sessionId).then(
			(artifacts) => {
				// An update already sent on this socket supersedes an older in-flight index.
				if (!closed && artifactVersions.get(sessionId) === version)
					send({ type: "artifacts", sessionId, artifacts });
			},
			(error: unknown) => {
				if (!closed)
					send({ type: "error", sessionId, message: error instanceof Error ? error.message : String(error) });
			},
		);
	}

	/** Attach to the session's shell for the socket's lifetime. Input and resizes arrive on the same socket. */
	function openTerminal(ws: WebSocket, sessionId: string, params: URLSearchParams): void {
		const sender = terminalSender(ws, sessionId);
		const send = (message: ServerMessage) => sender.message(message);
		const report = (message: string) => send({ type: "error", sessionId, message });
		let detach: (() => void) | undefined;
		let terminalId: string | undefined;
		const opening = setTimeout(() => ws.close(SOCKET_REFUSED, "Terminal open timed out"), 10_000);
		opening.unref();
		ws.on("close", () => {
			clearTimeout(opening);
			detach?.();
		});
		const cols = terminalSize(params.get("cols"));
		const rows = terminalSize(params.get("rows"));
		if (cols === undefined || rows === undefined) {
			report("Invalid terminal size");
			ws.close(SOCKET_REFUSED, "Invalid terminal size");
			return;
		}
		try {
			sessions.assertWritable(sessionId);
			// A terminal must not start before the private clone is ready.
			const { cwd } = sessions.changeBase(sessionId);
			void cwd;
			if (params.get("protocol") !== "2") {
				report("Workspace terminal protocol 2 is required; update the app");
				ws.close(SOCKET_REFUSED, "Workspace terminal protocol unsupported");
				return;
			}
			send({
				type: "terminal.hello",
				sessionId,
				bootId: terminals.bootId,
				terminalId: terminals.currentId(sessionId),
			});
		} catch (error) {
			refuse(ws, report, error);
			return;
		}
		ws.on("message", (raw) => {
			let message: unknown;
			try {
				message = JSON.parse(String(raw));
			} catch {
				return report("Invalid JSON");
			}
			if (!isTerminalSocketMessage(message)) return report("Invalid terminal message");
			try {
				if (message.type === "terminal.open") {
					if (detach) throw new Conflict("Terminal socket is already attached");
					sessions.assertWritable(sessionId);
					const { cwd } = sessions.changeBase(sessionId);
					detach = terminals.attach(
						sessionId,
						cwd,
						cols,
						rows,
						{
							ready: (id) => {
								terminalId = id;
								send({ type: "terminal.ready", sessionId, terminalId: id });
							},
							data: (data) => sender.data(data),
							exit: (code) => send({ type: "terminal.exit", sessionId, code }),
						},
						message.restart === true,
						message,
					);
					clearTimeout(opening);
				} else if (!terminalId || message.terminalId !== terminalId)
					throw new Conflict("Terminal instance does not match");
				else if (message.type === "terminal.input") {
					sessions.assertWritable(sessionId);
					terminals.write(sessionId, message.data, terminalId);
				} else if (message.type === "terminal.close") terminals.close(sessionId, terminalId);
				else terminals.resize(sessionId, message.cols, message.rows, terminalId);
			} catch (error) {
				report(error instanceof Error ? error.message : String(error));
				if (message.type === "terminal.open")
					ws.close(error instanceof ServiceUnavailable ? 1013 : SOCKET_REFUSED, "Terminal attach refused");
			}
		});
	}

	/** Stream one subagent's transcript on its own socket: a snapshot first, then appended entries. */
	function openSubagent(ws: WebSocket, sessionId: string, name: string): void {
		const sendData = boundedSender(ws);
		const send = (message: ServerMessage) => sendData(JSON.stringify(message));
		const report = (message: string) => send({ type: "error", sessionId, name, message });
		let stop: (() => void) | undefined;
		ws.on("message", () => undefined);
		ws.on("close", () => stop?.());
		try {
			stop = sessions.watchSubagent(sessionId, name, {
				events: (events) => send({ type: "subagent.events", sessionId, name, events }),
				error: report,
			});
		} catch (error) {
			refuse(ws, report, error);
		}
	}

	return Object.assign(server, {
		runtimeResources,
	});
}
/** Mission routes under /api/missions and /api/sessions/:id/mission. Returns false when nothing matched. */
async function missionRoute(
	missions: { service: MissionService; store: MissionStore },
	parts: string[],
	url: URL,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<boolean> {
	const { service, store } = missions;
	const method = req.method;
	if (parts[1] === "sessions" && parts.length === 4 && parts[3] === "mission") {
		if (method === "PUT")
			return json(res, 200, service.join(parts[2]!, await readJson<JoinMissionRequest>(req))), true;
		if (method === "DELETE") return json(res, 200, service.leave(parts[2]!)), true;
		return false;
	}
	if (parts[1] !== "missions") return false;
	const id = parts[2];
	if (parts.length === 2) {
		if (method === "GET") return json(res, 200, store.list(url.searchParams.get("projectId") ?? undefined)), true;
		if (method === "POST")
			return json(res, 201, await service.create(await readJson<CreateMissionRequest>(req))), true;
		return false;
	}
	if (!id) return false;
	if (parts.length === 3) {
		if (method === "GET") return json(res, 200, store.detail(id)), true;
		if (method === "PATCH") return json(res, 200, store.update(id, await readJson<UpdateMissionRequest>(req))), true;
		if (method === "DELETE") {
			store.remove(id);
			return json(res, 200, { ok: true }), true;
		}
		return false;
	}
	const section = parts[3];
	const item = parts[4];
	if (section === "coordinator" && item === "start" && parts.length === 5 && method === "POST")
		return (
			json(res, 201, await service.startCoordinator(id, await readJson<StartMissionCoordinatorRequest>(req))), true
		);
	if (section === "brief") {
		if (parts.length === 4 && method === "GET") {
			const value = url.searchParams.get("revision");
			if (value !== null && !/^[1-9]\d*$/.test(value))
				throw new HttpError(400, "revision must be a positive integer");
			const brief = store.brief(id, value === null ? undefined : Number(value));
			if (!brief) throw new HttpError(404, "No brief revision");
			return json(res, 200, brief), true;
		}
		if (parts.length === 4 && method === "PUT") {
			const body = await readJson<MissionBriefWrite>(req);
			return json(res, 200, store.writeBrief(id, body?.markdown, body?.expectedRevision)), true;
		}
		if (parts.length === 5 && item === "revisions" && method === "GET")
			return json(res, 200, store.briefRevisions(id)), true;
		return false;
	}
	if (section === "phases") {
		if (parts.length === 4 && method === "GET") return json(res, 200, store.phases(id)), true;
		if (parts.length === 4 && method === "POST")
			return json(res, 201, store.addPhase(id, await readJson<MissionPhaseWrite>(req))), true;
		if (parts.length === 5 && method === "PATCH")
			return json(res, 200, store.updatePhase(id, item!, await readJson<MissionPhaseWrite>(req))), true;
		if (parts.length === 5 && method === "DELETE") {
			store.removePhase(id, item!);
			return json(res, 200, { ok: true }), true;
		}
		return false;
	}
	if (section === "tasks") {
		if (parts.length === 4 && method === "POST")
			return json(res, 201, await service.addTask(id, await readJson<MissionTaskWrite>(req))), true;
		if (parts.length === 5 && method === "PATCH")
			return json(res, 200, await service.updateTask(id, item!, await readJson<MissionTaskWrite>(req))), true;
		if (parts.length === 5 && method === "DELETE") {
			store.removeTask(id, item!);
			return json(res, 200, { ok: true }), true;
		}
		if (parts.length === 6 && parts[5] === "start" && method === "POST") {
			const body =
				req.headers["content-length"] === "0"
					? {}
					: await readJson<StartMissionTaskRequest>(req).catch((error) => {
							if (error instanceof HttpError && error.status === 415) return {};
							throw error;
						});
			return json(res, 201, await service.startTask(id, item!, body ?? {})), true;
		}
		return false;
	}
	if (section === "decision-proposals") {
		if (parts.length === 6 && method === "POST" && (parts[5] === "accept" || parts[5] === "reject")) {
			const write = await readJson<{ text?: string }>(req);
			return json(res, 200, store.resolveProposal(id, item!, parts[5] === "accept", write?.text)), true;
		}
		return false;
	}
	if (section === "decisions") {
		if (parts.length === 4 && method === "POST") {
			const write = await readJson<MissionDecisionWrite>(req);
			return json(res, 201, store.addDecision(id, write?.text, undefined, write?.audience)), true;
		}
		if (parts.length === 5 && method === "PATCH") {
			const write = await readJson<MissionDecisionWrite>(req);
			return json(res, 200, store.updateDecision(id, item!, write?.text, undefined, write?.audience)), true;
		}
		if (parts.length === 5 && method === "DELETE") {
			store.removeDecision(id, item!);
			return json(res, 200, { ok: true }), true;
		}
		return false;
	}
	if (section === "comments") {
		if (parts.length === 4 && method === "POST")
			return json(res, 201, store.addComment(id, await readJson<MissionCommentWrite>(req))), true;
		if (parts.length === 6 && parts[5] === "resolve" && method === "POST")
			return json(res, 200, store.resolveComment(id, item!)), true;
		if (parts.length === 5 && method === "DELETE") {
			store.removeComment(id, item!);
			return json(res, 200, { ok: true }), true;
		}
		return false;
	}
	if (section === "resources") {
		if (parts.length === 6 && parts[5] === "linear-sync" && method === "POST") {
			const write = await readJson<{ action: "pause" | "resume" }>(req);
			return json(res, 200, store.controlLinearSync(id, item!, write?.action)), true;
		}
		if (parts.length === 4 && method === "POST")
			return json(res, 201, store.addResource(id, await readJson<MissionResourceWrite>(req))), true;
		if (parts.length === 5 && method === "PATCH") {
			json(res, 200, store.updateResource(id, item!, await readJson<MissionResourceUpdate>(req)));
			return true;
		}
		if (parts.length === 5 && method === "DELETE") {
			store.removeResource(id, item!);
			return json(res, 200, { ok: true }), true;
		}
		return false;
	}
	if (section === "artifacts") {
		if (parts.length === 4 && method === "POST")
			return json(res, 201, await service.linkArtifact(id, await readJson<MissionArtifactLinkWrite>(req))), true;
		if (parts.length === 5 && method === "DELETE") {
			store.unlinkArtifact(id, item!, {}, url.searchParams.get("taskId") ?? undefined);
			return json(res, 200, { ok: true }), true;
		}
		return false;
	}
	if (section === "events" && parts.length === 4) {
		if (method === "GET") {
			const before = url.searchParams.get("before");
			if (before !== null && !/^\d+$/.test(before)) throw new HttpError(400, "before must be an event ID");
			return json(res, 200, store.events(id, before === null ? undefined : Number(before))), true;
		}
		if (method === "POST") return json(res, 201, store.log(id, await readJson<MissionEventWrite>(req))), true;
	}
	return false;
}
