/** Wire protocol between pilotd and its clients. Types only, safe to import from the browser. */
import type { UserMessage } from "@earendil-works/pi-ai";
import type { AgentEvent as DurableAgentEvent } from "@earendil-works/pi-durable";

export type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
export type {
	EntryRecord,
	MessageChange,
	SnapshotEvent,
	ToolSlot,
} from "@earendil-works/pi-durable";

/** Lifecycle as seen by the daemon. "parked" means no worker is running; the session resumes on demand. */
export type SessionState = "parked" | "starting" | "idle" | "working" | "failed";

/** Result of the latest settled run, independent of whether a worker is parked. */
export type SessionOutcome = "done" | "needs_input" | "failed" | "stopped";

export interface SessionCompletion {
	outcome: SessionOutcome;
	/** Stable completion version, in milliseconds. Reopening a session does not change it. */
	outcomeAt: number;
	outcomeReason?: string;
}

/** Latest GitHub pull request for the session's private branch, read by the daemon. */
export interface SessionPullRequest {
	number: number;
	url: string;
	title: string;
	state: "draft" | "open" | "merged" | "closed";
	/** Last successful GitHub lookup, epoch milliseconds. Cached across restarts. */
	checkedAt: number;
}

/** How a message joins a busy session: steer the current run, or queue a follow-up run. */
export type DeliveryMode = "steer" | "followUp";

/** Durable user input waiting to join a run, in submission order. Passive writes are not messages. */
export interface QueuedMessage {
	id: number;
	mode: DeliveryMode;
	content: UserMessage["content"];
}

/** Queue contents are sent after the initial snapshot and whenever the durable inbox changes. */
export interface QueueUpdateEvent {
	type: "queue_update";
	items: QueuedMessage[];
}

/** Read-only projection of the pi-extensions file-backed TODO store. */
export interface SessionTodo {
	id: string;
	title: string;
	status: string;
	createdAt: string;
	assignedToSession?: string;
}

/** Full replacement, sent on subscription and when TODO files change. */
export interface TodosUpdateEvent {
	type: "todos_update";
	items: SessionTodo[];
}

export type AgentEvent = DurableAgentEvent | QueueUpdateEvent | TodosUpdateEvent;

/** POST /api/update/prepare, no body. Ready holds new worker admissions for a 30-second lease. */
export interface UpdatePreparation {
	ready: boolean;
}

export interface SessionSummary {
	id: string;
	title: string;
	cwd: string;
	projectId?: string;
	/** The session's own branch, when it runs in a private clone. */
	branch?: string;
	createdAt: number;
	updatedAt: number;
	/** Epoch ms when archived. History and workspace are retained; restore before sending input. */
	archivedAt?: number;
	state: SessionState;
	outcome?: SessionOutcome;
	outcomeAt?: number;
	outcomeReason?: string;
	pullRequest?: SessionPullRequest;
	/** A lookup failed; pullRequest, if present, is the last known status, not a fresh result. */
	pullRequestError?: string;
	/** Resolved "provider/modelId", once the kernel has started. */
	model?: string;
	/** Latest context estimate and optional pi-extensions subscription snapshot. */
	usage?: SessionUsage;
	error?: string;
}

export interface ContextUsage {
	tokens?: number;
	contextWindow: number;
	percent?: number;
}

/** GET /api/sessions. Defaults to active sessions; projectId narrows either view. */
export interface SessionListQuery {
	archived?: "false" | "true" | "all";
	projectId?: string;
}

export interface SubscriptionUsage {
	/** Epoch ms of the provider snapshot, not the time it was forwarded. */
	fetchedAt: number;
	provider?: "anthropic" | "openai";
	windows: Array<{ label: string; usedPercent: number; resetsAt?: string }>;
	error?: string;
}

export interface SessionUsage {
	context?: ContextUsage;
	subscription?: SubscriptionUsage;
}

