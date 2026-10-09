/** HTTP API and WebSocket event streams. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { getLibraryAsset, isArtifactLibrary } from "@pilot/artifacts";
import type {
	ArtifactLibrary,
	ChangeModelRequest,
	ClientMessage,
	CreateMissionRequest,
	EditQueuedMessageRequest,
	JoinMissionRequest,
	MissionArtifactLinkWrite,
	MissionBriefWrite,
	MissionCommentWrite,
	MissionDecisionWrite,
	MissionEventWrite,
	MissionResourceWrite,
	MissionTaskWrite,
	ProjectRequest,
	SendRequest,
	ServerMessage,
	SessionSummary,
	SpawnRequest,
	StartMissionTaskRequest,
	SubagentMessageRequest,
	UpdateMissionRequest,
} from "@pilot/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import { boundedSender } from "./backpressure.ts";
import { RepositoryChanges } from "./changes.ts";
import type { DaemonConfig } from "./config.ts";
import { Conflict, ServiceUnavailable } from "./errors.ts";
import type { ModelCatalog } from "./models.ts";
import { isAllowedOrigin } from "./origin.ts";
import type { MissionService } from "./mission-service.ts";
import type { MissionStore } from "./missions.ts";
import { expandHome, type ProjectStore } from "./projects.ts";
import { NotFound, type SessionManager } from "./sessions.ts";
import type { TerminalManager } from "./terminals.ts";

const MAX_BODY = 1024 * 1024;

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

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
	if (!req.headers["content-type"]?.startsWith("application/json"))
		throw new HttpError(415, "Expected application/json");
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY) throw new HttpError(413, "Request body too large");
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
type SessionClientMessage = Exclude<ClientMessage, MissionClientMessage | FocusClientMessage>;

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

/** Treat WebSocket JSON as untrusted input, not as an already-validated protocol union. */
function isClientMessage(value: unknown): value is SessionClientMessage {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const message = value as Record<string, unknown>;
	if (typeof message.type !== "string" || typeof message.sessionId !== "string" || !message.sessionId.trim())
		return false;
	switch (message.type) {
		case "subscribe":
		case "unsubscribe":
		case "terminal.detach":
		case "terminal.close":
			return true;
		case "subagent.subscribe":
		case "subagent.unsubscribe":
			return typeof message.name === "string" && message.name.length > 0 && message.name.length <= 128;
		case "terminal.input":
			return typeof message.data === "string";
		case "terminal.attach":
		case "terminal.resize":
			if (
				message.type === "terminal.attach" &&
				message.restart !== undefined &&
				typeof message.restart !== "boolean"
			)
				return false;
			return [message.cols, message.rows].every(
				(size) => typeof size === "number" && Number.isInteger(size) && size > 0 && size <= 1000,
			);
		default:
			return false;
	}
}

