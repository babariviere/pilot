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
export type SessionOutcome = "done" | "failed" | "stopped";

export interface SessionCompletion {
	outcome: SessionOutcome;
	/** Stable completion version, in milliseconds. Reopening a session does not change it. */
	outcomeAt: number;
	outcomeReason?: string;
}

/** A GitHub pull request opened from one of the session's branches, read by the daemon. */
export interface SessionPullRequest {
	number: number;
	url: string;
	title: string;
	state: "draft" | "open" | "merged" | "closed";
	/** Head branch. Omitted by older daemons. */
	branch?: string;
	/** GitHub's merge time, epoch milliseconds, for merged PRs. */
	mergedAt?: number;
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
	/** Omitted by older daemons, meaning Build. */
	mode?: ChatMode;
	/** Actual Build workspace policy, including isolated workspaces without a task branch. */
	workspace?: WorkspaceMode;
	/** Shared jj repository storage. Omitted for legacy clones and direct checkouts. */
	workspaceStorage?: "shared";
	/** Epoch ms when the working directory was reclaimed. Its pinned jj snapshot can be restored on resume. */
	workspaceReclaimedAt?: number;
	/** Last safe-cleanup failure. History remains available and the workspace is not discarded unsafely. */
	workspaceCleanupError?: string;
	/** Exact origin branch selected for an Ask snapshot or resolved as a Build base, when known. */
	sourceBranch?: string;
	/** Commit resolved for the Ask source. */
	sourceCommit?: string;
	id: string;
	title: string;
	cwd: string;
	/** Session storage directory containing metadata and durable history, not the working directory. */
	sessionPath?: string;
	projectId?: string;
	/** The session's own branch or task bookmark, when it runs in an isolated workspace. */
	branch?: string;
	createdAt: number;
	updatedAt: number;
	/** Latest user submission, epoch milliseconds. Stable across metadata/PR polling. */
	lastUserMessageAt?: number;
	/** Epoch ms when archived. History is retained with recoverable jj snapshots; restore before sending input. */
	archivedAt?: number;
	state: SessionState;
	outcome?: SessionOutcome;
	outcomeAt?: number;
	outcomeReason?: string;
	/** PR for the current branch. */
	pullRequest?: SessionPullRequest;
	/**
	 * Every PR the session opened, the current branch's first, then earlier branches newest first.
	 * Omitted when there are none, or by older daemons (use pullRequest).
	 */
	pullRequests?: SessionPullRequest[];
	/** A lookup failed; pull requests, if present, are the last known status, not a fresh result. */
	pullRequestError?: string;
	/** Resolved "provider/modelId", once the kernel has started. */
	model?: string;
	/** Effective thinking level, once the kernel has started. */
	thinking?: string;
	/** Latest context estimate and optional pi-extensions subscription snapshot. */
	usage?: SessionUsage;
	/** Named background subagents, in spawn order. Omitted when the session has none. */
	subagents?: SessionSubagent[];
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

/** One named background subagent of a session, from the pi-extensions subagents host events. */
export interface SessionSubagent {
	name: string;
	/** "working" while the subagent has admitted input it has not answered. */
	state: "working" | "idle";
	/** The spawn message. */
	task: string;
	/** Epoch milliseconds. */
	createdAt: number;
	/** Working directory pinned at spawn. */
	cwd: string;
	/** "provider/modelId" pinned at spawn. */
	model?: string;
	/** Identity of the latest completed answer. A change means a new answer. */
	lastAnswerId?: string;
	error?: string;
	/** Retired night conversation. It cannot accept new messages. */
	retired?: boolean;
}

/**
 * GET /api/sessions/:id/subagents/:name/transcript[?after=<entryId>]: a read-only read of the subagent's
 * conversation. Responses carry an ETag; `If-None-Match` returns 304 when storage has not changed.
 * Clients that display a transcript should prefer the `subagent.subscribe` WebSocket stream.
 */
export interface SubagentTranscript {
	name: string;
	/** True: `events` replaces the transcript (one snapshot, or none before the subagent started). */
	full: boolean;
	/** A snapshot event when full, otherwise `entry_appended` events after `after`. */
	events: AgentEvent[];
	/** Newest entry ID included; pass as `after` for the next read. */
	cursor?: number;
}

/** POST /api/sessions/:id/subagents/:name/messages. Steers current work by default. */
export interface SubagentMessageRequest {
	message: string;
	mode?: DeliveryMode;
	/** Idempotency key. Retrying with the same ID admits the message once. */
	requestId?: string;
}

/** A named working directory. Sessions and triggers belong to projects. */
export interface Project {
	id: string;
	name: string;
	/** Absolute, existing directory. */
	path: string;
	/** Default model for new sessions, "provider/modelId". */
	model?: string;
	/** "clone" (default): each session works in a private clone. "direct": in `path` itself. */
	workspace?: WorkspaceMode;
	/** Require branch/PR delivery. Defaults to true; false permits direct default-branch pushes. */
	requirePullRequest?: boolean;
	createdAt: number;
}

export type WorkspaceMode = "clone" | "direct";

/** Build may modify its workspace; Ask is read-only. Omitted mode defaults to Build. */
export type ChatMode = "build" | "ask";

/** GET /api/projects/:id/branches. Live origin heads only; mode=ask or workspace=clone also allows direct projects. */
export interface RemoteBranchList {
	/** Exact origin head names, sorted lexically. No remote-tracking prefix is added; HEAD is excluded. */
	branches: string[];
	/** Origin's symbolic HEAD, when it names an advertised branch. */
	defaultBranch?: string;
}

/** Offline libraries available inside the artifact sandbox. */
export type ArtifactLibrary = "react" | "react-dom" | "mermaid" | "echarts" | "motion" | "d3" | "three";
export type ArtifactKind = "html" | "react" | "image" | "swiftui";

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
	requirePullRequest?: boolean;
}

