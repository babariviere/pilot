/** HTTP API and WebSocket event streams. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { getLibrary, isArtifactLibrary } from "@pilot/artifacts";
import type {
	ArtifactLibrary,
	ClientMessage,
	ChangeModelRequest,
	EditQueuedMessageRequest,
	ProjectRequest,
	SendRequest,
	ServerMessage,
	SpawnRequest,
} from "@pilot/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import { collectChangeSummary, collectChanges } from "./changes.ts";
import type { DaemonConfig } from "./config.ts";
import { Conflict, ServiceUnavailable } from "./errors.ts";
import type { ModelCatalog } from "./models.ts";
import { isAllowedOrigin } from "./origin.ts";
import { expandHome, type ProjectStore } from "./projects.ts";
import { NotFound, type SessionManager } from "./sessions.ts";
import type { TerminalManager } from "./terminals.ts";

const MAX_BODY = 1024 * 1024;

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
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

/** Treat WebSocket JSON as untrusted input, not as an already-validated protocol union. */
function isClientMessage(value: unknown): value is ClientMessage {
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
): Server {
	const route = async (req: IncomingMessage, res: ServerResponse) => {
		if (!isAllowedOrigin(req.headers.origin)) throw new HttpError(403, "Browser requests are not allowed");
		const url = new URL(req.url ?? "/", "http://localhost");
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts[0] !== "api") throw new HttpError(404, "Not found");
		if (parts[1] === "update" && parts[2] === "prepare" && parts.length === 3 && req.method === "POST")
			return json(res, 200, sessions.prepareUpdate());
		if (parts[1] === "artifact-libraries" && parts.length === 3 && req.method === "GET") {
			const name = parts[2]!;
			if (!isArtifactLibrary(name)) throw new HttpError(404, "Unknown artifact library");
			const source = await getLibrary(name as ArtifactLibrary);
			res.writeHead(200, { "content-type": "text/javascript", "x-content-type-options": "nosniff" });
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
		if (parts[1] === "sessions" && parts.length === 2) {
			if (req.method === "GET") {
				const archived = url.searchParams.get("archived") ?? "false";
				if (archived !== "false" && archived !== "true" && archived !== "all")
					throw new HttpError(400, "archived must be false, true or all");
				return json(
					res,
					200,
					sessions.list({ archived, projectId: url.searchParams.get("projectId") ?? undefined }),
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
			return json(res, 200, await collectChanges(cwd, base));
		}
		if (
			parts[1] === "sessions" &&
			parts.length === 5 &&
			parts[3] === "changes" &&
			parts[4] === "summary" &&
			req.method === "GET"
		) {
			const { cwd, base } = sessions.changeBase(parts[2]!);
			return json(res, 200, await collectChangeSummary(cwd, base));
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

	const clients = new Set<WebSocket>();
	const artifactVersions = new Map<string, number>();
	const send = (ws: WebSocket, message: ServerMessage) => {
		if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
	};
	sessions.onChange((session) => {
		for (const ws of clients) send(ws, { type: "session", session });
	});
	projects.onChange((list) => {
		for (const ws of clients) send(ws, { type: "projects", projects: list });
	});
	sessions.onArtifactsChanged((sessionId, artifacts) => {
		artifactVersions.set(sessionId, (artifactVersions.get(sessionId) ?? 0) + 1);
		for (const ws of clients) send(ws, { type: "artifacts", sessionId, artifacts });
	});

	wss.on("connection", (ws: WebSocket) => {
		clients.add(ws);
		const subscriptions = new Map<string, () => void>();
		const attachedTerminals = new Map<string, () => void>();
		send(ws, { type: "projects", projects: projects.list() });
		send(ws, { type: "sessions", sessions: sessions.list({ archived: "all" }) });
		ws.on("message", (raw) => {
			let message: unknown;
			try {
				message = JSON.parse(String(raw));
			} catch {
				return send(ws, { type: "error", message: "Invalid JSON" });
			}
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
			}
		});
		ws.on("close", () => {
			clients.delete(ws);
			for (const unsubscribe of subscriptions.values()) unsubscribe();
			subscriptions.clear();
			for (const detach of attachedTerminals.values()) detach();
		});
	});

	function handleTerminal(message: ClientMessage, attached: Map<string, () => void>, ws: WebSocket): void {
		const { sessionId } = message;
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
