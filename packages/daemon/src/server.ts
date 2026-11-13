/** HTTP API and WebSocket event streams. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { RetainedCallQuery } from "@pilot/kernel/retained-calls";
import type {
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
	FailedModelRequest,
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
	QueuedMessageGuard,
	RenameSessionRequest,
	RepositorySelection,
	RetryHandoffRequest,
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
	UsageAnalyticsQuery,
	UsageHistoryQuery,
} from "@pilot/protocol";
import { nodeTelemetry, type TraceCarrier, traceCarrier } from "@pilot/telemetry";
import { type WebSocket, WebSocketServer } from "ws";
import { AttachmentStore } from "./attachment-store.ts";
import type { ReadOnlyAttentionExecutor } from "./attention-executor.ts";
import { createSocketSender } from "./backpressure.ts";
import { RepositoryChanges } from "./changes.ts";
import { type ChatSettingsService, InvalidChatSettings } from "./chat-settings.ts";
import { ChatStreams } from "./chat-streams.ts";
import type { DaemonConfig } from "./config.ts";
import { DatabaseSettingsError } from "./databases.ts";
import { DeliveredArtifacts } from "./delivered-artifact.ts";
import { awaitDiagnosticRead, diagnosticContextResponse } from "./diagnostic-context.ts";
import { EnvironmentApprovalRequired } from "./environment-profile.ts";
import { Conflict, ServiceUnavailable } from "./errors.ts";
import { daemonPerformance, operations } from "./event-loop-watchdog.ts";
import type { GitHubImportService } from "./github-import.ts";
import type { GitHubSetupService } from "./github-setup.ts";
import { GlobalUpdatePreparation } from "./global-update-preparation.ts";
import { dispositionTarget, HumanReviews } from "./human-reviews.ts";
import { InsightsApply } from "./insights-apply.ts";
import { insightsSetupDefaults } from "./insights-defaults.ts";
import { InsightsEnable } from "./insights-enable.ts";
import { InsightsLegacy, type InsightsLegacySelector } from "./insights-legacy.ts";
import { admitInsightsOperation, insightsFindingsPage, isInsightsOperation } from "./insights-native.ts";
import { InsightsOwner, isInsightsOwnerOperation } from "./insights-owner.ts";
import { InsightsReplacement } from "./insights-replacement.ts";
import { InsightsTransition } from "./insights-transition.ts";
import { InsightsWorkspace, isInsightsWorkspaceOperation } from "./insights-workspace.ts";
import { LandedChanges } from "./landed-changes.ts";
import type { LiveUpdate, LiveUpdateIdentity, LiveUpdateService, LiveUpdateTarget } from "./live-update.ts";
import { MachineInformationReader } from "./machine.ts";
import { McpSetupError, McpSetupStore } from "./mcp-setup.ts";
import { type McpStatusService, SignInUnavailable } from "./mcp-status.ts";
import { buildMissionCatalog, type MissionCatalogSources } from "./mission-catalog.ts";
import { parseMissionControl } from "./mission-controls.ts";
import { parseMissionLifecycle } from "./mission-lifecycle.ts";
import type { MissionService } from "./mission-service.ts";
import { isThreadOperation, MissionThreads } from "./mission-threads.ts";
import type { MissionStore } from "./missions.ts";
import { ModelScopeConflictError, ModelScopeSettingsError, modelScopeUpdate } from "./model-scope.ts";
import type { ModelCatalog } from "./models.ts";
import { NativeAttention } from "./native-attention.ts";
import { NativeChat } from "./native-chat.ts";
import { MAX_NATIVE_DIAGNOSTIC_BYTES } from "./native-diagnostics.ts";
import { isIntakeOperation, NativeIntake } from "./native-intake.ts";
import {
	isNativePlanningOperation,
	NativeMissionPlanning,
	PlanningInventoryCapacity,
} from "./native-mission-planning.ts";
import { canonicalJSON, durableJSON, OperationJournal, OperationRejected, payloadHash } from "./operation-journal.ts";
import { isAllowedOrigin } from "./origin.ts";
import { PathCompletionReader } from "./path-completion.ts";
import { PlanningWorkers } from "./planning-workers.ts";
import type { PowerService } from "./power.ts";
import { type DashboardProviders, ProjectDashboardService } from "./project-dashboard.ts";
import type { KnowledgeService } from "./project-knowledge.ts";
import type { ProjectMemoryService } from "./project-memory.ts";
import { AutomationsRevisionConflict, EnvironmentRevisionConflict, expandHome, type ProjectStore } from "./projects.ts";
import { PTY_INPUT_CHUNK } from "./pty-input.ts";
import { RepositoryBrowser } from "./repository-browser.ts";
import { isRetiredDevboxOperation } from "./retired-devboxes.ts";
import { optionalReviewRequests, retainedFeedbackReader } from "./review-request-access.ts";
import { ReviewStore } from "./reviews.ts";
import type { RuntimeContributor } from "./runtime-admission.ts";
import { RuntimeAdmission, RuntimeResources } from "./runtime-admission.ts";
import type { ScheduleService } from "./schedules.ts";
import { CommandRejected, NotFound, type SessionManager } from "./sessions.ts";
import { SetupError, type SetupService } from "./setup.ts";
import { parseSlackMessageLink } from "./slack-format.ts";
import type { SourceRegistry } from "./sources.ts";
import { parseTaskModel } from "./task-model.ts";
import type { TelemetrySettingsService } from "./telemetry-settings.ts";
import { terminalSender } from "./terminal-output.ts";
import type { TerminalManager } from "./terminals.ts";
import { validatePatch } from "./tracked-items.ts";
import { type ReservationReceipt, UpdateReservation } from "./update-reservation.ts";
import { UsageQueryCapacityError } from "./usage-history.ts";
import { usageAnalyticsQuery } from "./usage-history-validation.ts";
import { UserFeedbackService } from "./user-feedback.ts";
import { UserVerifications } from "./user-verification.ts";
import { isWorkflowOperation, WorkflowConfirmations } from "./workflow-confirmations.ts";

/** Native host capability authenticates locally verified updater checkpoints, not agent assertions.
 * The capability holder must validate the signed staged candidate and measured source/GUI build,
 * retain its exact immutable runtime target, and observe the old GUI exit plus the replacement
 * executable/receipt before reporting gui-ready. The daemon validates the durable transaction and
 * process-captured daemon identity. It does not claim to verify native signatures from JSON.
 * Never pass this capability to workers or expose these transitions through session IPC.
 */
export interface RuntimeUpdateIntegration {
	service: LiveUpdateService;
	contributors?: readonly RuntimeContributor[];
}

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

/** How long a mutation may wait for mission durability before pilotd says so in its log. */
const DURABLE_WAIT_WARN_MS = 5_000;

/**
 * Mission writes commit without waiting for the disk, which a worker thread syncs. Hold a mutating request's
 * response until they are durable, so no client sees a write acknowledged that a power loss could undo.
 */