/** One selectable model, from the user's pi scope. */
export interface ModelOption {
	/** "provider/modelId", the value to send as `model`. */
	id: string;
	provider: string;
	name: string;
	reasoning?: boolean;
	/** Ordered thinking levels supported by this model (non-reasoning models offer only "off"). */
	thinkingLevels?: string[];
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
	/** Omitted means Build. */
	mode?: ChatMode;
	/** Per-chat Build override. Omitted uses project settings; cwd-only cannot request a clone. */
	workspace?: WorkspaceMode;
	projectId?: string;
	cwd?: string;
	/** Exact origin head name, without adding `origin/`. Prefixes within real names are literal.
	 * Build: only private-clone workspaces without a cwd override may select; omission uses default-base policy.
	 * Ask: omission reads current checkout; selection reads a branch snapshot without a private clone.
	 * An explicit unavailable branch fails preparation. */
	baseBranch?: string;
	message: string;
	title?: string;
	/** "provider/modelId", optionally with ":thinking". Defaults to the project's, then pi's default model. */
	model?: string;
	thinking?: string;
}

/** POST /api/sessions/:id/model. Sets model and optional thinking; only idle, non-archived chats may change. */
export interface ChangeModelRequest {
	/** Exact "provider/modelId" from the scoped model catalog. */
	model: string;
	/** Explicit supported level, overriding the model's scoped default for this chat. */
	thinking?: string;
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
	additions: number;
	deletions: number;
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
	| { type: "terminal.close"; sessionId: string }
	/** Stream one subagent's transcript: a snapshot first (also after reconnects), then appended entries. */
	| { type: "subagent.subscribe"; sessionId: string; name: string }
	| { type: "subagent.unsubscribe"; sessionId: string; name: string };

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
	/** Replaces the transcript when it contains a snapshot (or is empty); otherwise appends entries. */
	| { type: "subagent.events"; sessionId: string; name: string; events: AgentEvent[] }
	| { type: "error"; sessionId?: string; name?: string; message: string };

export const DEFAULT_PORT = 4319;