export function createDaemonServer(
	_config: DaemonConfig,
	sessions: SessionManager,
	projects: ProjectStore,
	models: ModelCatalog,
	terminals: TerminalManager,
	missions?: { service: MissionService; store: MissionStore },
): Server {
	sessions.setWorkspaceProcessGuard((id) => terminals.isRunning(id));
	const repositoryChanges = new RepositoryChanges();
	const route = async (req: IncomingMessage, res: ServerResponse) => {
		if (!isAllowedOrigin(req.headers.origin)) throw new HttpError(403, "Browser requests are not allowed");
		const url = new URL(req.url ?? "/", "http://localhost");
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts[0] !== "api") throw new HttpError(404, "Not found");
		if (missions && (await missionRoute(missions, parts, url, req, res))) return;
		if (parts[1] === "update" && parts[2] === "prepare" && parts.length === 3 && req.method === "POST")
			return json(res, 200, sessions.prepareUpdate());
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
		if (parts[1] === "models" && parts.length === 2 && req.method === "GET") {
			const projectId = url.searchParams.get("projectId");
			const cwd = projectId ? projects.require(projectId).path : expandHome(url.searchParams.get("cwd") || "~");
			return json(res, 200, await models.list(cwd));
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
		if (parts[1] === "sessions" && parts.length === 4 && parts[3] === "changes" && req.method === "GET") {
			const { cwd, base } = sessions.changeBase(parts[2]!);
			return json(res, 200, await repositoryChanges.changes(cwd, base));
		}
		if (
			parts[1] === "sessions" &&
			parts.length === 5 &&
			parts[3] === "changes" &&
			parts[4] === "summary" &&
			req.method === "GET"
		) {
			const { cwd, base } = sessions.changeBase(parts[2]!);
			return json(res, 200, await repositoryChanges.summary(cwd, base));
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
		if (parts[1] === "sessions" && parts.length === 4 && req.method === "POST") {
			const id = parts[2]!;
			if (parts[3] === "archive") return json(res, 200, await sessions.archive(id));
			if (parts[3] === "restore") return json(res, 200, await sessions.restore(id));
			if (parts[3] === "pin") return json(res, 200, await sessions.setPinned(id, true));
			if (parts[3] === "unpin") return json(res, 200, await sessions.setPinned(id, false));
			if (parts[3] === "reclaim-workspace") return json(res, 200, await sessions.reclaimWorkspace(id));
			if (parts[3] === "model") {
				const body = await readJson<ChangeModelRequest>(req);
				if (!body || typeof body.model !== "string" || !body.model.trim())
					throw new HttpError(400, "model is required");
				if (body.thinking !== undefined && (typeof body.thinking !== "string" || !body.thinking))
					throw new HttpError(400, "thinking must be a supported level");
				return json(res, 200, await sessions.changeModel(id, body.model, models, body.thinking));
			}
			if (parts[3] === "messages") {
				const body = await readJson<SendRequest>(req);
				await sessions.send(id, body.message, body.mode, body.requestId);
				return json(res, 202, { ok: true });
			}
			if (parts[3] === "stop") {
				await sessions.stop(id);
				return json(res, 202, { ok: true });
			}
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
			await sessions.editQueuedMessage(parts[2]!, Number(parts[4]), body.message);
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
		route(req, res).catch((error: unknown) => {
			const status =
				error instanceof HttpError
					? error.status
					: error instanceof ServiceUnavailable
						? 503
						: error instanceof NotFound
							? 404
							: error instanceof Conflict
								? 409
								: 400;
			const message = error instanceof Error ? error.message : String(error);
			if (!res.headersSent) json(res, status, { error: message });
			else res.end();
		});
	});

	// Large enough for terminal pastes.
	const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
	server.on("upgrade", (req, socket, head) => {
		const { pathname } = new URL(req.url ?? "/", "http://localhost");
		if (pathname !== "/api/ws" || !isAllowedOrigin(req.headers.origin)) {
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
	});

	const clients = new Map<WebSocket, (data: string) => void>();
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
	sessions.onChange((session) => {
		const previous = repositoryVersions.get(session.id);
		const version = repositoryVersion(session);
		if (previous?.version !== version) {
			if (previous && previous.cwd !== session.cwd) repositoryChanges.invalidate(previous.cwd);
			repositoryChanges.invalidate(session.cwd);
			repositoryVersions.set(session.id, { cwd: session.cwd, version });
		}
		broadcast({ type: "session", session });
	});
	projects.onChange((list) => {
		broadcast({ type: "projects", projects: list });
	});
	sessions.onArtifactsChanged((sessionId, artifacts) => {
		artifactVersions.set(sessionId, (artifactVersions.get(sessionId) ?? 0) + 1);
		broadcast({ type: "artifacts", sessionId, artifacts });
	});
	/** Subscribed sockets per mission. Detail is read once per change and shared. */
	const missionSubscribers = new Map<string, Set<WebSocket>>();
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
		const subscriptions = new Map<string, () => void>();
		const subagentSubscriptions = new Map<string, () => void>();
		const attachedTerminals = new Map<string, () => void>();
		send(ws, { type: "projects", projects: projects.list() });
		send(ws, { type: "sessions", sessions: sessions.list({ archived: "all" }) });
		if (missions) send(ws, { type: "missions", missions: missions.store.list() });
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
				if (!subscribers) missionSubscribers.set(missionId, (subscribers = new Set()));
				subscribers.add(ws);
				return pushMission(missionId, [ws]);
			}
			if (isFocusClientMessage(message)) return sessions.focusPullRequests(message.sessionIds);
			if (!isClientMessage(message)) return send(ws, { type: "error", message: "Invalid client message" });
			const { sessionId } = message;
			if (message.type.startsWith("terminal.")) {
				try {
					handleTerminal(message, attachedTerminals, ws);
				} catch (error) {
					send(ws, { type: "error", sessionId, message: error instanceof Error ? error.message : String(error) });
				}
			} else if (message.type === "subscribe" && !subscriptions.has(sessionId)) {
				try {
					const unsubscribe = sessions.subscribe(sessionId, (events) =>
						send(ws, { type: "events", sessionId, events }),
					);
					subscriptions.set(sessionId, unsubscribe);
					// An opened chat should show a fresh PR badge.
					sessions.focusPullRequests([sessionId]);
					const version = artifactVersions.get(sessionId);
					void sessions.artifacts(sessionId).then(
						(artifacts) => {
							// An update broadcast already supersedes an older in-flight snapshot.
							if (subscriptions.get(sessionId) === unsubscribe && artifactVersions.get(sessionId) === version)
								send(ws, { type: "artifacts", sessionId, artifacts });
						},
						(error: unknown) => {
							if (subscriptions.get(sessionId) === unsubscribe)
								send(ws, {
									type: "error",
									sessionId,
									message: error instanceof Error ? error.message : String(error),
								});
						},
					);
				} catch (error) {
					send(ws, { type: "error", sessionId, message: error instanceof Error ? error.message : String(error) });
				}
			} else if (message.type === "unsubscribe") {
				subscriptions.get(sessionId)?.();
				subscriptions.delete(sessionId);
			} else if (message.type === "subagent.subscribe" || message.type === "subagent.unsubscribe") {
				const { name } = message;
				const key = `${sessionId}\0${name}`;
				subagentSubscriptions.get(key)?.();
				subagentSubscriptions.delete(key);
				if (message.type === "subagent.unsubscribe") return;
				try {
					subagentSubscriptions.set(
						key,
						sessions.watchSubagent(sessionId, name, {
							events: (events) => send(ws, { type: "subagent.events", sessionId, name, events }),
							error: (error) => send(ws, { type: "error", sessionId, name, message: error }),
						}),
					);
				} catch (error) {
					send(ws, {
						type: "error",
						sessionId,
						name,
						message: error instanceof Error ? error.message : String(error),
					});
				}
			}
		});
		ws.on("close", () => {
			clients.delete(ws);
			for (const [id, subscribers] of missionSubscribers) {
				subscribers.delete(ws);
				if (!subscribers.size) missionSubscribers.delete(id);
			}
			for (const unsubscribe of subscriptions.values()) unsubscribe();
			subscriptions.clear();
			for (const unsubscribe of subagentSubscriptions.values()) unsubscribe();
			subagentSubscriptions.clear();
			for (const detach of attachedTerminals.values()) detach();
		});
	});

	function handleTerminal(message: SessionClientMessage, attached: Map<string, () => void>, ws: WebSocket): void {
		const { sessionId } = message;
		if (message.type === "terminal.attach" || message.type === "terminal.input") sessions.assertWritable(sessionId);
		switch (message.type) {
			case "terminal.attach": {
				const session = sessions.get(sessionId);
				if (!session) throw new NotFound(`Unknown session: ${sessionId}`);
				// A terminal must not start before the private clone is ready.
				const { cwd } = sessions.changeBase(sessionId);
				attached.get(sessionId)?.();
				attached.set(
					sessionId,
					terminals.attach(
						sessionId,
						cwd,
						message.cols,
						message.rows,
						{
							data: (data) => send(ws, { type: "terminal.data", sessionId, data }),
							exit: (code) => send(ws, { type: "terminal.exit", sessionId, code }),
						},
						message.restart === true,
					),
				);
				break;
			}
			case "terminal.detach":
				attached.get(sessionId)?.();
				attached.delete(sessionId);
				break;
			case "terminal.input":
				if (typeof message.data === "string") terminals.write(sessionId, message.data);
				break;
			case "terminal.resize":
				terminals.resize(sessionId, message.cols, message.rows);
				break;
			case "terminal.close":
				attached.get(sessionId)?.();
				attached.delete(sessionId);
				terminals.close(sessionId);
				break;
		}
	}

	return server;
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
	if (section === "tasks") {
		if (parts.length === 4 && method === "POST")
			return json(res, 201, store.addTask(id, await readJson<MissionTaskWrite>(req))), true;
		if (parts.length === 5 && method === "PATCH")
			return json(res, 200, store.updateTask(id, item!, await readJson<MissionTaskWrite>(req))), true;
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
	if (section === "decisions") {
		if (parts.length === 4 && method === "POST")
			return json(res, 201, store.addDecision(id, (await readJson<MissionDecisionWrite>(req))?.text)), true;
		if (parts.length === 5 && method === "PATCH")
			return (
				json(res, 200, store.updateDecision(id, item!, (await readJson<MissionDecisionWrite>(req))?.text)), true
			);
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
		if (parts.length === 4 && method === "POST")
			return json(res, 201, store.addResource(id, await readJson<MissionResourceWrite>(req))), true;
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
			store.unlinkArtifact(id, item!);
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