export function acknowledgeWhenDurable(
	res: ServerResponse,
	store: Pick<MissionStore, "durable">,
	skip?: () => boolean,
): void {
	const end = res.end.bind(res) as (...args: unknown[]) => ServerResponse;
	res.end = ((...args: unknown[]) => {
		if (skip?.()) return end(...args);
		// A withheld response looks like an unanswered request. Say so instead of failing silently.
		const timer = setTimeout(() => {
			console.warn("pilotd: mutation response still waiting for mission durability");
		}, DURABLE_WAIT_WARN_MS);
		timer.unref?.();
		store.durable().then(
			() => {
				clearTimeout(timer);
				end(...args);
			},
			(error: unknown) => {
				clearTimeout(timer);
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

async function readJson<T>(req: IncomingMessage, maxBytes = MAX_BODY, allowEmpty = false): Promise<T> {
	if (!req.headers["content-type"]?.startsWith("application/json"))
		throw new HttpError(415, "Expected application/json");
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > maxBytes) throw new HttpError(413, "Request body too large");
		chunks.push(chunk as Buffer);
	}
	// Queue DELETE historically allowed an empty body even with a JSON header.
	if (allowEmpty && size === 0) return undefined as T;
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
	missions?: { service: MissionService; store: MissionStore; knowledge?: KnowledgeService },
	dashboardProviders?: DashboardProviders,
	memory?: ProjectMemoryService,
	schedules?: ScheduleService,
	tracking?: SourceRegistry,
	power?: PowerService,
	mcp?: McpStatusService,
	hello?: DaemonHello,
	setup?: SetupService,
	legacyAdmissionFrozen = false,
	_reserved?: undefined,
	telemetry?: TelemetrySettingsService,
	githubSetup?: GitHubSetupService,
	githubImport?: GitHubImportService,
	catalog?: MissionCatalogSources,
	environment?: import("./environment.ts").EnvironmentService,
	bootstrap?: import("./runtime-owner.ts").RuntimeOwner,
	subscriptions?: import("./subscription-refresh.ts").SubscriptionRefresh,
	chatSettings?: ChatSettingsService,
	liveUpdate?: RuntimeUpdateIntegration,
	attentionExecutor?: ReadOnlyAttentionExecutor,
): Server & {
	runtimeResources: RuntimeResources;
	runtimeReady: Promise<void>;
	recoverOperations(): void;
	closePlanning(): Promise<void>;
} {
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
			const linearSync = missions.store.linearSyncDiagnostics(request.missionId!, offset, limit);
			const more = offset + rows.length < tasks.length || linearSync.more;
			return response(
				{
					mission: missions.store.get(request.missionId!),
					brief: missions.store.brief(request.missionId!),
					tasks: rows,
					linearSync: { ...linearSync, coverage: "Persisted mission sync only, no network fetch" },
				},
				Math.max(rows.length, linearSync.tickets.length),
				more,
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
	const catalogMissions = new Map((missions?.store.list() ?? []).map((mission) => [mission.id, mission]));
	const catalogHost = hello?.lineageId
		? { hostId: "daemon", daemonId: hello.daemonId, lineageId: hello.lineageId }
		: undefined;
	let catalogGroups = catalogHost && missions ? missions.store.catalogSharedContext(catalogHost) : [];
	const catalogSources =
		catalog ??
		(hello?.lineageId
			? {
					host: { hostId: "daemon", daemonId: hello.daemonId, lineageId: hello.lineageId },
					missions: () => [...catalogMissions.values()],
					sharedContext: () => catalogGroups,
				}
			: undefined);
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
			...(schedules
				? {
						scheduled: (id: string) => schedules.dashboard(id),
						scheduledProjects: () => schedules.noticeProjects(),
					}
				: {}),
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
	const pathCompletion = new PathCompletionReader();
	const repositories = new RepositoryBrowser(projects);
	const attachments = new AttachmentStore(_config.home);
	const transfers = new RuntimeAdmission();
	const mutations = new RuntimeAdmission();
	const runtimeSources = [
		terminals,
		attachments,
		sessions,
		transfers,
		mutations,
		...(githubSetup ? [githubSetup] : []),
		...(githubImport ? [githubImport] : []),
		...(setup ? [setup] : []),
		...(attentionExecutor ? [attentionExecutor.maintenance] : []),
	];
	const runtimeResources = new RuntimeResources([...runtimeSources, ...(liveUpdate?.contributors ?? [])]);
	if (bootstrap)
		sessions.bindLifecycleRuntime({
			...bootstrap.identity(),
			...(hello?.lineageId ? { host: { daemonId: hello.daemonId, lineageId: hello.lineageId } } : {}),
		});
	liveUpdate?.service.attach(runtimeResources);
	// Freeze synchronously before loading retained maintenance, before any recovery is admitted.
	const globalUpdate =
		bootstrap && hello?.lineageId
			? new GlobalUpdatePreparation(
					new OperationJournal(join(_config.home, "global-update-operations"), {
						hostId: "daemon",
						daemonId: hello.daemonId,
						lineageId: hello.lineageId,
					}),
					runtimeResources,
					sessions,
				)
			: undefined;
	const runtimeReady = Promise.all([liveUpdate?.service.load(), globalUpdate?.load()]).then(() => undefined);
	let lifecycleInterrupted = false;
	const reservations = new UpdateReservation(
		new RuntimeResources(
			// An app update keeps pilotd running, so paused agents and open terminals need not block it.
			runtimeSources.map((source) =>
				source === sessions
					? {
							freezeAdmissions: () => sessions.freezeAdmissions(),
							blockers: () => sessions.updateReservationBlockers(),
						}
					: source === terminals
						? {
								freezeAdmissions: () => terminals.freezeAdmissions(),
								blockers: () => terminals.admissionBlockers(),
							}
						: source,
			),
		),
		undefined,
		undefined,
		{
			freezeAdmissions: () => {
				const release = runtimeResources.freezeAdmissions();
				return () => {
					release();
					if (lifecycleInterrupted) {
						lifecycleInterrupted = false;
						void sessions.resumeMaintenance().catch((error) => console.warn("pilotd: lifecycle recovery", error));
					}
				};
			},
			blockers: () => runtimeResources.blockers(),
		},
		// Stop/Restart cannot interrupt an unfinished run merely because it paused.
		() => sessions.prepareUpdate().ready,
		async (operationId, purpose, replacement) => {
			// Intent is on disk before the first interrupted tool/job. The native
			// handoff journal separately owns service stop/start and runtime identity.
			await durableJSON(join(_config.home, ".daemon-lifecycle.json"), {
				schema: 1,
				operationId,
				purpose,
				phase: "checkpointing",
			});
			lifecycleInterrupted = true;
			const checkpoints = await Promise.allSettled([
				sessions.checkpointLifecycle(operationId, purpose, replacement),
				terminals.checkpointLifecycle(),
			]);
			const failed = checkpoints.find((result) => result.status === "rejected");
			if (failed?.status === "rejected") {
				// Exact failed attempt evidence, not a quiescence/resume receipt.
				await durableJSON(join(_config.home, ".daemon-lifecycle.json"), {
					schema: 1,
					operationId,
					purpose,
					phase: "refused",
					affectedSessions: sessions.lifecycleManifest(operationId),
				});
				throw failed.reason;
			}
			await durableJSON(join(_config.home, ".daemon-lifecycle.json"), {
				schema: 1,
				operationId,
				purpose,
				phase: "checkpointed",
				affectedSessions: sessions.lifecycleManifest(operationId),
			});
		},
	);
	let coordinatedReservation: { operationId: string; binding: string } | undefined;
	bootstrap?.updates(async (action, value) => {
		await runtimeReady;
		if (!value || typeof value !== "object") throw new Error("update_receipt_invalid");
		if ("globalUpdate" in value) {
			// Existing native owner proof only. Never an agent/session or TSX route.
			// A preparation receipt is not signature/process/replacement authority.
			if (!globalUpdate || Object.keys(value).join() !== "globalUpdate") throw new Conflict("Invalid global update");
			const operation = value.globalUpdate as DurableOperation;
			if (action === "inspect") return (await globalUpdate.lookup(operation)) ?? null;
			if (action === "prepare") return globalUpdate.prepare(operation);
			if (action === "verify") return globalUpdate.verify(operation);
			throw new Conflict("Native verified global update release is not configured");
		}
		if (globalUpdate?.frozen) throw new Conflict("Global update owns admissions; inspect the original operation");
		const receipt = value as ReservationReceipt & {
			liveUpdate?: LiveUpdateTarget & { id: string; guiBuild: string };
		};
		const coordinated = receipt.liveUpdate;
		let binding: string | undefined;
		if (liveUpdate?.service.frozen || coordinated) {
			const update = liveUpdate?.service.snapshot();
			const target = update?.target as (LiveUpdateTarget & { guiBuild: string }) | undefined;
			if (
				!update ||
				!target ||
				!coordinated ||
				Object.keys(coordinated).sort().join(",") !== "build,guiBuild,id,runtimeRoot,source" ||
				coordinated.id !== update.id ||
				coordinated.guiBuild !== update.build ||
				coordinated.guiBuild !== target.guiBuild ||
				coordinated.source !== target.source ||
				coordinated.runtimeRoot !== target.runtimeRoot ||
				!coordinated.build ||
				Object.keys(coordinated.build).sort().join(",") !== Object.keys(target.build).sort().join(",") ||
				Object.entries(target.build).some(
					([key, v]) => coordinated.build[key as keyof typeof target.build] !== v,
				) ||
				!(
					(update.phase === "gui-installing" && receipt.purpose === undefined) ||
					(update.phase === "daemon-installing" && receipt.purpose === "daemon-upgrade")
				)
			)
				throw new Conflict("Coordinated live update reservation does not match durable intent");
			binding = JSON.stringify([update.id, target.source, target.guiBuild, target.runtimeRoot, target.build]);
			if (
				action !== "prepare" &&
				action !== "inspect" &&
				(coordinatedReservation?.operationId !== receipt.operationId || coordinatedReservation.binding !== binding)
			)
				throw new Conflict("Coordinated live update reservation changed");
		}
		if (action === "inspect") return receipt;
		if (action === "prepare") {
			const prepared = await reservations.prepare(
				receipt.operationId,
				receipt.purpose,
				receipt.interrupt,
				receipt.replacement,
			);
			coordinatedReservation = binding ? { operationId: receipt.operationId, binding } : undefined;
			return coordinated ? { ...prepared, liveUpdate: structuredClone(coordinated) } : prepared;
		}
		if (action === "cancel") {
			reservations.cancel(receipt);
			coordinatedReservation = undefined;
			return receipt;
		}
		const verified = reservations.verify(receipt);
		return coordinated ? { ...verified, liveUpdate: structuredClone(coordinated) } : verified;
	});
	if (legacyAdmissionFrozen) runtimeResources.freezeAdmissions();
	const journal = hello?.lineageId
		? new OperationJournal(join(_config.home, "operations"), {
				hostId: "daemon",
				daemonId: hello.daemonId,
				lineageId: hello.lineageId,
			})
		: undefined;
	const admitOperation = async (op: DurableOperation, trace?: TraceCarrier): Promise<unknown> => {
		const end = mutations.begin({ kind: "operation", id: op.operationId });
		try {
			return await admitOperationHeld(op, trace);
		} finally {
			end();
		}
	};
	const feedbackReader = (
		target: Pick<import("@pilot/protocol").ReviewDispositionTarget, "projectId" | "sessionId" | "snapshotId">,
	) => {
		if (!missions) throw new ServiceUnavailable("Retained feedback unavailable");
		return retainedFeedbackReader(missions.store, sessions, projects, target);
	};
	const reviewRequests = missions ? optionalReviewRequests(missions.store, sessions, projects) : undefined;
	const humanReviews = missions
		? new HumanReviews({
				store: missions.store.humanReviews,
				qualify: (target) => feedbackReader(target).qualify(target),
				requirement: (target) => missions.store.reviewRequests.requirement(target),
				// Real required-check/fresh-review producers remain absent. Approve refuses.
			})
		: undefined;
	const workflowConfirmations =
		journal && missions
			? new WorkflowConfirmations({
					store: missions.store,
					journal,
					authorize: (projectId, coordinatorSessionId) => {
						const project = projects.require(projectId);
						const coordinator = sessions.get(coordinatorSessionId);
						if (!coordinator || coordinator.projectId !== projectId || coordinator.archivedAt)
							throw new Conflict("Workflow coordinator project or availability changed");
						return payloadHash(
							canonicalJSON({
								project,
								coordinator: {
									id: coordinatorSessionId,
									projectId: coordinator.projectId,
									mode: coordinator.mode,
									role: coordinator.role,
								},
							}),
						);
					},
					dispositions: humanReviews,
					// No consent configuration, provider executor or review prerequisite producer is installed here.
				})
			: undefined;
	const planningWorkers =
		journal && missions && workflowConfirmations
			? new PlanningWorkers({
					home: _config.home,
					store: missions.store,
					journal,
					projects,
					sessions,
					confirmations: workflowConfirmations,
				})
			: undefined;
	const nativePlanning =
		journal && missions && workflowConfirmations
			? new NativeMissionPlanning({
					store: missions.store,
					journal,
					projects,
					sessions,
					confirmations: workflowConfirmations,
					workers: planningWorkers,
				})
			: undefined;
	const missionThreads =
		journal && missions
			? new MissionThreads({ store: missions.store, journal, projects, sessions, workers: planningWorkers })
			: undefined;
	const nativeIntake =
		journal && tracking
			? new NativeIntake({ journal, tracking, projects, sessions, missions: missions?.store })
			: undefined;
	const nativeChat = journal ? new NativeChat({ journal, projects, sessions }) : undefined;
	const userVerifications =
		journal && missions ? new UserVerifications({ journal, store: missions.store, projects, sessions }) : undefined;
	const userFeedback = missions ? new UserFeedbackService({ store: missions.store, projects, sessions }) : undefined;
	const deliveredArtifacts =
		userVerifications && missions
			? new DeliveredArtifacts({ store: missions.store, projects, sessions, verifications: userVerifications })
			: undefined;
	const nativeAttention =
		journal && missions
			? new NativeAttention({
					home: journal.destination,
					store: missions.store,
					projects,
					sessions,
					journal,
					executor: attentionExecutor,
					// Startup supplies no executor. Dependent-work consumers remain separate adapters.
				})
			: undefined;
	const insightsWorkspace =
		journal && missions && schedules
			? new InsightsWorkspace({
					home: _config.home,
					host: journal.destination,
					projects,
					models,
					store: missions.store.insightsWorkspace,
					journal,
					legacyGuard: () => {
						sessions.assertNoLegacyInsights();
						schedules.assertNoLegacyInsights(journal.destination);
					},
				})
			: undefined;
	const insightsTransition =
		journal &&
		missions?.store.insightsTransition &&
		missions.store.insightsWorkspace &&
		sessions.insightsAdmissionEpoch &&
		schedules
			? new InsightsTransition({
					home: _config.home,
					projects,
					mission: (id) => {
						const m = missions.store.require(id);
						return { projectId: m.projectId, status: m.status };
					},
					workspace: missions.store.insightsWorkspace,
					store: missions.store.insightsTransition,
					journal,
					sessions,
					schedules,
				})
			: undefined;
	const insightsOwner =
		journal && missions?.store.insightsOwner && sessions.insightsAdmissionEpoch && schedules
			? new InsightsOwner({
					home: _config.home,
					projects,
					models,
					workspace: missions.store.insightsWorkspace,
					store: missions.store.insightsOwner,
					transition: insightsTransition,
					sessions,
					schedules,
					journal,
				})
			: undefined;
	const insightsLegacy =
		journal && missions?.store.insightsLegacy
			? new InsightsLegacy({
					home: _config.home,
					host: journal.destination,
					projects,
					sessions,
					journal,
					records: missions.store.insightsLegacy,
					mission: (id) => {
						const m = missions.store.require(id);
						return { projectId: m.projectId, status: m.status };
					},
				})
			: undefined;
	const insightsEnable =
		journal && missions && schedules
			? new InsightsEnable({
					home: _config.home,
					host: journal.destination,
					projects,
					missions: missions.store,
					models,
					sessions,
					schedules,
					journal,
				})
			: undefined;
	const insightsApply =
		journal && missions && schedules && insightsEnable
			? new InsightsApply(
					{
						home: _config.home,
						host: journal.destination,
						projects,
						missions: missions.store,
						models,
						sessions,
						schedules,
						journal,
					},
					insightsEnable,
				)
			: undefined;
	const insightsReplacement =
		journal && missions && schedules
			? new InsightsReplacement({
					home: _config.home,
					host: journal.destination,
					projects,
					missions: missions.store,
					models,
					sessions,
					schedules,
					journal,
				})
			: undefined;
	const admitOperationHeld = async (op: DurableOperation, trace?: TraceCarrier): Promise<unknown> => {
		if (isThreadOperation(op.kind)) {
			if (!missionThreads) throw new Error("Topic lookup unavailable");
			return missionThreads.admit(op, false);
		}
		if (op.kind === "project-preferences-update") throw new Error("Preference outcome is unknown; Check only");
		if (op.kind === "user-feedback") throw new Error("Feedback outcome is unknown; Check only");
		if (op.kind === "user-verification") throw new Error("Verification outcome is unknown; Check only");
		if (op.kind === "attention-answer") {
			if (!nativeAttention) throw new OperationRejected("Native attention unavailable");
			return nativeAttention.answer(op, false);
		}
		if (planningWorkers?.owns(op)) return planningWorkers.recover(op);
		if (op.kind === "native-chat-create") {
			throw new Error("Chat creation outcome is unknown; check its saved receipt");
		}
		if (isIntakeOperation(op.kind)) {
			// Recovery is lookup-only; pending intake effects never enter again.
			throw new Error("Intake outcome is unknown; check its saved receipt");
		}
		if (isNativePlanningOperation(op.kind)) {
			if (!nativePlanning) throw new OperationRejected("Native planning unavailable");
			return nativePlanning.admit(op, false);
		}
		if (op.kind === "insights-workspace-transfer") {
			if (!insightsTransition) throw new OperationRejected("Insights transition unavailable");
			return insightsTransition.admit(op, false);
		}
		if (isInsightsOwnerOperation(op.kind)) {
			if (!insightsOwner) throw new OperationRejected("Owner Insights execution unavailable");
			return insightsOwner.admit(op);
		}
		if (isInsightsWorkspaceOperation(op.kind)) {
			if (!insightsWorkspace) throw new OperationRejected("App-owned Insights workspace unavailable");
			return insightsWorkspace.admit(op);
		}
		if (isInsightsOperation(op.kind)) insightsWorkspace?.assertLegacyAllowed();
		if (isWorkflowOperation(op.kind)) {
			if (!workflowConfirmations) throw new OperationRejected("Workflow confirmations are unavailable");
			return workflowConfirmations.admit(op);
		}
		let payload: unknown;
		try {
			payload = JSON.parse(op.payload);
		} catch {
			throw new OperationRejected("Invalid payload JSON");
		}
		if (!payload || typeof payload !== "object" || Array.isArray(payload))
			throw new OperationRejected("Expected operation object");
		if (op.kind === "insights-replace") {
			if (!insightsReplacement) throw new OperationRejected("Insights replacement is unavailable");
			return insightsReplacement.replace(op, payload as import("@pilot/protocol").InsightsReplacementPayload);
		}
		if (op.kind === "insights-apply") {
			if (!insightsApply) throw new OperationRejected("Insights Apply is unavailable");
			return insightsApply.apply(op, payload as import("@pilot/protocol").InsightsApplyPayload);
		}
		if (op.kind === "insights-settings") {
			if (!insightsEnable) throw new OperationRejected("Insights settings are unavailable");
			return insightsEnable.saveSettings(op, payload as import("@pilot/protocol").InsightsSettingsPayload);
		}
		if (op.kind === "insights-enable") {
			if (!insightsEnable) throw new OperationRejected("Weekly Insights is unavailable");
			return insightsEnable.enable(op, payload as import("@pilot/protocol").InsightsEnablePayload);
		}
		if (isInsightsOperation(op.kind)) {
			if (!missions) throw new OperationRejected("Insights is unavailable");
			return admitInsightsOperation(sessions, missions.store.insights, op, payload as Record<string, unknown>);
		}
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
			const request = payload as SendRequest & { questionReplyId?: number; inputGeneration?: number };
			if (
				typeof request.message !== "string" ||
				!request.message.trim() ||
				(request.mode !== undefined && request.mode !== "steer" && request.mode !== "followUp") ||
				(request.questionReplyId !== undefined &&
					(!Number.isSafeInteger(request.questionReplyId) || request.questionReplyId <= 0)) ||
				(request.inputGeneration !== undefined &&
					(!Number.isSafeInteger(request.inputGeneration) || request.inputGeneration < 0))
			)
				throw new OperationRejected("Invalid message");
			try {
				await sessions.sendDurable(op.targetId, request.message, request.mode ?? "followUp", op.operationId, {
					explicitModelRecovery: true,
					trace,
					questionReplyId: request.questionReplyId,
					inputGeneration: request.inputGeneration,
				});
			} catch (error) {
				if (
					error instanceof CommandRejected &&
					(error.code === "stale_question" || (error.code === "stopped" && request.inputGeneration !== undefined))
				)
					throw new OperationRejected(error.message);
				throw error;
			}
			return { sessionId: op.targetId };
		}
		throw new OperationRejected("Unsupported operation kind");
	};
	// Only registered idempotent handlers resume. An interrupted handler always retains the same target.
	let operationRecovery: Promise<void> | undefined;
	const recoverOperations = () => {
		if (
			journal &&
			!operationRecovery &&
			!legacyAdmissionFrozen &&
			!liveUpdate?.service.frozen &&
			!globalUpdate?.frozen
		)
			operationRecovery = journal
				.recover(admitOperation, (op) => !isRetiredDevboxOperation(op.kind))
				.catch((error) => console.warn("pilotd: operation recovery", error))
				.finally(() => {
					operationRecovery = undefined;
				});
	};
	// The startup owner calls recovery only after session metadata has loaded.
	if (!liveUpdate) recoverOperations();
	let checkpointPending: Promise<unknown> = Promise.resolve();
	let checkpointQueued = 0;
	const nativeCheckpoint = <T>(work: () => Promise<T>): Promise<T> => {
		if (checkpointQueued >= 16) throw new ServiceUnavailable("Native update checkpoints are busy");
		checkpointQueued++;
		const result = checkpointPending.then(work).finally(() => {
			checkpointQueued--;
		});
		checkpointPending = result.catch(() => undefined);
		return result;
	};
	const route = async (req: IncomingMessage, res: ServerResponse) => {
		if (!isAllowedOrigin(req.headers.origin)) throw new HttpError(403, "Browser requests are not allowed");
		const url = new URL(req.url ?? "/", "http://localhost");
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts[0] !== "api") throw new HttpError(404, "Not found");
		if (parts[1] === "native-attention" && req.method === "POST" && parts.length <= 3) {
			res.setHeader("cache-control", "no-store");
			if (!githubSetup || !nativeAttention) throw new ServiceUnavailable("Native attention unavailable");
			await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
			if (parts.length === 3 && parts[2] !== "receipt") throw new HttpError(404, "Not found");
			const end = mutations.begin({ kind: "operation", id: "native-attention" });
			try {
				const answer = await nativeAttention.dispatch(await readJson(req), parts[2] === "receipt");
				await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
				return json(res, 200, answer);
			} finally {
				end();
			}
		}
		if (parts[1] === "runtime-update") {
			res.setHeader("cache-control", "no-store");
			if (!githubSetup || !liveUpdate) throw new ServiceUnavailable("Coordinated live update is unavailable");
			await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
			await runtimeReady;
			if (parts.length === 2 && req.method === "GET")
				return json(res, 200, { update: liveUpdate.service.snapshot(), frozen: liveUpdate.service.frozen });
			if (parts.length !== 3 || req.method !== "POST") throw new HttpError(404, "Not found");
			const body = await readJson<{
				id: string;
				phase: LiveUpdate["phase"];
				target?: LiveUpdateTarget;
				receipt?: LiveUpdateIdentity;
			}>(req, 8192);
			const action = parts[2];
			const expectedKeys =
				action === "arm-gui" ? "id,phase,target" : action === "gui-ready" ? "id,phase,receipt" : "id,phase";
			if (
				!body ||
				typeof body !== "object" ||
				Array.isArray(body) ||
				Object.keys(body).sort().join(",") !== expectedKeys ||
				typeof body.id !== "string" ||
				!/^[a-zA-Z0-9._:-]{1,128}$/u.test(body.id) ||
				typeof body.phase !== "string"
			)
				throw new HttpError(400, "Expected exact native update checkpoint");
			return nativeCheckpoint(async () => {
				const service = liveUpdate.service;
				const update = service.snapshot();
				if (!update || update.id !== body.id || update.phase !== body.phase)
					throw new Conflict("Live update changed");
				if (action === "accept") return json(res, 200, await service.accept(body.id));
				if (action === "progress") return json(res, 200, await service.progress(body.id));
				if (action === "cancel") return json(res, 200, await service.cancel(body.id));
				if (action === "arm-daemon") return json(res, 200, await service.armDaemon(body.id));
				if (action === "complete") return json(res, 200, await service.complete(body.id));
				// Only the native capability holder may report checkpoints. The native updater
				// verifies signatures and measured executable identity before sending these fields.
				// TypeScript validates their exact transaction binding; it does not verify a signature.
				if (action === "arm-gui") return json(res, 200, await service.armGui(body.id, body.target!));
				if (action === "gui-ready") return json(res, 200, await service.guiReady(body.id, body.receipt!));
				throw new HttpError(404, "Not found");
			});
		}
		if (parts[1] === "subscription-usage") {
			res.setHeader("cache-control", "no-store");
			if (!subscriptions || !hello?.lineageId) throw new ServiceUnavailable("Subscription refresh unsupported");
			if (
				url.searchParams.get("daemonId") !== hello.daemonId ||
				url.searchParams.get("lineageId") !== hello.lineageId
			)
				throw new HttpError(409, "Host identity changed");
			if (parts.length === 2 && req.method === "GET") return json(res, 200, subscriptions.snapshot());
			if (parts.length === 3 && parts[2] === "refresh" && req.method === "POST") {
				const provider = url.searchParams.get("provider");
				if (provider !== "anthropic" && provider !== "openai")
					throw new HttpError(400, "Invalid subscription provider");
				return json(res, 200, await subscriptions.refresh(provider));
			}
			throw new HttpError(404, "Not found");
		}
		if (parts[1] === "usage-history") {
			res.setHeader("cache-control", "no-store");
			if (req.method !== "GET" || parts.length !== 3 || !["query", "page"].includes(parts[2]!))
				throw new HttpError(404, "Not found");
			if (!hello?.lineageId || hello.capabilities.usageQueries !== 1)
				throw new ServiceUnavailable("Usage queries unsupported");
			if (
				url.searchParams.get("daemonId") !== hello.daemonId ||
				url.searchParams.get("lineageId") !== hello.lineageId
			)
				throw new HttpError(409, "Host identity changed");
			const raw = url.searchParams.get("query");
			if (!raw || Buffer.byteLength(raw) > 4096) throw new HttpError(400, "Invalid usage query");
			let query: UsageAnalyticsQuery | UsageHistoryQuery;
			try {
				query = JSON.parse(raw);
			} catch {
				throw new HttpError(400, "Invalid usage query");
			}
			if (parts[2] === "query") {
				const canonical = usageAnalyticsQuery(query);
				return json(res, 200, await sessions.usageHistory.analytics(canonical));
			}
			return json(res, 200, await sessions.usageHistory.page(query as UsageHistoryQuery));
		}
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
		if (parts[1] === "sessions" && parts.length === 4 && parts[3] === "path-candidates" && req.method === "GET") {
			if (!hello?.lineageId) throw new ServiceUnavailable("Path completion identity unavailable");
			if (
				url.searchParams.get("daemonId") !== hello.daemonId ||
				url.searchParams.get("lineageId") !== hello.lineageId
			)
				throw new Conflict("Path completion daemon identity changed");
			const id = parts[2]!;
			const expected = url.searchParams.get("cwd") ?? "";
			const prefix = url.searchParams.get("prefix") ?? "";
			const cwd = sessions.pathCompletionRoot(id, expected);
			const result = await pathCompletion.read(cwd, prefix);
			if (sessions.pathCompletionRoot(id, expected) !== cwd) throw new Conflict("Path completion workspace changed");
			res.setHeader("cache-control", "no-store");
			return json(res, 200, {
				...result,
				sessionId: id,
				cwd,
				prefix,
				daemonId: hello.daemonId,
				lineageId: hello.lineageId,
			});
		}
		if (parts[1] === "sessions" && parts.length === 4 && parts[3] === "files" && req.method === "GET") {
			const session = sessions.get(parts[2]!);
			if (!session) throw new NotFound("Unknown session");
			return json(res, 200, await repositories.file(session.cwd, url.searchParams.get("path") ?? ""));
		}
		if (parts[1] === "insights" && parts[2] === "legacy") {
			res.setHeader("cache-control", "no-store");
			if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
			if (!insightsLegacy || !githubSetup) throw new ServiceUnavailable("Legacy Insights projection unavailable");
			await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
			for (const key of url.searchParams.keys())
				if (!["selector", "cursor"].includes(key) || url.searchParams.getAll(key).length !== 1)
					throw new HttpError(400, "Invalid legacy query");
			if (parts.length !== 4 || !["reports", "findings", "checkpoints", "settings"].includes(parts[3]!))
				throw new HttpError(404, "Not found");
			let selector: InsightsLegacySelector;
			try {
				selector = JSON.parse(url.searchParams.get("selector") ?? "null");
			} catch {
				throw new HttpError(400, "Invalid legacy selector");
			}
			const raw = url.searchParams.get("cursor") ?? "0",
				cursor = Number(raw);
			if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(cursor)) throw new HttpError(400, "Invalid legacy cursor");
			const kind =
				parts[3] === "reports"
					? "report"
					: parts[3] === "findings"
						? "finding"
						: parts[3] === "checkpoints"
							? "checkpoint"
							: "settings";
			return json(res, 200, await insightsLegacy.page(selector, kind, cursor));
		}
		if (parts[1] === "insights" && parts[2] === "workspace" && parts[3] === "transfer") {
			res.setHeader("cache-control", "no-store");
			if (!insightsTransition || !journal || !githubSetup)
				throw new ServiceUnavailable("Insights transition unavailable");
			await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
			if (parts.length !== 5 || !["preflight", "check"].includes(parts[4]!)) throw new HttpError(404, "Not found");
			if (parts[4] === "check") {
				if (req.method !== "POST" || [...url.searchParams.keys()].length)
					throw new HttpError(400, "Expected exact transfer Check");
				const op = await readJson<DurableOperation>(req);
				await journal.lookup(op);
				return json(res, 200, await insightsTransition.check(op));
			}
			if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
			for (const key of url.searchParams.keys())
				if (key !== "selector" || url.searchParams.getAll(key).length !== 1)
					throw new HttpError(400, "Expected exact legacy selector");
			let selector: InsightsLegacySelector;
			try {
				selector = JSON.parse(url.searchParams.get("selector") ?? "null");
			} catch {
				throw new HttpError(400, "Invalid legacy selector");
			}
			return json(res, 200, await insightsTransition.preview(selector));
		}
		if (parts[1] === "insights" && parts[2] === "workspace" && parts[3] === "execution") {
			res.setHeader("cache-control", "no-store");
			if (!insightsOwner || !insightsWorkspace || !journal || !githubSetup)
				throw new ServiceUnavailable("Owner Insights execution unavailable");
			await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
			if ([...url.searchParams.keys()].length) throw new HttpError(400, "Execution queries must be exact");
			if (parts.length === 5 && parts[4] === "check") {
				if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
				const op = await readJson<DurableOperation>(req);
				if (!isInsightsOwnerOperation(op.kind)) throw new HttpError(400, "Expected owner operation");
				await journal.lookup(op); // Validate the original envelope, never execute or settle it.
				return json(res, 200, await insightsOwner.check(op));
			}
			if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
			if (
				parts.length > 5 ||
				(parts.length === 5 &&
					!["preflight", "apply-preflight", "pause-preflight", "revoke-preflight"].includes(parts[4]!))
			)
				throw new HttpError(404, "Not found");
			const workspace = await insightsWorkspace.status();
			if (!workspace.workspace)
				return json(res, 200, {
					schemaVersion: 2,
					state: workspace.state,
					reason: workspace.reason,
					execution: null,
				});
			const owner = workspace.workspace.owner;
			try {
				if (parts.length === 4) return json(res, 200, await insightsOwner.status(owner));
				const payload =
					parts[4] === "preflight"
						? await insightsOwner.preview(owner)
						: parts[4] === "apply-preflight"
							? await insightsOwner.previewApply(owner)
							: await insightsOwner.previewState(owner, parts[4] === "pause-preflight" ? "pause" : "revoke");
				return json(res, 200, { schemaVersion: 2, state: "ready", payload, reason: null });
			} catch (error) {
				return json(res, 200, {
					schemaVersion: 2,
					state: error instanceof Conflict || error instanceof NotFound ? "blocked" : "unavailable",
					reason: error instanceof Error ? error.message : "execution_unavailable",
					payload: null,
				});
			}
		}
		if (parts[1] === "insights" && parts[2] === "workspace") {
			res.setHeader("cache-control", "no-store");
			if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
			if (!insightsWorkspace) throw new ServiceUnavailable("App-owned Insights workspace unavailable");
			const route = parts[3];
			const allowed =
				route === "preflight"
					? ["projectId", "model", "thinking"]
					: (route === "reports" || route === "findings") &&
							(parts.length === 4 || (parts.length === 6 && parts[5] === "history"))
						? ["cursor"]
						: [];
			for (const key of url.searchParams.keys())
				if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1)
					throw new HttpError(400, "Invalid workspace query");
			if (parts.length === 3) return json(res, 200, await insightsWorkspace.status());
			if (parts.length === 4 && route === "preflight")
				return json(
					res,
					200,
					await insightsWorkspace.preflight(
						url.searchParams.get("projectId") ?? undefined,
						url.searchParams.get("model") ?? undefined,
						url.searchParams.get("thinking") ?? undefined,
					),
				);
			if (parts.length === 4 && route === "settings") return json(res, 200, await insightsWorkspace.settings());
			if (route === "reports" || route === "findings") {
				const kind = route === "reports" ? "report" : "finding";
				if (parts.length === 5) return json(res, 200, await insightsWorkspace.item(kind, parts[4]!));
				const raw = url.searchParams.get("cursor") ?? "0",
					cursor = Number(raw);
				if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(cursor))
					throw new HttpError(400, "Invalid workspace cursor");
				if (parts.length === 4) return json(res, 200, await insightsWorkspace.page(kind, cursor));
				if (parts.length === 6 && parts[5] === "history")
					return json(res, 200, await insightsWorkspace.history(kind, parts[4]!, cursor));
			}
			throw new HttpError(404, "Not found");
		}
		if (parts[1] === "insights" && parts[2] === "replacement" && parts.length === 4) {
			res.setHeader("cache-control", "no-store");
			if (!insightsReplacement) throw new ServiceUnavailable("Insights replacement is unavailable");
			if (parts[3] === "preflight") {
				if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
				const projectId = url.searchParams.get("projectId"),
					missionId = url.searchParams.get("missionId"),
					oldId = url.searchParams.get("reportSessionId");
				if (!projectId || !missionId || !oldId)
					throw new HttpError(400, "projectId, missionId and reportSessionId are required");
				return json(
					res,
					200,
					await insightsReplacement.preview(
						projectId,
						missionId,
						oldId,
						url.searchParams.get("model") ?? undefined,
						url.searchParams.get("thinking") ?? undefined,
					),
				);
			}
			if (parts[3] === "status") {
				if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
				const op = await readJson<DurableOperation>(req);
				if (op.kind !== "insights-replace") throw new HttpError(400, "Expected insights-replace operation");
				return json(res, 200, await insightsReplacement.status(op));
			}
			throw new HttpError(404, "Not found");
		}
		if (parts[1] === "insights" && parts[2] === "enable" && parts.length === 4) {
			res.setHeader("cache-control", "no-store");
			if (!insightsEnable) throw new ServiceUnavailable("Weekly Insights is unavailable");
			if (parts[3] === "preflight") {
				if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
				const projectId = url.searchParams.get("projectId");
				const missionId = url.searchParams.get("missionId");
				if (!projectId || !missionId) throw new HttpError(400, "projectId and missionId are required");
				return json(
					res,
					200,
					await insightsEnable.preflight(
						projectId,
						missionId,
						url.searchParams.get("model") ?? undefined,
						url.searchParams.get("thinking") ?? undefined,
						undefined,
						url.searchParams.get("reportSessionId") ?? undefined,
					),
				);
			}
			if (parts[3] === "status") {
				if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
				const op = await readJson<DurableOperation>(req);
				if (op.kind !== "insights-enable") throw new HttpError(400, "Expected insights-enable operation");
				return json(res, 200, await insightsEnable.status(op));
			}
			throw new HttpError(404, "Not found");
		}
		if (parts[1] === "insights" && parts[2] === "defaults" && parts.length === 3) {
			res.setHeader("cache-control", "no-store");
			if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
			const projectId = url.searchParams.get("projectId");
			if (!projectId) throw new HttpError(400, "projectId is required");
			const project = projects.require(projectId);
			return json(res, 200, await insightsSetupDefaults(project.id, project.path, models));
		}
		if (parts[1] === "insights" && parts[2] === "sessions") {
			res.setHeader("cache-control", "no-store");
			if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
			if (parts.length !== 4 && !(parts.length === 5 && ["findings", "settings", "apply"].includes(parts[4]!)))
				throw new HttpError(404, "Not found");
			const id = parts[3]!;
			const status = sessions.insightsStatus(id);
			if (!status) return json(res, 404, { error: "not_insights" });
			if (parts.length === 4) return json(res, 200, status);
			if (parts[4] === "apply") {
				if (!insightsApply) throw new ServiceUnavailable("Insights Apply is unavailable");
				return json(res, 200, await insightsApply.preflight(id));
			}
			if (parts[4] === "settings") {
				if (!insightsEnable) throw new ServiceUnavailable("Insights settings are unavailable");
				return json(res, 200, await insightsEnable.settings(id));
			}
			const rawCursor = url.searchParams.get("cursor") ?? "0";
			const cursor = Number(rawCursor);
			if (!/^\d+$/u.test(rawCursor) || !Number.isSafeInteger(cursor))
				throw new HttpError(400, "Invalid findings cursor");
			if (!missions) return json(res, 409, { error: "insights_unavailable" });
			try {
				return json(res, 200, await insightsFindingsPage(sessions, missions.store.insights, id, cursor));
			} catch (error) {
				if (error instanceof Conflict || error instanceof NotFound)
					return json(res, 409, { error: "insights_unavailable" });
				throw error;
			}
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
			const operation = await readJson<DurableOperation>(req);
			if (operation?.kind === "attention-answer") {
				res.setHeader("cache-control", "no-store");
				if (!githubSetup || !nativeAttention) throw new ServiceUnavailable("Native attention unavailable");
				await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
				if (parts.length === 3 && parts[2] !== "receipt") throw new HttpError(404, "Not found");
				const saved = await nativeAttention.lookupAnswer(operation);
				if (parts[2] === "receipt") return json(res, 200, saved ?? { state: "unknown" });
				const end = mutations.begin({ kind: "operation", id: operation.operationId });
				try {
					return json(
						res,
						200,
						await journal.execute(operation, (op, entry) => nativeAttention.answer(op, entry.firstEntry)),
					);
				} finally {
					end();
				}
			}
			if (operation?.kind === "planning-enroll") {
				if (!githubSetup || !planningWorkers)
					throw new ServiceUnavailable("Planning worker enrollment unavailable");
				await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
				if (parts.length === 3 && parts[2] !== "receipt") throw new HttpError(404, "Not found");
				const saved = await journal.lookup(operation);
				if (parts[2] === "receipt") return json(res, 200, saved ?? { state: "unknown" });
				const end = mutations.begin({ kind: "operation", id: operation.operationId });
				try {
					return json(
						res,
						200,
						await journal.execute(operation, (op, entry) => planningWorkers.enroll(op, entry.firstEntry)),
					);
				} finally {
					end();
				}
			}
			if (operation?.kind === "project-preferences-update") {
				res.setHeader("cache-control", "no-store");
				const preferences = missions?.knowledge?.preferences;
				if (!githubSetup || !preferences) throw new ServiceUnavailable("Native project preferences unavailable");
				await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
				if (parts.length === 3 && parts[2] !== "receipt") throw new HttpError(404, "Not found");
				const saved = await journal.lookup(operation);
				if (parts[2] === "receipt") return json(res, 200, saved ?? { state: "unknown" });
				const end = mutations.begin({ kind: "operation", id: operation.operationId });
				try {
					return json(
						res,
						200,
						await journal.execute(operation, (op, entry) =>
							preferences.admitNative(op, journal, entry.firstEntry),
						),
					);
				} finally {
					end();
				}
			}
			if (operation?.kind === "user-feedback") {
				res.setHeader("cache-control", "no-store");
				if (!githubSetup || !userFeedback) throw new ServiceUnavailable("User feedback unavailable");
				await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
				if (parts.length === 3 && parts[2] !== "receipt") throw new HttpError(404, "Not found");
				const saved = await journal.lookup(operation);
				if (parts[2] === "receipt") return json(res, 200, saved ?? { state: "unknown" });
				const end = mutations.begin({ kind: "operation", id: operation.operationId });
				try {
					return json(
						res,
						200,
						await journal.execute(operation, (op, entry) =>
							userFeedback.admitNative(op, journal, entry.firstEntry),
						),
					);
				} finally {
					end();
				}
			}
			if (operation?.kind === "user-verification") {
				res.setHeader("cache-control", "no-store");
				if (!githubSetup || !userVerifications) throw new ServiceUnavailable("User verification unavailable");
				await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
				if (parts.length === 3 && parts[2] !== "receipt") throw new HttpError(404, "Not found");
				const saved = await userVerifications.lookup(operation);
				if (parts[2] === "receipt") return json(res, 200, saved);
				const end = mutations.begin({ kind: "operation", id: operation.operationId });
				try {
					await journal.execute(operation, (op, entry) => userVerifications.admit(op, entry.firstEntry));
					return json(res, 200, await userVerifications.lookup(operation));
				} finally {
					end();
				}
			}
			if (operation?.kind === "native-chat-create") {
				res.setHeader("cache-control", "no-store");
				if (!githubSetup || !nativeChat) throw new ServiceUnavailable("Native chat creation unavailable");
				await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
				if (parts.length === 3 && parts[2] !== "receipt") throw new HttpError(404, "Not found");
				const saved = await nativeChat.lookup(operation);
				if (parts[2] === "receipt") return json(res, 200, saved ?? { state: "unknown" });
				const end = mutations.begin({ kind: "operation", id: operation.operationId });
				try {
					return json(
						res,
						200,
						await journal.execute(operation, (op, entry) => nativeChat.admit(op, entry.firstEntry)),
					);
				} finally {
					end();
				}
			}
			if (isIntakeOperation(operation?.kind)) {
				res.setHeader("cache-control", "no-store");
				if (!githubSetup || !nativeIntake) throw new ServiceUnavailable("Native intake unavailable");
				await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
				if (parts.length === 3 && parts[2] !== "receipt") throw new HttpError(404, "Not found");
				const saved = await nativeIntake.lookup(operation);
				if (parts[2] === "receipt") return json(res, 200, saved ?? { state: "unknown" });
				const end = mutations.begin({ kind: "operation", id: operation.operationId });
				try {
					return json(
						res,
						200,
						await journal.execute(operation, (op, entry) => nativeIntake.admit(op, entry.firstEntry)),
					);
				} finally {
					end();
				}
			}
			if (isThreadOperation(operation?.kind)) {
				res.setHeader("cache-control", "no-store");
				if (!githubSetup || !missionThreads) throw new ServiceUnavailable("Native topics unavailable");
				await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
				if (parts.length === 3 && parts[2] !== "receipt") throw new HttpError(404, "Not found");
				const saved = await missionThreads.lookup(operation);
				if (parts[2] === "receipt") return json(res, 200, saved ?? { state: "unknown" });
				const end = mutations.begin({ kind: "operation", id: operation.operationId });
				try {
					const receipt = await journal.execute(operation, (op, entry) =>
						missionThreads.admit(op, entry.firstEntry),
					);
					await missionThreads.lookup(operation);
					return json(res, 200, receipt);
				} finally {
					end();
				}
			}
			if (isNativePlanningOperation(operation?.kind)) {
				res.setHeader("cache-control", "no-store");
				if (!githubSetup || !nativePlanning) throw new ServiceUnavailable("Native planning unavailable");
				await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
				if (parts.length === 3 && parts[2] !== "receipt") throw new HttpError(404, "Not found");
				// Requalify reads, including terminal duplicates. No unauthenticated receipt escape.
				const saved = await nativePlanning.lookup(operation);
				if (parts[2] === "receipt") return json(res, 200, saved ?? { state: "unknown" });
				const end = mutations.begin({ kind: "operation", id: operation.operationId });
				try {
					const receipt = await journal.execute(operation, (op, entry) =>
						nativePlanning.admit(op, entry.firstEntry),
					);
					await nativePlanning.lookup(operation);
					return json(res, 200, receipt);
				} finally {
					end();
				}
			}
			if (operation?.kind === "insights-workspace-transfer" && parts[2] === "receipt") {
				if (!githubSetup) throw new ServiceUnavailable("Native transfer lookup unavailable");
				await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
			}
			if (operation?.kind === "review-disposition") {
				res.setHeader("cache-control", "no-store");
				// Check and duplicate lookup must not expose inaccessible feedback through a journal receipt.
				if (!githubSetup || !humanReviews) throw new ServiceUnavailable("Native feedback is unavailable");
				await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
				await humanReviews.lookup(operation);
			}
			if (parts[2] !== "receipt" && typeof operation?.kind === "string" && isRetiredDevboxOperation(operation.kind))
				throw new HttpError(410, "Remote devbox operations are retired; stored receipts are retained");
			if (
				(operation?.kind === "repair-create" ||
					isInsightsOperation(operation?.kind) ||
					isInsightsWorkspaceOperation(operation?.kind) ||
					isInsightsOwnerOperation(operation?.kind) ||
					operation?.kind === "insights-workspace-transfer" ||
					isWorkflowOperation(operation?.kind)) &&
				parts[2] !== "receipt"
			) {
				if (!githubSetup) throw new ServiceUnavailable("Native repair confirmation is unavailable");
				await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
			}
			if (parts.length === 3 && parts[2] !== "receipt") throw new HttpError(404, "Not found");
			if (parts[2] !== "receipt" && isInsightsOperation(operation?.kind)) insightsWorkspace?.assertLegacyAllowed();
			const receipt =
				parts[2] === "receipt"
					? await journal.lookup(operation)
					: await journal.execute(operation, async (op, entry) => {
							if (isInsightsOwnerOperation(op.kind)) {
								if (!insightsOwner) throw new OperationRejected("Owner Insights execution unavailable");
								const end = mutations.begin({ kind: "operation", id: op.operationId });
								try {
									return await insightsOwner.admit(op, entry.firstEntry);
								} finally {
									end();
								}
							}
							if (op.kind === "insights-workspace-transfer") {
								if (!insightsTransition) throw new OperationRejected("Insights transition unavailable");
								const end = mutations.begin({ kind: "operation", id: op.operationId });
								try {
									return await insightsTransition.admit(op, entry.firstEntry);
								} finally {
									end();
								}
							}
							if (isWorkflowOperation(op.kind)) {
								if (!workflowConfirmations)
									throw new OperationRejected("Workflow confirmations are unavailable");
								const end = mutations.begin({ kind: "operation", id: op.operationId });
								try {
									return await workflowConfirmations.admit(op, entry.firstEntry);
								} finally {
									end();
								}
							}
							return admitOperation(op, traceCarrier({ traceparent: req.headers.traceparent }));
						});
			if (operation.kind === "review-disposition" && receipt?.state === "accepted") {
				const exact = await humanReviews!.lookup(operation);
				if (!exact || canonicalJSON(exact) !== canonicalJSON(receipt.result))
					return json(res, 200, { state: "unknown" });
			}
			res.setHeader("cache-control", "no-store");
			return json(res, 200, receipt ?? { state: "unknown" });
		}
		if (parts[1] === "review" && parts[2] === "requests") {
			res.setHeader("cache-control", "no-store");
			if (!reviewRequests) throw new ServiceUnavailable("Authoritative Review requests unavailable");
			const after = () => {
				const raw = url.searchParams.get("after") ?? "0",
					n = Number(raw);
				if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n)) throw new HttpError(400, "Invalid request cursor");
				return n;
			};
			if (req.method === "GET" && parts.length === 3) {
				for (const key of url.searchParams.keys())
					if (!["after", "sessionId"].includes(key) || url.searchParams.getAll(key).length !== 1)
						throw new HttpError(400, "Only exact sessionId and after filters are supported");
				return json(res, 200, await reviewRequests.page(after(), url.searchParams.get("sessionId") ?? undefined));
			}
			if (req.method === "GET" && parts.length === 5 && parts[4] === "history")
				return json(res, 200, await reviewRequests.history(parts[3]!, after()));
			// Purpose-specific native actions reuse the existing Local app capability. Neither
			// a body actor nor the ordinary mission REST API can impersonate a native user.
			if (!githubSetup) throw new ServiceUnavailable("Native Review request actions unavailable");
			await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
			const actor = { kind: "native-user" as const };
			if (req.method === "GET" && parts.length === 5 && parts[3] === "operations")
				return json(res, 200, (await reviewRequests.lookup(parts[4]!, actor)) ?? { state: "unknown" });
			if (req.method === "POST" && parts.length === 4 && parts[3] === "suggest")
				return json(res, 200, await reviewRequests.suggest(actor, await readJson(req, 16 * 1024)));
			if (req.method === "POST" && parts.length === 4 && ["withdraw", "snooze", "resume"].includes(parts[3]!))
				return json(
					res,
					200,
					await reviewRequests.transition(
						actor,
						parts[3] as "withdraw" | "snooze" | "resume",
						await readJson(req, 8192),
					),
				);
			throw new HttpError(404, "Not found");
		}
		if (parts[1] === "review-feedback") {
			res.setHeader("cache-control", "no-store");
			if (!humanReviews || !githubSetup) throw new ServiceUnavailable("Native feedback is unavailable");
			await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
			if (parts.length === 3 && parts[2] === "target" && req.method === "POST") {
				const input = await readJson<{ projectId: string; sessionId: string; snapshotId: string }>(req, 1024);
				if (!input || Object.keys(input).sort().join(",") !== "projectId,sessionId,snapshotId")
					throw new HttpError(400, "Invalid target selection");
				const reader = feedbackReader(input);
				await missions!.store.durable();
				return json(res, 200, dispositionTarget(input.projectId, await reader.get(input.snapshotId)));
			}
			if (parts.length === 3 && parts[2] === "prepare" && req.method === "POST")
				return json(res, 200, await humanReviews.prepare(await readJson(req, 64 * 1024)));
			if (parts.length === 4 && parts[2] === "drafts") {
				if (req.method === "GET") return json(res, 200, (await humanReviews.draft(parts[3]!)) ?? null);
				if (req.method === "PUT") {
					const input = await readJson<{
						expectedRevision: number;
						content: import("@pilot/protocol").HumanReviewContent;
					}>(req, 64 * 1024);
					if (!input || Object.keys(input).sort().join(",") !== "content,expectedRevision")
						throw new HttpError(400, "Invalid draft fields");
					return json(res, 200, await humanReviews.saveDraft(parts[3]!, input.expectedRevision, input.content));
				}
			}
			if (parts.length === 3 && parts[2] === "history" && req.method === "POST") {
				const input = await readJson<{ target: import("@pilot/protocol").ReviewDispositionTarget; after: number }>(
					req,
					16 * 1024,
				);
				if (!input || Object.keys(input).sort().join(",") !== "after,target")
					throw new HttpError(400, "Invalid feedback query fields");
				return json(res, 200, await humanReviews.history(input.target, input.after));
			}
			if (parts.length === 5 && parts[2] === "annotations" && parts[4] === "projection" && req.method === "POST") {
				const input = await readJson<{ target: import("@pilot/protocol").ReviewDispositionTarget }>(req, 4096);
				if (!input || Object.keys(input).join(",") !== "target")
					throw new HttpError(400, "Invalid projection query");
				return json(res, 200, await humanReviews.projectAnnotation(parts[3]!, input.target));
			}
			throw new HttpError(404, "Not found");
		}
		if (parts[1] === "hello" && parts.length === 2) {
			if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
			if (!hello) throw new ServiceUnavailable("Daemon handshake is unavailable");
			res.setHeader("cache-control", "no-store");
			return json(res, 200, {
				...hello,
				capabilities: {
					...hello.capabilities,
					questionReplies: 1,
					durableInputGeneration: 1,
					insights: missions && githubSetup && hello.lineageId ? 1 : undefined,
					insightsEnable: insightsEnable && githubSetup ? 1 : undefined,
					insightsSettings: insightsEnable && githubSetup ? 1 : undefined,
					insightsApply: insightsApply && githubSetup ? 1 : undefined,
					insightsReplacement: insightsReplacement && githubSetup ? 1 : undefined,
					insightsWorkspace: insightsWorkspace && githubSetup ? 2 : undefined,
					insightsWorkspaceExecution: insightsOwner && githubSetup ? 2 : undefined,
					insightsWorkspaceTransition: insightsTransition && githubSetup ? 2 : undefined,
					automations: chatSettings?.automationsEnabled() ? 1 : undefined,
					guardedMissionConversion: missions ? true : undefined,
					passiveMissionLifecycle: missions ? true : undefined,
					passiveMissionCompletion: missions ? true : undefined,
					passiveTaskModel: missions ? true : undefined,
					dayOverview: missions ? 1 : undefined,
					missionControls: missions && githubSetup && hello.lineageId ? 1 : undefined,
					nativePlanning: nativePlanning && githubSetup ? 1 : undefined,
					nativeThreads: missionThreads && githubSetup ? 1 : undefined,
					nativeAttention: nativeAttention && githubSetup ? 1 : undefined,
					passiveFailedModel: hello?.lineageId ? true : undefined,
					guardedQueue: true,
					sessionPathCandidates: hello.lineageId ? 1 : undefined,
					subscriptionRefresh: subscriptions && hello.lineageId ? 1 : undefined,
				},
			});
		}
		if (parts[1] === "pi" && parts[2] === "reload" && parts.length === 3) {
			res.setHeader("cache-control", "no-store");
			if (req.method === "GET") return json(res, 200, sessions.piReload.status());
			if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
			const body = await readJson<{ operationId?: unknown }>(req);
			if (
				typeof body?.operationId !== "string" ||
				!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.operationId)
			)
				throw new HttpError(400, "operationId must be a UUID v4");
			const status = sessions.reloadPi(body.operationId);
			mcp?.check();
			return json(res, 200, status);
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
			const authorizeRecurring = async () => {
				if (!chatSettings?.automationsEnabled()) throw new ServiceUnavailable("Automations are disabled");
				if (!githubSetup) throw new HttpError(403, "native_action_required");
				try {
					await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
				} catch {
					throw new HttpError(403, "native_action_required");
				}
			};
			if (!id && req.method === "POST") {
				const body = await readJson<ScheduleRequest>(req);
				if (body.trigger === "recurring") await authorizeRecurring();
				return json(res, 201, await schedules.create(body));
			}
			if (id && req.method === "GET") return json(res, 200, schedules.require(id));
			if (id && req.method === "PATCH") {
				const body = await readJson<SchedulePatch>(req);
				if (schedules.require(id).trigger === "recurring" || body.trigger === "recurring")
					await authorizeRecurring();
				return json(res, 200, await schedules.update(id, body));
			}
			if (id && req.method === "DELETE") {
				// Optional precondition; clients without it keep the unconditional behaviour.
				const raw = url.searchParams.getAll("expectedRevision");
				if (raw.length > 1 || (raw.length === 1 && !/^[1-9][0-9]{0,15}$/.test(raw[0]!)))
					throw new HttpError(400, "expectedRevision must be a positive integer");
				await schedules.remove(id, raw.length ? Number(raw[0]) : undefined);
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
				if (parts.length === 4 && parts[3] === "thread" && req.method === "GET")
					return json(res, 200, await tracking.slackThread(decodeURIComponent(parts[2]!)));
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
		if (parts[1] === "native-projects" && parts.length === 2) {
			res.setHeader("cache-control", "no-store");
			if (req.method !== "GET") throw new HttpError(405, "Project inventory is read-only");
			if (!githubSetup || !nativeChat) throw new ServiceUnavailable("Native projects unavailable");
			await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
			return json(res, 200, nativeChat.inventory());
		}
		if (parts[1] === "projects" && parts.length === 4 && parts[3] === "chat-profile") {
			res.setHeader("cache-control", "no-store");
			if (req.method !== "GET") throw new HttpError(405, "Chat selection is read-only");
			if (!githubSetup || !nativeChat) throw new ServiceUnavailable("Native chat selection unavailable");
			await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
			return json(res, 200, await nativeChat.prepare(parts[2]!, url.searchParams.get("mode") ?? ""));
		}
		if (
			parts[1] === "projects" &&
			parts.length === 9 &&
			parts[3] === "missions" &&
			parts[5] === "tasks" &&
			parts[7] === "delivered-work" &&
			parts[8] === "artifact"
		) {
			res.setHeader("cache-control", "no-store");
			if (req.method !== "GET") throw new HttpError(405, "Delivered artifact is read-only");
			if (!githubSetup || !deliveredArtifacts) throw new ServiceUnavailable("Delivered artifact unavailable");
			await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
			const fields = ["targetId", "deliveryId", "ownerSessionId", "sourceSessionId", "artifactId", "revision"];
			if (
				[...url.searchParams.keys()].length !== fields.length ||
				fields.some((k) => url.searchParams.getAll(k).length !== 1)
			)
				throw new OperationRejected("Exact delivered artifact fields required");
			const p = Object.fromEntries(url.searchParams);
			if (!/^[1-9][0-9]*$/.test(p.revision!)) throw new OperationRejected("Explicit artifact revision required");
			return json(
				res,
				200,
				await deliveredArtifacts.read(
					{
						subject: { kind: "task", projectId: parts[2]!, missionId: parts[4]!, taskId: parts[6]! },
						targetId: p.targetId!,
						deliveryId: p.deliveryId!,
						ownerSessionId: p.ownerSessionId || null,
						sourceSessionId: p.sourceSessionId!,
						artifactId: p.artifactId!,
						revision: Number(p.revision),
					},
					[String(req.headers["x-pilot-github-capability"])],
				),
			);
		}
		if (parts[1] === "projects" && parts.length === 6 && parts[3] === "artifacts") {
			res.setHeader("cache-control", "no-store");
			if (req.method !== "GET") throw new HttpError(405, "Project artifact is read-only");
			if (!githubSetup || !deliveredArtifacts) throw new ServiceUnavailable("Project artifact unavailable");
			await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
			const revisions = url.searchParams.getAll("revision");
			if ([...url.searchParams.keys()].some((k) => k !== "revision") || revisions.length !== 1)
				throw new OperationRejected("Exact artifact revision required");
			if (!/^[1-9][0-9]*$/.test(revisions[0]!)) throw new OperationRejected("Explicit artifact revision required");
			return json(
				res,
				200,
				await deliveredArtifacts.readProject(
					{
						projectId: parts[2]!,
						sourceSessionId: parts[4]!,
						artifactId: parts[5]!,
						revision: Number(revisions[0]),
					},
					[String(req.headers["x-pilot-github-capability"])],
				),
			);
		}
		if (parts[1] === "projects" && parts.length === 4 && parts[3] === "delivered-work") {
			res.setHeader("cache-control", "no-store");
			if (req.method !== "GET") throw new HttpError(405, "Delivery discovery is read-only");
			if (!githubSetup || !userVerifications) throw new ServiceUnavailable("User verification unavailable");
			await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
			const cursor = url.searchParams.get("after");
			if (
				[...url.searchParams.keys()].some((k) => k !== "after") ||
				url.searchParams.getAll("after").length > 1 ||
				(cursor !== null && !/^(0|[1-9][0-9]*)$/.test(cursor))
			)
				throw new HttpError(400, "Invalid delivery discovery cursor");
			return json(res, 200, await userVerifications.list(parts[2]!, cursor === null ? undefined : Number(cursor)));
		}
		if (
			parts[1] === "projects" &&
			((parts.length === 8 && parts[3] === "missions" && parts[5] === "tasks" && parts[7] === "delivered-work") ||
				(parts.length === 6 && parts[3] === "chats" && parts[5] === "delivered-work"))
		) {
			res.setHeader("cache-control", "no-store");
			if (req.method !== "GET") throw new HttpError(405, "Delivered work read is read-only");
			if (!githubSetup || !userVerifications) throw new ServiceUnavailable("User verification unavailable");
			await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
			return json(
				res,
				200,
				await userVerifications.read(
					parts[3] === "missions"
						? { kind: "task", projectId: parts[2]!, missionId: parts[4]!, taskId: parts[6]! }
						: { kind: "chat", projectId: parts[2]!, sessionId: parts[4]! },
				),
			);
		}
		if (parts[1] === "projects" && parts.length === 4 && (parts[3] === "intake" || parts[3] === "saved-linear")) {
			res.setHeader("cache-control", "no-store");
			if (req.method !== "GET") throw new HttpError(405, "Intake read is read-only");
			if (!githubSetup || !nativeIntake) throw new ServiceUnavailable("Native intake unavailable");
			await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
			return json(
				res,
				200,
				parts[3] === "saved-linear" ? await nativeIntake.readLinear(parts[2]!) : await nativeIntake.read(parts[2]!),
			);
		}
		if (parts[1] === "projects" && parts.length === 4 && parts[3] === "planning-inventory") {
			res.setHeader("cache-control", "no-store");
			if (req.method !== "GET") throw new HttpError(405, "Planning inventory is read-only");
			if (!githubSetup || !nativePlanning) throw new ServiceUnavailable("Native planning unavailable");
			await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
			try {
				return json(res, 200, await nativePlanning.inventory(parts[2]!));
			} catch (error) {
				if (!(error instanceof PlanningInventoryCapacity)) throw error;
				return json(res, 503, {
					version: 1,
					code: "planning_inventory_capacity",
					projectId: parts[2]!,
					limit: error.limit,
					error: error.message,
				});
			}
		}
		if (parts[1] === "projects" && parts[3] === "missions" && parts[5] === "threads") {
			res.setHeader("cache-control", "no-store");
			if (req.method !== "GET") throw new HttpError(405, "Topics are read-only here");
			if (!githubSetup || !missionThreads) throw new ServiceUnavailable("Native topics unavailable");
			await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
			if (parts.length === 6) return json(res, 200, await missionThreads.read(parts[2]!, parts[4]!));
			if (parts.length === 8 && parts[7] === "history") {
				const before = url.searchParams.get("before"),
					limit = url.searchParams.get("limit");
				return json(
					res,
					200,
					await missionThreads.history(
						parts[2]!,
						parts[4]!,
						parts[6]!,
						before === null ? undefined : Number(before),
						limit === null ? undefined : Number(limit),
					),
				);
			}
			throw new HttpError(404, "Not found");
		}
		if (parts[1] === "projects" && parts.length === 4 && parts[3] === "planning-profile") {
			res.setHeader("cache-control", "no-store");
			if (req.method !== "GET") throw new HttpError(405, "Planning profile is read-only");
			if (!githubSetup || !planningWorkers) throw new ServiceUnavailable("Trusted planning profile unavailable");
			await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
			return json(res, 200, planningWorkers.profile(parts[2]!));
		}
		if (parts[1] === "projects" && parts.length === 6 && parts[3] === "missions" && parts[5] === "planning") {
			res.setHeader("cache-control", "no-store");
			if (req.method !== "GET") throw new HttpError(405, "Planning preparation is read-only");
			if (!githubSetup || !nativePlanning) throw new ServiceUnavailable("Native planning unavailable");
			await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
			return json(res, 200, await nativePlanning.read(parts[2]!, parts[4]!));
		}
		if (missions && parts[1] === "missions" && parts[3] === "controls") {
			missions.store.require(parts[2]!);
			if (req.method === "GET" && parts.length === 4) {
				await missions.store.durable();
				return json(res, 200, missions.store.controls.current(parts[2]!));
			}
			if (req.method === "GET" && parts.length === 6 && parts[4] === "operations")
				return json(
					res,
					200,
					(await missions.service.controls.lookup(parts[2]!, parts[5]!)) ?? { state: "unknown" },
				);
			if (req.method === "POST" && parts.length === 4) {
				if (!githubSetup) throw new ServiceUnavailable("Native mission controls unavailable");
				await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
				const write = parseMissionControl(await readJson(req, 4096), catalogHost);
				return json(res, 200, await missions.service.controls.execute(parts[2]!, write));
			}
			throw new HttpError(404, "Unknown mission control operation");
		}
		if (missions && parts[1] === "missions" && parts.length === 4 && parts[3] === "reports" && req.method === "GET")
			return json(res, 200, {
				version: 1,
				missionId: parts[2]!,
				reports: await missions.service.reports.views(parts[2]!),
			});
		if (
			missions &&
			parts[1] === "missions" &&
			parts.length === 4 &&
			parts[3] === "lifecycle" &&
			req.method === "POST"
		) {
			const write = parseMissionLifecycle(await readJson(req), catalogHost);
			const mission = missions.service.lifecycle(parts[2]!, write);
			return json(res, 200, { operationId: write.operationId, mission });
		}
		if (
			missions &&
			parts[1] === "missions" &&
			parts.length === 6 &&
			parts[3] === "tasks" &&
			parts[5] === "model" &&
			req.method === "POST"
		) {
			const write = parseTaskModel(await readJson(req), catalogHost);
			const task = await missions.service.taskModel(parts[2]!, parts[4]!, write);
			return json(res, 200, {
				operationId: write.operationId,
				home: write.home,
				missionId: parts[2]!,
				projectId: write.projectId,
				task,
			});
		}
		if (
			parts[1] === "missions" &&
			parts.length === 4 &&
			["approval-package", "reviewer-consent-package"].includes(parts[3]!)
		) {
			if (req.method !== "GET") throw new HttpError(405, "Preparation is read-only");
			if (!workflowConfirmations) throw new ServiceUnavailable("Workflow confirmations are unavailable");
			if (
				[...url.searchParams.keys()].some((key) => key !== "action") ||
				url.searchParams.getAll("action").length > 1
			)
				throw new HttpError(400, "Unsupported confirmation query");
			const action = url.searchParams.get("action") ?? "approve";
			if (!["approve", "revoke"].includes(action)) throw new HttpError(400, "Unsupported confirmation action");
			const purpose =
				parts[3] === "approval-package"
					? action === "revoke"
						? "workflow-revoke"
						: "workflow-approve"
					: action === "revoke"
						? "review-consent-revoke"
						: "review-consent";
			res.setHeader("cache-control", "no-store");
			return json(res, 200, await workflowConfirmations.prepare(parts[2]!, purpose));
		}
		if (parts[1] === "projects" && parts[3] === "review") {
			res.setHeader("cache-control", "no-store");
			if (req.method !== "GET" || parts.length !== 4) throw new HttpError(405, "Review is read-only");
			const projectId = parts[2]!;
			const missionId = url.searchParams.get("missionId");
			const authorizeProject = () => {
				projects.require(projectId);
				if (missionId !== null && missions?.store.get(missionId)?.projectId !== projectId)
					throw new HttpError(403, "Retained Review unavailable in this scope");
			};
			authorizeProject();
			await missions?.store.durable();
			authorizeProject();
			const chats: { id: string; title: string; missionId?: string }[] = [];
			const admissions: (() => void)[] = [];
			for (const chat of sessions.list({ projectId, archived: "all" })) {
				const member = missions?.store.membership(chat.id);
				if (member?.coordinator || (missionId !== null && member?.missionId !== missionId)) continue;
				const authorize = () => {
					authorizeProject();
					const current = missions?.store.membership(chat.id);
					if (
						current?.missionId !== member?.missionId ||
						current?.coordinator !== member?.coordinator ||
						(member && missions!.store.require(member.missionId).projectId !== projectId) ||
						sessions.get(chat.id)?.projectId !== projectId
					)
						throw new HttpError(403, "Retained Review unavailable in this scope");
				};
				try {
					if (!(await sessions.hasNativeReviewBinding(chat.id, member?.missionId, projectId, authorize, true)))
						continue;
				} catch (error) {
					if (error instanceof HttpError) throw error;
					throw new HttpError(403, "Retained Review unavailable in this scope");
				}
				admissions.push(authorize);
				chats.push({
					id: chat.id,
					title: sessions.get(chat.id)!.title,
					...(member ? { missionId: member.missionId } : {}),
				});
				if (chats.length > 100) break;
			}
			for (const authorize of admissions) authorize();
			authorizeProject();
			return json(res, 200, { projectId, chats: chats.slice(0, 100), more: chats.length > 100 });
		}
		if ((parts[1] === "sessions" || (missions && parts[1] === "missions")) && parts[3] === "review") {
			res.setHeader("cache-control", "no-store");
			const chatRoute = parts[1] === "sessions";
			if (req.method !== "GET" || parts.length < 4 || parts.length > (chatRoute ? 6 : 7))
				throw new HttpError(405, "Review is read-only");
			const workerId = chatRoute ? parts[2]! : parts[4],
				snapshotId = parts[chatRoute ? 4 : 5],
				section = parts[chatRoute ? 5 : 6];
			const initialSession = chatRoute ? sessions.get(workerId!) : undefined;
			if (chatRoute && !initialSession) throw new HttpError(404, "Unknown chat");
			const initialMember = chatRoute ? missions?.store.membership(workerId!) : undefined;
			const missionId = chatRoute ? initialMember?.missionId : parts[2]!;
			const expectedProjectIds = chatRoute ? url.searchParams.getAll("expectedProjectId") : [];
			const expectedProjectId = expectedProjectIds[0];
			const authorize = () => {
				if (chatRoute) {
					if (initialSession!.projectId) projects.require(initialSession!.projectId);
					const current = missions?.store.membership(workerId!);
					const session = sessions.get(workerId!);
					if (
						!session ||
						expectedProjectIds.length > 1 ||
						(expectedProjectId !== undefined &&
							(!expectedProjectId || session.projectId !== expectedProjectId)) ||
						session.projectId !== initialSession!.projectId ||
						current?.missionId !== initialMember?.missionId ||
						current?.coordinator !== initialMember?.coordinator
					)
						throw new HttpError(403, "Retained Review unavailable in this scope");
					if (!missionId) return undefined;
				}
				const mission = missions!.store.require(missionId!);
				projects.require(mission.projectId);
				if (workerId) {
					const member = missions!.store.membership(workerId),
						session = sessions.get(workerId);
					if (!member || member.missionId !== missionId || !session || session.projectId !== mission.projectId)
						throw new HttpError(403, "Retained Review unavailable in this scope");
				}
				return mission;
			};
			const mission = authorize();
			await missions?.store.durable();
			authorize();
			if (!workerId) {
				const members = missions!.store.nativeReviewMembers(missionId!);
				const workers = members.slice(0, 100).flatMap((id) => {
					const m = missions!.store.membership(id),
						s = sessions.get(id);
					return m && !m.coordinator && s?.projectId === mission!.projectId ? [{ id, title: s.title }] : [];
				});
				return json(res, 200, { missionId, projectId: mission!.projectId, workers, more: members.length > 100 });
			}
			try {
				const after = url.searchParams.get("after") ?? "0";
				if (!snapshotId && !/^\d{1,15}$/.test(after)) throw new Error("Invalid cursor");
				if (chatRoute && (!initialSession!.projectId || initialMember?.coordinator)) {
					if (snapshotId) throw new HttpError(403, "Retained Review unavailable in this scope");
					if (url.searchParams.get("view") === "changes")
						return json(res, 200, {
							version: 1,
							scope: "retained-comparisons-only",
							status: "unavailable",
							changes: [],
							next: null,
							reason: "Not captured. No retained managed ownership binding for this chat.",
						});
					return json(res, 200, {
						comparisons: [],
						next: null,
						unavailable:
							"Not captured. No retained managed ownership binding for this chat. Reading does not enroll, capture or migrate existing work.",
					});
				}
				const reader = sessions.nativeReviewReader(
					workerId,
					missionId,
					mission?.projectId ?? initialSession!.projectId!,
					authorize,
					chatRoute,
				);
				// Passive only. No observation producer is installed in a GET handler.
				if ((!snapshotId && url.searchParams.get("view") === "changes") || section === "history") {
					if (!missions || !humanReviews) throw new ServiceUnavailable("Change history is unavailable");
					const feed = new LandedChanges({
						projectId: mission?.projectId ?? initialSession!.projectId!,
						reader,
						store: missions.store.changeLandings,
						feedback: humanReviews,
						requests: missions.store.reviewRequests,
						authorize: () => {
							authorize();
							return {
								revalidate: () => {
									authorize();
								},
							};
						},
					});
					if (!snapshotId) return json(res, 200, await feed.page(Number(after)));
					const cursor = (name: string) => {
						const values = url.searchParams.getAll(name);
						if (values.length > 1 || !/^\d{1,15}$/.test(values[0] ?? "0"))
							throw new Error("Invalid history cursor");
						return Number(values[0] ?? 0);
					};
					return json(res, 200, await feed.open(snapshotId, cursor("landingAfter"), cursor("reviewAfter")));
				}
				if (!snapshotId) {
					return json(res, 200, await reader.list(Number(after)));
				}
				if (!section) return json(res, 200, await reader.get(snapshotId));
				if (chatRoute && section === "call-changes") {
					const query: RetainedCallQuery = {};
					for (const [key, value] of url.searchParams) {
						if (url.searchParams.getAll(key).length !== 1) throw new Error("Ambiguous retained query");
						if (key === "expectedProjectId") continue;
						if (key === "path") query.path = value;
						else if (key === "expectedRevision" && /^[a-f0-9]{64}$/.test(value)) query.expectedRevision = value;
						else if ((key === "limit" || key === "offset") && /^(0|[1-9]\d{0,3})$/.test(value)) {
							const number = Number(value);
							if (key === "limit" ? number < 1 || number > 50 : number > 1000)
								throw new Error("Invalid retained page");
							query[key] = number;
						} else throw new Error("Unsupported retained query");
					}
					if (query.offset && !query.expectedRevision) throw new Error("Unpinned retained continuation");
					const controller = new AbortController();
					const cancel = () => controller.abort(new Error("Retained Review client disconnected"));
					res.once("close", cancel);
					if (res.destroyed) cancel();
					try {
						const result = await reader.compareCalls(snapshotId, query, controller.signal);
						controller.signal.throwIfAborted();
						if (query.offset && query.offset >= result.page.retained)
							throw new Error("Invalid retained continuation");
						return json(res, 200, result);
					} finally {
						res.off("close", cancel);
					}
				}
				if (section === "patch") return json(res, 200, { snapshotId, patch: await reader.diff(snapshotId) });
				if (section === "source") {
					const source = await reader.source(snapshotId, {
						snapshotId,
						side: url.searchParams.get("side") as "before" | "after",
						path: url.searchParams.get("path")!,
						sha256: url.searchParams.get("sha256")!,
					});
					return json(res, 200, { snapshotId, text: source });
				}
				if (section === "records") {
					const snapshot = await reader.get(snapshotId);
					if (snapshot.enrollmentProjectId !== undefined || !missionId)
						return json(res, 422, {
							error: "Related records unavailable: project/chat capture has no mission assessment scope.",
						});
					let records: ReturnType<MissionStore["nativeReviewRecords"]>;
					try {
						records = missions!.store.nativeReviewRecords(missionId!, workerId, snapshotId, snapshot);
					} catch {
						return json(res, 422, {
							error: "Related records unavailable: malformed, partial or unsupported exact assessment scope.",
						});
					}
					authorize();
					return json(res, 200, records);
				}
				throw new Error("Unsupported Review read");
			} catch (error) {
				if (error instanceof HttpError) throw error;
				// No paths, manifest fragments or cross-scope existence information in errors.
				throw new HttpError(
					403,
					"Retained Review unavailable: missing, unsupported, corrupt or unauthorized records. No live fallback was attempted.",
				);
			}
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
		// The user's own feedback, newest first. Native authority only; reading it routes or starts nothing.
		if (parts[1] === "feedback" && parts.length === 2) {
			res.setHeader("cache-control", "no-store");
			if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
			if (!githubSetup || !userFeedback) throw new ServiceUnavailable("User feedback unavailable");
			await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
			return json(
				res,
				200,
				await userFeedback.page(
					url.searchParams.get("before") ?? undefined,
					url.searchParams.get("limit") ?? undefined,
				),
			);
		}
		// Explicit project choices. User writes require native authority; never runtime permissions.
		if (parts[1] === "projects" && parts[3] === "preferences" && parts.length <= 6) {
			const preferences = missions?.knowledge?.preferences;
			if (!preferences) throw new ServiceUnavailable("Project preferences are unavailable");
			const projectId = parts[2]!;
			res.setHeader("cache-control", "no-store");
			if (parts.length === 4 && req.method === "GET") return json(res, 200, await preferences.read(projectId));
			if (parts.length === 4 && req.method === "PUT") {
				if (!githubSetup) throw new ServiceUnavailable("Native preferences authority unavailable");
				await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
				return json(res, 200, await preferences.write(projectId, await readJson(req, 16 * 1024)));
			}
			if (parts.length === 5 && parts[4] === "history" && req.method === "GET")
				return json(
					res,
					200,
					await preferences.history(
						projectId,
						url.searchParams.get("before") ?? undefined,
						url.searchParams.get("limit") ?? undefined,
					),
				);
			if (parts.length === 6 && parts[4] === "operations" && req.method === "GET")
				return json(res, 200, await preferences.lookup(projectId, parts[5]));
			throw new HttpError(405, "Method not allowed");
		}
		// Project knowledge. GETs read stored rows only; writes act for the local user and ACK after durability.
		if (parts[1] === "projects" && parts[3] === "knowledge" && parts.length <= 6) {
			const knowledge = missions?.knowledge;
			if (!knowledge) throw new ServiceUnavailable("Project knowledge is unavailable");
			const projectId = parts[2]!;
			const entryId = parts[4];
			const query = (name: string) => url.searchParams.get(name) ?? undefined;
			res.setHeader("cache-control", "no-store");
			if (parts.length === 4 && req.method === "GET") {
				return json(
					res,
					200,
					await knowledge.durableRead(() =>
						knowledge.list(projectId, {
							kind: query("kind"),
							missionId: query("missionId"),
							check: query("check"),
							q: query("q"),
							limit: query("limit"),
							cursor: query("cursor"),
						}),
					),
				);
			}
			if (parts.length === 4 && req.method === "POST")
				return json(
					res,
					201,
					await knowledge.write(projectId, undefined, await readJson(req, 96 * 1024), { type: "user" }),
				);
			if (parts.length === 5 && req.method === "GET")
				return json(
					res,
					200,
					await knowledge.durableRead(() => knowledge.detail(projectId, entryId!, query("revision"))),
				);
			if (parts.length === 5 && req.method === "PUT")
				return json(
					res,
					200,
					await knowledge.write(projectId, entryId, await readJson(req, 96 * 1024), { type: "user" }),
				);
			if (parts.length === 6 && parts[5] === "revisions" && req.method === "GET")
				return json(
					res,
					200,
					await knowledge.durableRead(() =>
						knowledge.revisions(projectId, entryId!, { cursor: query("cursor"), limit: query("limit") }),
					),
				);
			throw new HttpError(405, "Method not allowed");
		}
		if (parts[1] === "missions" && parts[3] === "knowledge" && parts.length === 5) {
			const knowledge = missions?.knowledge;
			if (!knowledge) throw new ServiceUnavailable("Project knowledge is unavailable");
			const missionId = parts[2]!;
			const entryId = parts[4]!;
			res.setHeader("cache-control", "no-store");
			if (req.method === "GET")
				return json(res, 200, await knowledge.durableRead(() => knowledge.linkState(missionId, entryId)));
			if (req.method === "PUT")
				return json(res, 200, await knowledge.link(missionId, entryId, await readJson(req), { type: "user" }));
			if (req.method === "DELETE")
				return json(
					res,
					200,
					await knowledge.unlink(missionId, entryId, url.searchParams.get("expectedLinkRevision") ?? undefined, {
						type: "user",
					}),
				);
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
		if (parts[1] === "update" && parts[2] === "blockers" && parts.length === 3 && req.method === "GET") {
			if (!hello?.lineageId) throw new ServiceUnavailable("Daemon identity unavailable");
			if (
				url.searchParams.get("daemonId") !== hello.daemonId ||
				url.searchParams.get("lineageId") !== hello.lineageId
			)
				throw new Conflict("Daemon identity changed");
			// Display only. In particular, do not call sessions.blockers(): that checkpoints workers.
			const observed = await new RuntimeResources(
				runtimeSources.map((source) =>
					source === sessions
						? { freezeAdmissions: () => () => {}, blockers: () => sessions.observeUpdateBlockers() }
						: source,
				),
			).blockers();
			const blockers = observed.slice(0, 256).map((blocker) => ({
				...blocker,
				...(blocker.sessionId ? { title: sessions.get(blocker.sessionId)?.title?.slice(0, 256) } : {}),
			}));
			res.setHeader("cache-control", "no-store");
			return json(res, 200, {
				processId: process.pid,
				daemonId: hello.daemonId,
				lineageId: hello.lineageId,
				blockers,
				truncated: observed.length > 256 || observed.some((b) => b.id.endsWith("overflow")),
			} satisfies import("@pilot/protocol").DaemonUpdateBlockers);
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
		if (parts[1] === "chat-settings" && parts.length === 2) {
			if (!chatSettings) throw new ServiceUnavailable("Chat settings are unavailable");
			if (req.method === "GET") return json(res, 200, chatSettings.settings());
			if (req.method === "PATCH") {
				const input = await readJson(req);
				if (input && typeof input === "object" && Object.hasOwn(input, "automations")) {
					if (!githubSetup) throw new ServiceUnavailable("Native settings authority unavailable");
					try {
						await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
					} catch {
						return json(res, 403, { error: "native_action_required" });
					}
				}
				try {
					const result = await chatSettings.update(input);
					sessions.resumeFlows?.();
					return json(res, 200, result);
				} catch (error) {
					if (error instanceof InvalidChatSettings) throw new HttpError(400, error.message);
					throw error;
				}
			}
		}
		if (parts[1] === "telemetry" && parts.length === 2) {
			if (!telemetry) throw new ServiceUnavailable("Telemetry settings are unavailable");
			if (req.method === "GET") return json(res, 200, telemetry.settings());
			if (req.method === "PUT") {
				let settings: Awaited<ReturnType<TelemetrySettingsService["update"]>>;
				try {
					settings = await telemetry.update(await readJson(req));
				} catch {
					throw new HttpError(400, "Invalid telemetry settings");
				}
				await tracking?.flushDiagnosticEvidence?.();
				return json(res, 200, settings);
			}
		}
		if (parts[1] === "diagnostics" && parts[2] === "native" && parts.length === 3 && req.method === "PUT") {
			await sessions.replaceNativeDiagnostics(
				await readJson<NativeDiagnosticsBatch>(req, MAX_NATIVE_DIAGNOSTIC_BYTES),
			);
			return json(res, 200, { accepted: true });
		}
		if (parts[1] === "diagnostics" && parts.length === 2 && req.method === "DELETE") {
			await telemetry?.clearNextDiagnostics();
			await sessions.clearDiagnostics();
			await telemetry?.featureUsage.clear();
			await tracking?.clearDiagnosticEvidence?.();
			return json(res, 200, { cleared: true });
		}
		if (parts[1] === "update" && parts[2] === "prepare" && parts.length === 3 && req.method === "POST")
			return json(res, 200, sessions.prepareUpdate());
		if (parts[1] === "artifacts" && parts.length === 3 && req.method === "GET")
			return json(res, 200, await sessions.resolveArtifact(parts[2]!));
		if (parts[1] === "artifact-libraries" && parts.length === 3 && req.method === "GET") {
			throw new HttpError(410, "Browser artifact libraries are no longer supported; retained sources are read-only");
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
		if (parts[1] === "projects" && parts.length === 4 && parts[3] === "automations" && req.method === "PUT") {
			if (!chatSettings?.automationsEnabled()) return json(res, 404, { error: "automations_unavailable" });
			if (!githubSetup) return json(res, 503, { error: "automations_unavailable" });
			try {
				await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
			} catch {
				return json(res, 403, { error: "native_action_required" });
			}
			try {
				return json(res, 200, await projects.updateAutomations(parts[2]!, await readJson(req, 512 * 1024)));
			} catch (error) {
				if (error instanceof AutomationsRevisionConflict)
					return json(res, 409, { error: "automations_conflict", current: error.current });
				throw error;
			}
		}
		if (
			parts[1] === "projects" &&
			parts.length === 5 &&
			parts[3] === "flows" &&
			parts[4] === "start" &&
			req.method === "POST"
		) {
			if (!chatSettings?.automationsEnabled()) return json(res, 404, { error: "automations_unavailable" });
			if (!githubSetup) return json(res, 503, { error: "automations_unavailable" });
			try {
				await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
			} catch {
				return json(res, 403, { error: "native_action_required" });
			}
			return json(res, 202, await sessions.startFlow(parts[2]!, await readJson(req, 64 * 1024)));
		}
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
		if (missions && parts[1] === "projects" && parts.length === 4 && parts[3] === "day" && req.method === "GET") {
			await missions.store.durable();
			const projectId = parts[2]!,
				observedAt = Date.now(),
				list = missions.store.list(projectId);
			const overview: import("@pilot/protocol").DayOverview = {
				version: 1,
				projectId,
				observedAt,
				complete: true,
				dashboard: dashboards.dashboard(projectId, Number.MAX_SAFE_INTEGER),
				reports: list.flatMap((mission) => missions.service.reports.viewsNow(mission.id, observedAt)),
				controls: list.map((mission) => missions.store.controls.current(mission.id)),
			};
			return json(res, 200, overview);
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
		if (parts[1] === "mission-catalog" && parts.length === 2 && req.method === "GET") {
			if (!catalogSources) throw new ServiceUnavailable("Mission catalog unavailable");
			return json(
				res,
				200,
				buildMissionCatalog(catalogSources.host, catalogSources.missions(), catalogSources.sharedContext()),
			);
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
			let view: import("@pilot/protocol").TranscriptContext | undefined;
			const captured = url.searchParams.get("view");
			if (captured !== null) {
				try {
					view = JSON.parse(captured);
				} catch {
					throw new HttpError(400, "Invalid transcript context");
				}
				const natural = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
				if (
					!view ||
					!natural(view.conversationId) ||
					!natural(view.tail) ||
					(view.head !== undefined &&
						(!view.head ||
							!natural(view.head.id) ||
							!natural(view.head.start) ||
							view.head.start > view.head.id ||
							view.head.id > view.tail)) ||
					Number(before) > view.tail + 1
				)
					throw new HttpError(400, "Invalid transcript context");
			}
			const page: SessionHistoryPage = view
				? await sessions.history(parts[2]!, Number(before), Number(limit), view)
				: await sessions.history(parts[2]!, Number(before), Number(limit));
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
			if (parts[3] === "setup") {
				if (!chatSettings?.automationsEnabled()) return json(res, 404, { error: "automations_unavailable" });
				if (!githubSetup) return json(res, 503, { error: "automations_unavailable" });
				try {
					await githubSetup.authenticate(req.headers["x-pilot-github-capability"]);
				} catch {
					return json(res, 403, { error: "native_action_required" });
				}
				return json(res, 202, await sessions.rerunWorkspaceSetup(id));
			}
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
			if (parts[3] === "failed-model") {
				const body = await readJson<FailedModelRequest>(req);
				if (
					!body ||
					typeof body.operationId !== "string" ||
					!/^[a-zA-Z0-9_-]{1,128}$/.test(body.operationId) ||
					typeof body.model !== "string" ||
					body.model.length > 1024 ||
					!body.model.includes("/") ||
					!body.source ||
					!["startup", "outcome"].includes(body.source.source) ||
					typeof body.source.token !== "string" ||
					!/^[a-f0-9]{64}$/.test(body.source.token) ||
					(body.thinking !== undefined &&
						(typeof body.thinking !== "string" || !body.thinking || body.thinking.length > 64))
				)
					throw new HttpError(400, "Invalid failed model preference");
				if (!hello?.lineageId || body.daemonId !== hello.daemonId || body.lineageId !== hello.lineageId)
					throw new HttpError(409, "Failed chat home changed");
				const choice = { model: body.model, ...(body.thinking !== undefined ? { thinking: body.thinking } : {}) };
				const session = await sessions.saveFailedModel(id, body.source, choice, models);
				return json(res, 200, {
					...choice,
					source: body.source,
					operationId: body.operationId,
					daemonId: hello.daemonId,
					lineageId: hello.lineageId,
					sessionId: id,
					session,
				});
			}
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
					await sessions.send(id, body.message, body.mode, body.requestId, span.carrier() ?? parent, true);
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
			if (parts[3] === "stop") {
				return json(res, 202, await sessions.stop(id));
			}
			if (parts[3] === "retry-startup") return json(res, 200, await sessions.retryStartup(id));
			if (parts[3] === "retry-handoff") {
				const body = await readJson<RetryHandoffRequest | null>(req);
				if (!body || typeof body.operationId !== "string" || !/^[\w-]{1,128}$/.test(body.operationId))
					throw new HttpError(400, "operationId must be 1-128 letters, digits, dashes or underscores");
				return json(res, 200, await sessions.retryHandoff(id, body.operationId));
			}
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
		const queueGuard = (g: QueuedMessageGuard | undefined): QueuedMessageGuard | undefined => {
			if (g === undefined) return undefined;
			if (
				!g ||
				typeof g.token !== "string" ||
				!/^[a-f0-9]{64}$/.test(g.token) ||
				typeof g.operationId !== "string" ||
				!/^[a-zA-Z0-9_-]{1,128}$/.test(g.operationId)
			)
				throw new HttpError(400, "Invalid queued message guard");
			if (!hello?.lineageId || g.daemonId !== hello.daemonId || g.lineageId !== hello.lineageId)
				throw new HttpError(409, "Queued message home changed");
			return { token: g.token, operationId: g.operationId, daemonId: g.daemonId, lineageId: g.lineageId };
		};
		if (parts[1] === "sessions" && parts.length === 5 && parts[3] === "queue" && req.method === "PATCH") {
			const body = await readJson<EditQueuedMessageRequest>(req);
			if (body?.mode !== undefined && body.mode !== "steer" && body.mode !== "followUp")
				throw new HttpError(400, "mode must be steer or followUp");
			const guard = queueGuard(body.guard);
			if (guard && (typeof body.message !== "string" || Buffer.byteLength(body.message) > 64 * 1024))
				throw new HttpError(400, "Guarded message must be text of at most 64 KiB");
			if (guard) await sessions.editQueuedMessage(parts[2]!, Number(parts[4]), body.message, body.mode, guard.token);
			else await sessions.editQueuedMessage(parts[2]!, Number(parts[4]), body.message, body.mode);
			return json(
				res,
				200,
				guard
					? { ok: true, guard, sessionId: parts[2], submissionId: Number(parts[4]), action: "edit" }
					: { ok: true },
			);
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
			// Legacy DELETE has no body. Guarded callers opt in with an explicit JSON body.
			const body = req.headers["content-type"]?.includes("application/json")
				? await readJson<{ guard?: QueuedMessageGuard } | undefined>(req, MAX_BODY, true)
				: undefined;
			const guard = queueGuard(body?.guard);
			if (guard) await sessions.removeQueuedMessage(parts[2]!, Number(parts[4]), guard.token);
			else await sessions.removeQueuedMessage(parts[2]!, Number(parts[4]));
			return json(
				res,
				200,
				guard
					? { ok: true, guard, sessionId: parts[2], submissionId: Number(parts[4]), action: "remove" }
					: { ok: true },
			);
		}
		throw new HttpError(404, "Not found");
	};

	const handleRequest = (req: IncomingMessage, res: ServerResponse) => {
		// Requests still open when the event loop stalls are reported with it. IDs stay local to the log.
		const done = operations.begin(`${req.method} ${(req.url ?? "/").split("?")[0]}`);
		res.once("close", done);
		let receiptLookup = false;
		if (missions && req.method !== "GET" && req.method !== "HEAD")
			acknowledgeWhenDurable(res, missions.store, () => receiptLookup);
		let release: (() => void) | undefined;
		const run = async () => {
			const path = new URL(req.url ?? "/", "http://localhost").pathname;
			// Match the router's path segments. Only receipt lookup avoids mission durability.
			const parts = path.split("/").filter(Boolean);
			receiptLookup = req.method === "POST" && parts.length === 3 && parts.join("/") === "api/operations/receipt";
			const update = parts[0] === "api" && parts[1] === "runtime-update";
			const control =
				/\/(stop|cancel|seal)$/.test(path) || (req.method === "DELETE" && path.startsWith("/api/setup/runs/"));
			if (!update && req.method !== "GET" && req.method !== "HEAD" && !control)
				release = mutations.begin({ kind: "request", id: path.slice(0, 180) });
			else if (
				(req.method === "GET" || req.method === "HEAD") &&
				/\/(artifacts|artifact-libraries|files|call-changes)(\/|$)/.test(path)
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
				error instanceof UsageQueryCapacityError
					? 429
					: error instanceof HttpError || error instanceof SetupError
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
	};
	const server = bootstrap ? (bootstrap.install(handleRequest), bootstrap.server) : createServer(handleRequest);
	server.once("close", () => {
		reservations.close();
		void planningWorkers?.close();
	});

	// The control socket carries only small subscription messages. Terminal pastes use the terminal socket.
	const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
	// Dedicated chat, terminal and subagent sockets. Each has its own send queue, so one stream's large snapshot,
	// output burst or slow reader never delays another stream or the sidebar, and overload resets only that stream.
	const streamWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
	const terminalWss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
	server.on("close", () => {
		for (const ws of terminalWss.clients) ws.terminate();
		terminalWss.close();
	});
	const setupWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
	server.on("close", () => {
		for (const ws of setupWss.clients) ws.terminate();
		setupWss.close();
	});
	const chatStreams = new ChatStreams((sessionId, listener, trace, recent) =>
		sessions.subscribe(sessionId, listener, trace, recent),
	);
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
				const send = createSocketSender(ws, 64 * 1024);
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
	// A durable change only invalidates native state. Never publish proposal paths or drive maintenance here.
	const stopRuntimeUpdateWatch = liveUpdate?.service.onChange(() => broadcast({ type: "runtime-update.changed" }));
	server.once("close", () => stopRuntimeUpdateWatch?.());
	const nextControl = (): Extract<ServerMessage, { type: "diagnostics.next-control" }> | undefined => {
		if (!hello?.lineageId || !telemetry) return;
		const settings = telemetry.settings();
		if (!settings.nextDiagnostics) return;
		return {
			type: "diagnostics.next-control",
			control: {
				schemaVersion: 1,
				host: { hostId: "daemon", daemonId: hello.daemonId, lineageId: hello.lineageId },
				localDiagnostics: settings.localDiagnostics,
				epoch: settings.nextDiagnostics!.epoch,
			},
		};
	};
	const stopNextControl = telemetry?.onChange(() => {
		const message = nextControl();
		if (message) broadcast(message);
	});
	const stopDiagnosticReads = sessions.diagnosticReadBroker?.onRead((dispatch) => {
		broadcast({ type: "diagnostics.read", dispatch });
	});
	let missionCatalogTimer: NodeJS.Timeout | undefined;
	const invalidateMissionCatalog = () => {
		if (clients.size === 0 || missionCatalogTimer) return;
		missionCatalogTimer = setTimeout(() => {
			missionCatalogTimer = undefined;
			broadcast({ type: "mission-catalog.changed" });
		}, DASHBOARD_DEBOUNCE_MS);
		missionCatalogTimer.unref();
	};
	const refreshMissionCatalog = () => {
		catalogGroups = catalogHost && missions ? missions.store.catalogSharedContext(catalogHost) : [];
		invalidateMissionCatalog();
	};
	const stopMissionCatalog = missions?.store.onChange((id) => {
		const mission = missions.store.get(id);
		if (mission) catalogMissions.set(id, mission);
		else catalogMissions.delete(id);
		refreshMissionCatalog();
	});
	// Small coalesced invalidation only. Never put action text/files or a receipt in WS frames.
	const stopAttentionWatch = missions?.store.attention.onChange(invalidateMissionCatalog);
	server.on("close", () => {
		stopAttentionWatch?.();
		stopDiagnosticReads?.();
		stopNextControl?.();
		stopMissionCatalog?.();
		clearTimeout(missionCatalogTimer);
	});
	const stopPowerWatch = power?.onChange(() => broadcast({ type: "power", power: power.status() }));
	server.on("close", () => stopPowerWatch?.());
	const stopMcpWatch = mcp?.onChange((status) => broadcast({ type: "mcp", mcp: status }));
	const stopPiReloadWatch = sessions.piReload.onChange((reload) => broadcast({ type: "pi.reload", reload }));
	server.on("close", () => {
		stopMcpWatch?.();
		stopPiReloadWatch();
	});
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
		invalidateMissionCatalog();
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
		sessions.resumeFlows?.();
		invalidateMissionCatalog();
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
		invalidateMissionCatalog();
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
			invalidateMissionCatalog();
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
		clients.set(ws, createSocketSender(ws));
		const control = nextControl();
		if (control) send(ws, control);
		if (power) send(ws, { type: "power", power: power.status() });
		if (mcp) send(ws, { type: "mcp", mcp: mcp.status() });
		send(ws, { type: "pi.reload", reload: sessions.piReload.status() });
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
		const sendData = createSocketSender(ws);
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
				params.get("history") === "paged-v1",
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
		const sendData = createSocketSender(ws);
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
		runtimeReady,
		recoverOperations,
		closePlanning: async () => {
			await Promise.all([planningWorkers?.close(), nativeAttention?.close()]);
		},
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
			return (json(res, 200, service.join(parts[2]!, await readJson<JoinMissionRequest>(req))), true);
		if (method === "DELETE") return (json(res, 200, service.leave(parts[2]!)), true);
		return false;
	}
	if (parts[1] !== "missions") return false;
	const id = parts[2];
	if (parts.length === 2) {
		if (method === "GET") return (json(res, 200, store.list(url.searchParams.get("projectId") ?? undefined)), true);
		if (method === "POST")
			return (json(res, 201, await service.create(await readJson<CreateMissionRequest>(req))), true);
		return false;
	}
	if (!id) return false;
	if (parts.length === 3) {
		if (method === "GET") return (json(res, 200, store.detail(id)), true);
		if (method === "PATCH")
			return (json(res, 200, store.update(id, await readJson<UpdateMissionRequest>(req))), true);
		if (method === "DELETE") {
			store.remove(id);
			return (json(res, 200, { ok: true }), true);
		}
		return false;
	}
	const section = parts[3];
	const item = parts[4];
	if (section === "revisions") {
		await store.durable();
		if (parts.length === 6 && item === "operations" && method === "GET") {
			store.require(id);
			json(res, 200, { proposal: store.revisions.lookup(id, parts[5]!) });
			return true;
		}
		if (parts.length === 4 && method === "GET")
			return (
				json(res, 200, {
					source: store.revisions.source(id),
					latestConfirmed: store.revisions.latestConfirmed(id),
					pending: store.revisions.pending(id),
				}),
				true
			);
		if (parts.length === 4 && method === "POST")
			return (
				json(
					res,
					201,
					await store.revisions.propose(
						id,
						await readJson<Parameters<typeof store.revisions.propose>[1]>(req),
						{},
					),
				),
				true
			);
		if (parts.length === 5 && method === "GET") return (json(res, 200, store.revisions.get(id, item!)), true);
		if (parts.length === 6 && parts[5] === "preview" && method === "POST") {
			json(
				res,
				201,
				await store.revisions.repreview(
					id,
					item!,
					await readJson<Parameters<typeof store.revisions.repreview>[2]>(req),
				),
			);
			return true;
		}
		if (parts.length === 6 && parts[5] === "confirm" && method === "POST")
			return (
				json(
					res,
					200,
					await store.revisions.confirm(
						id,
						item!,
						await readJson<Parameters<typeof store.revisions.confirm>[2]>(req),
					),
				),
				true
			);
		return false;
	}
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
			return (json(res, 200, brief), true);
		}
		if (parts.length === 4 && method === "PUT") {
			const body = await readJson<MissionBriefWrite>(req);
			return (json(res, 200, store.writeBrief(id, body?.markdown, body?.expectedRevision)), true);
		}
		if (parts.length === 5 && item === "revisions" && method === "GET")
			return (json(res, 200, store.briefRevisions(id)), true);
		return false;
	}
	if (section === "phases") {
		if (parts.length === 4 && method === "GET") return (json(res, 200, store.phases(id)), true);
		if (parts.length === 4 && method === "POST")
			return (json(res, 201, store.addPhase(id, await readJson<MissionPhaseWrite>(req))), true);
		if (parts.length === 5 && method === "PATCH")
			return (json(res, 200, store.updatePhase(id, item!, await readJson<MissionPhaseWrite>(req))), true);
		if (parts.length === 5 && method === "DELETE") {
			store.removePhase(id, item!);
			return (json(res, 200, { ok: true }), true);
		}
		return false;
	}
	if (section === "tasks") {
		if (parts.length === 4 && method === "POST")
			return (json(res, 201, await service.addTask(id, await readJson<MissionTaskWrite>(req))), true);
		if (parts.length === 5 && method === "PATCH")
			return (json(res, 200, await service.updateTask(id, item!, await readJson<MissionTaskWrite>(req))), true);
		if (parts.length === 5 && method === "DELETE") {
			store.removeTask(id, item!);
			return (json(res, 200, { ok: true }), true);
		}
		if (parts.length === 6 && parts[5] === "start" && method === "POST") {
			const body =
				req.headers["content-length"] === "0"
					? {}
					: await readJson<StartMissionTaskRequest>(req).catch((error) => {
							if (error instanceof HttpError && error.status === 415) return {};
							throw error;
						});
			return (json(res, 201, await service.startTask(id, item!, body ?? {})), true);
		}
		return false;
	}
	if (section === "decision-proposals") {
		if (parts.length === 6 && method === "POST" && (parts[5] === "accept" || parts[5] === "reject")) {
			const write = await readJson<{ text?: string }>(req);
			return (json(res, 200, store.resolveProposal(id, item!, parts[5] === "accept", write?.text)), true);
		}
		return false;
	}
	if (section === "decisions") {
		if (parts.length === 6 && parts[5] === "supersede" && method === "POST") {
			const write = await readJson<{ replacementDecisionId: string }>(req);
			if (typeof write?.replacementDecisionId !== "string" || !write.replacementDecisionId)
				throw new HttpError(400, "replacementDecisionId is required");
			json(res, 200, store.supersedeDecision(id, item!, write.replacementDecisionId));
			return true;
		}
		if (parts.length === 4 && method === "POST") {
			const write = await readJson<MissionDecisionWrite>(req);
			return (json(res, 201, store.addDecision(id, write?.text, undefined, write?.audience)), true);
		}
		if (parts.length === 5 && method === "PATCH") {
			const write = await readJson<MissionDecisionWrite>(req);
			return (json(res, 200, store.updateDecision(id, item!, write?.text, undefined, write?.audience)), true);
		}
		if (parts.length === 5 && method === "DELETE") {
			store.removeDecision(id, item!);
			return (json(res, 200, { ok: true }), true);
		}
		return false;
	}
	if (section === "comments") {
		if (parts.length === 4 && method === "POST")
			return (json(res, 201, store.addComment(id, await readJson<MissionCommentWrite>(req))), true);
		if (parts.length === 6 && parts[5] === "resolve" && method === "POST")
			return (json(res, 200, store.resolveComment(id, item!)), true);
		if (parts.length === 5 && method === "DELETE") {
			store.removeComment(id, item!);
			return (json(res, 200, { ok: true }), true);
		}
		return false;
	}
	if (section === "resources") {
		if (parts.length === 6 && parts[5] === "linear-sync" && method === "POST") {
			const write = await readJson<{ action: "pause" | "resume" }>(req);
			return (json(res, 200, store.setLinearSyncPaused(id, item!, write?.action)), true);
		}
		if (parts.length === 4 && method === "POST")
			return (json(res, 201, store.addResource(id, await readJson<MissionResourceWrite>(req))), true);
		if (parts.length === 5 && method === "PATCH") {
			json(res, 200, store.updateResource(id, item!, await readJson<MissionResourceUpdate>(req)));
			return true;
		}
		if (parts.length === 5 && method === "DELETE") {
			store.removeResource(id, item!);
			return (json(res, 200, { ok: true }), true);
		}
		return false;
	}
	if (section === "artifacts") {
		if (parts.length === 4 && method === "POST")
			return (json(res, 201, await service.linkArtifact(id, await readJson<MissionArtifactLinkWrite>(req))), true);
		if (parts.length === 5 && method === "DELETE") {
			store.unlinkArtifact(id, item!, {}, url.searchParams.get("taskId") ?? undefined);
			return (json(res, 200, { ok: true }), true);
		}
		return false;
	}
	if (section === "events" && parts.length === 4) {
		if (method === "GET") {
			const before = url.searchParams.get("before");
			if (before !== null && !/^\d+$/.test(before)) throw new HttpError(400, "before must be an event ID");
			return (json(res, 200, store.events(id, before === null ? undefined : Number(before))), true);
		}
		if (method === "POST") return (json(res, 201, store.log(id, await readJson<MissionEventWrite>(req))), true);
	}
	return false;
}
