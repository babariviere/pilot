/** Wire protocol between pilotd and its clients. Types only, safe to import from the browser. */
import type { AgentEvent } from "@earendil-works/pi-durable";

export type {
	AgentEvent,
	EntryRecord,
	MessageChange,
	SnapshotEvent,
	ToolSlot,
} from "@earendil-works/pi-durable";
export type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

/** Lifecycle as seen by the daemon. "parked" means no worker is running; the session resumes on demand. */
export type SessionState = "parked" | "starting" | "idle" | "working" | "failed";

/** How a message joins a busy session: steer the current run, or queue a follow-up run. */
export type DeliveryMode = "steer" | "followUp";

export interface SessionSummary {
	id: string;
	title: string;
	cwd: string;
	projectId?: string;
	createdAt: number;
	updatedAt: number;
	state: SessionState;
	/** Resolved "provider/modelId", once the kernel has started. */
	model?: string;
	error?: string;
}

/** A named working directory. Sessions and triggers belong to projects. */
export interface Project {
	id: string;
	name: string;
	/** Absolute, existing directory. */
	path: string;
	/** Default model for new sessions, "provider/modelId". */
	model?: string;
	createdAt: number;
}

/** POST /api/projects, PATCH /api/projects/:id (partial). An empty model clears it. */
export interface ProjectRequest {
	path: string;
	name?: string;
	model?: string;
}

/** One selectable model, from the user's pi scope. */
export interface ModelOption {
	/** "provider/modelId", the value to send as `model`. */
	id: string;
	provider: string;
	name: string;
	reasoning?: boolean;
	/** Thinking level pinned by the scope pattern ("model:high"). */
	thinking?: string;
}

/** GET /api/models?projectId=… or ?cwd=… */
export interface ModelList {
	models: ModelOption[];
	/** pi's default model for that directory. */
	defaultModel?: string;
}

/** POST /api/sessions. Needs a projectId, a cwd, or both (cwd overrides the project's path). */
export interface SpawnRequest {
	projectId?: string;
	cwd?: string;
	message: string;
	title?: string;
	/** "provider/modelId", optionally with ":thinking". Defaults to the project's, then pi's default model. */
	model?: string;
	thinking?: string;
}

/** POST /api/sessions/:id/messages */
export interface SendRequest {
	message: string;
	mode?: DeliveryMode;
	/** Idempotency key. Retrying with the same ID never submits twice. */
	requestId?: string;
}

/** Client to daemon, over /api/ws. */
export type ClientMessage =
	| { type: "subscribe"; sessionId: string }
	| { type: "unsubscribe"; sessionId: string }
	/**
	 * Attach to the session's daemon-owned shell, starting it if needed (or replacing it with `restart`).
	 * The daemon replies with the retained scrollback, then live output.
	 */
	| { type: "terminal.attach"; sessionId: string; cols: number; rows: number; restart?: boolean }
	/** Stop receiving output. The shell keeps running. */
	| { type: "terminal.detach"; sessionId: string }
	| { type: "terminal.input"; sessionId: string; data: string }
	| { type: "terminal.resize"; sessionId: string; cols: number; rows: number }
	/** Kill the shell. */
	| { type: "terminal.close"; sessionId: string };

/** Daemon to client, over /api/ws. */
export type ServerMessage =
	| { type: "sessions"; sessions: SessionSummary[] }
	| { type: "session"; session: SessionSummary }
	| { type: "projects"; projects: Project[] }
	/** Starts with a snapshot event on every (re)subscription, then incremental batches. */
	| { type: "events"; sessionId: string; events: AgentEvent[] }
	| { type: "terminal.data"; sessionId: string; data: string }
	| { type: "terminal.exit"; sessionId: string; code: number }
	| { type: "error"; sessionId?: string; message: string };

export const DEFAULT_PORT = 4319;
