/** Global control APIs. All timestamps are epoch milliseconds. */
export type WatchEvent =
	| "chat.settled"
	| "chat.failed"
	| "pr.merged"
	| "pr.closed"
	| "pr.ready"
	| "linear.done"
	| "mission.task_done"
	| "mission.done";
export interface WatchTarget {
	kind: "chat" | "project" | "mission" | "pr" | "chat_prs" | "linear" | "task";
	id: string;
	missionId?: string;
}
export interface WatchInput {
	event: WatchEvent;
	target: WatchTarget;
	filter?: { outcome?: "done" | "failed" | "stopped" };
	mode: "once" | "persistent";
	note: string;
	expiresAt?: number;
}
export interface Watch extends WatchInput {
	id: string;
	createdAt: number;
}
/** GET /api/control-chat/watches?after=<id>&limit=40. ID order; limit 1..100. */
export interface WatchesResponse {
	watches: Watch[];
	next?: string;
}
/** DELETE /api/control-chat/watches/:id. Idempotent, including fired/expired watches. */
export interface CancelWatchResponse {
	removed: boolean;
}
export interface ControlAuditEntry {
	seq: number;
	operationId: string;
	action: string;
	phase: "requested" | "succeeded" | "failed";
	at: number;
	caller: string;
	args: Record<string, unknown>;
	result?: unknown;
}
/** GET /api/control-chat/audit?before=<seq>&limit=50, newest first, limit 1..50. */
export type ControlAuditResponse = ControlAuditEntry[];
/** GET/POST /api/control-chat. POST ensures the singleton without starting a turn. */
export type ControlChatResponse = import("./index.ts").SessionSummary;
/** Read-only browsing of the control chat's append-only memory. All routes 404 without a control chat. */
export type ControlMemoryKind = "user" | "assistant" | "tool" | "echo" | "event" | "note";
/** One summary range: messages id..id+n-1. `pending` lines have no summary yet. */
export interface ControlMemoryLine {
	id: number;
	n: number;
	text: string;
	pending?: boolean;
}
/** GET /api/control-chat/memory/view. The current view, oldest first. */
export interface ControlMemoryViewResponse {
	lines: ControlMemoryLine[];
}
/** A whole logged message page. Tool rows are JSON {name,input,text} with format "json". */
export interface ControlMemoryMessagePage {
	message: { id: number; at: number; kind: ControlMemoryKind; text: string; name?: string };
	format?: "json";
	/** Offset of the next page of the same message. */
	next?: number;
}
/** GET /api/control-chat/memory/nodes/:id/:n. n > 1 returns the two halves; n = 1 returns the message,
 * paged with `offset` (only allowed for n = 1). */
export type ControlMemoryNodeResponse = { lines: ControlMemoryLine[] } | ControlMemoryMessagePage;
/** A clipped log row. `input` is the tool input as JSON text. Full content via nodes/:id/1. */
export interface ControlMemoryLogEntry {
	id: number;
	at: number;
	kind: ControlMemoryKind;
	text: string;
	name?: string;
	input?: string;
	clipped?: boolean;
}
/** GET /api/control-chat/memory/messages?before=<id>&limit=50&q=<text>. Newest first, limit 1..100, q at most
 * 200 characters (case-insensitive substring of text, tool name or input). A search scans a bounded window, so a
 * page may hold fewer matches than `limit`; continue with `next` until it is absent. */
export interface ControlMemoryMessagesResponse {
	messages: ControlMemoryLogEntry[];
	next?: number;
}
/** GET /api/control-chat/memory/stats. */
export interface ControlMemoryStats {
	count: number;
	/** Summaries waiting to be built (queued or running). */
	pendingJobs: number;
	/** Summaries that failed; they retry with the next message. */
	failedJobs: number;
	viewBytes: number;
	merging: boolean;
	/** chat.sqlite plus its write-ahead log. */
	dbBytes: number;
	oldestAt?: number;
	newestAt?: number;
}
/** POST /api/sessions/:id/model. Incompatible context is rebuilt as a restorable model attempt. */
export type ChangeModelResponse = import("./index.ts").SessionSummary;
/** Small invalidations on /api/ws. Refetch bounded HTTP pages on change/reconnect. */
export type ControlMessage =
	| { type: "watches.changed" }
	| { type: "control-audit.changed" }
	/** Coalesced to at most one per second. */
	| { type: "control-memory.changed" }
	| { type: "dashboard.changed" };

export interface ControlDashboardChat {
	id: string;
	chatUrl: string;
	title: string;
	projectId?: string;
	missionId?: string;
	state: import("./index.ts").SessionState;
	working?: boolean;
	outcome?: import("./index.ts").SessionOutcome;
	model?: string;
}
export interface ControlDashboardAgent extends ControlDashboardChat {
	/** Latest user submission, else creation. Not worker uptime. */
	startedAt: number;
	elapsedMs: number;
}
export interface ControlDashboardMission {
	id: string;
	projectId: string;
	title: string;
	status: import("./index.ts").MissionStatus;
	tasksDone: number;
	tasksTotal: number;
	coordinatorSessionId?: string;
}
export interface ControlDashboardBlocker {
	id: string;
	kind: "blocked_task" | "failed_chat" | "question" | "failing_checks";
	projectId?: string;
	missionId?: string;
	sessionId?: string;
	taskId?: string;
	taskNumber?: number;
	title: string;
	detail?: string;
	at: number;
	url?: string;
	/** Required for failing_checks: failures from a cache verified against this exact head. */
	headSha?: string;
}
export interface ControlDashboardDecision {
	id: string;
	missionId: string;
	projectId: string;
	decisionId: string;
	kind: "edit" | "remove";
	text?: string;
	reason: string;
	authorSessionId: string;
	createdAt: number;
}
/** GET /api/control-chat/dashboard?projectId&missionId. Same snapshot as pilot status.
 * Local user only, daemon memory only, no worker starts. Unknown/duplicate parameters are 400.
 * At most 24,000 encoded bytes, 100 rows per list (200 projects, 50 missions); totals precede clipping.
 * Text is untrusted. Next contains global active watches with saved instructions, even for scoped requests.
 */
export interface ControlDashboardResponse {
	untrusted: true;
	source: "daemon-memory";
	projects: Array<{ id: string; name: string }>;
	chats: ControlDashboardChat[];
	/** All statuses retained for status-tool compatibility; activeMissions is the dashboard section. */
	missions: ControlDashboardMission[];
	pullRequests: Array<{ sessionId: string; url: string; title: string; number: number; state: "open" | "draft" }>;
	linear: Array<{ projectId: string; id: string; identifier?: string; title: string; status?: string; url?: string }>;
	runningAgents: ControlDashboardAgent[];
	activeMissions: ControlDashboardMission[];
	blockers: ControlDashboardBlocker[];
	pendingDecisions: ControlDashboardDecision[];
	next: { watches: Watch[]; total: number };
	totals: {
		projects: number;
		chats: number;
		missions: number;
		pullRequests: number;
		linear: number;
		runningAgents: number;
		activeMissions: number;
		blockers: number;
		pendingDecisions: number;
	};
	truncated: boolean;
}