/** A named working directory. Sessions and triggers belong to projects. */
export interface Project {
	id: string;
	name: string;
	/** Absolute, existing directory. */
	path: string;
	/** Default model for new sessions, "provider/modelId". */
	model?: string;
	/** "clone" (default): each session works in a private clone on its own branch. "direct": in `path` itself. */
	workspace?: WorkspaceMode;
	createdAt: number;
}

export type WorkspaceMode = "clone" | "direct";

/** Offline libraries available inside the artifact sandbox. */
export type ArtifactLibrary = "react" | "react-dom" | "mermaid" | "echarts" | "motion" | "d3" | "three";
export type ArtifactKind = "html" | "react" | "image";

export interface ArtifactSummary {
	id: string;
	sessionId: string;
	projectId?: string;
	title: string;
	kind: ArtifactKind;
	revision: number;
	createdAt: number;
	updatedAt: number;
}

/** Source is editable code or an embedded image data URL; html is the prepared, sandboxed preview. */
export interface ArtifactRevision extends ArtifactSummary {
	source: string;
	html: string;
	libraries: ArtifactLibrary[];
}

export interface ArtifactWrite {
	title: string;
	kind: ArtifactKind;
	source: string;
	libraries?: ArtifactLibrary[];
}

/** Saved in a tool result, pinning the chat preview to its original revision. */
export interface ArtifactReference {
	id: string;
	sessionId: string;
	title: string;
	revision: number;
}

/** POST /api/projects, PATCH /api/projects/:id (partial). An empty model clears it. */
export interface ProjectRequest {
	path: string;
	name?: string;
	model?: string;
	workspace?: WorkspaceMode;
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
/** Returns a durable `starting` session before workspace preparation and kernel startup finish. */
export interface SpawnRequest {
	projectId?: string;
	cwd?: string;
	message: string;
	title?: string;
	/** "provider/modelId", optionally with ":thinking". Defaults to the project's, then pi's default model. */
	model?: string;
	thinking?: string;
}

/** POST /api/sessions/:id/model. Returns SessionSummary; only idle, non-archived chats may change. */
export interface ChangeModelRequest {
	/** Exact "provider/modelId" from the scoped model catalog. */
	model: string;
}

/** POST /api/sessions/:id/messages */
/** One file in a session's changes. */
export interface ChangedFile {
	path: string;
	status: "added" | "modified" | "deleted" | "renamed" | "untracked";
	additions: number;
	deletions: number;
	previousPath?: string;
}

/** GET /api/sessions/:id/changes: the working copy against the point the session branched from. */
export interface SessionChanges {
	base: string;
	branch?: string;
	files: ChangedFile[];
	/** Unified diff, capped at 1 MiB. */
	diff: string;
	truncated: boolean;
}

/** GET /api/sessions/:id/changes/summary: change metadata without file details or a diff. */
export interface SessionChangeSummary {
	base: string;
	branch?: string;
	fileCount: number;
}

export interface SendRequest {
	message: string;
	mode?: DeliveryMode;
	/** Idempotency key. Retrying with the same ID never submits twice. */
	requestId?: string;
}

/** PATCH /api/sessions/:id/queue/:submissionId. Keeps the message's queue position and delivery mode. */
export interface EditQueuedMessageRequest {
	message: string;
}

/** DELETE /api/sessions/:id/queue/:submissionId. No body. Only withdraws an input still in the durable queue. */
export interface RemoveQueuedMessageResponse {
	ok: true;
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
	/** Includes both active and archived sessions, so clients can switch views locally. */
	| { type: "sessions"; sessions: SessionSummary[] }
	| { type: "session"; session: SessionSummary }
	| { type: "projects"; projects: Project[] }
	| { type: "artifacts"; sessionId: string; artifacts: ArtifactSummary[] }
	/** Starts with a snapshot event on every (re)subscription, then incremental batches. */
	| { type: "events"; sessionId: string; events: AgentEvent[] }
	| { type: "terminal.data"; sessionId: string; data: string }
	| { type: "terminal.exit"; sessionId: string; code: number }
	| { type: "error"; sessionId?: string; message: string };

export const DEFAULT_PORT = 4319;
