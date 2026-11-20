import type { BaseAgentEvent, EntryRecord, UserMessage } from "./agent-events.ts";
import type { DeliveryMode, PendingAutomaticInput } from "./chat-input.ts";
import type { GitHubAction } from "../github/github-actions.ts";

/** Durable user input waiting to join a run, in submission order. Passive writes are not messages. */
export interface QueuedMessage {
	/** Opaque captured-row precondition for opt-in guarded edits/removals. */
	guardToken?: string;
	id: number;
	mode: DeliveryMode;
	content: UserMessage["content"];
}

/** Queue contents are sent after the initial snapshot and whenever the durable inbox changes. */
export interface QueueUpdateEvent {
	type: "queue_update";
	items: QueuedMessage[];
	/** Absent from older workers; treat as empty. */
	automatic?: PendingAutomaticInput[];
}

/** Read-only projection of this chat's durable TODO store (also shared by its subagents). */
export interface SessionTodo {
	id: string;
	title: string;
	status: string;
	createdAt: string;
	assignedToSession?: string;
}

/** Full replacement, sent on subscription and after committed TODO progress changes. */
export interface TodosUpdateEvent {
	type: "todos_update";
	items: SessionTodo[];
}

/**
 * Chat sockets split a long snapshot: the `snapshot` event carries only its newest entries and `prefixPending: true`,
 * and this event follows in the next frame with the older entries of the same active transcript, before any later
 * event. Clients treat both together as one snapshot.
 */
export interface SnapshotPrefixEvent {
	type: "snapshot_prefix";
	/** Oldest first, all older than the snapshot's entries. */
	entries: EntryRecord[];
}

export interface GitHubActionsUpdateEvent {
	type: "github_actions_update";
	actions: GitHubAction[];
}
export type AgentEvent =
	| (BaseAgentEvent & { history?: TranscriptHistory })
	| { type: "history_error" }
	| QueueUpdateEvent
	| TodosUpdateEvent
	| SnapshotPrefixEvent
	| GitHubActionsUpdateEvent;

/**
 * GET /api/sessions/:id/subagents/:name/transcript[?after=<entryId>]: a read-only read of the subagent's
 * conversation. Responses carry an ETag; `If-None-Match` returns 304 when storage has not changed.
 * Clients that display a transcript should prefer the subagent socket (see SubagentServerMessage).
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

/**
 * GET /api/sessions/:id/history?before=<entryId>[&limit=<n>]: retained entries older than the active transcript,
 * which compaction or reset hides from the snapshot. Read from storage without waking a parked session. Entries are
 * oldest first and include older compaction and reset markers. `limit` defaults to 100 (at most 500); a page may
 * end early when its entries are large.
 * With optional JSON `view=TranscriptContext`, reads the immutable paged-snapshot range, including not-yet-loaded
 * active entries, and echoes context/before plus an explicit nextBefore. Legacy calls are unchanged.
 */
export interface SessionHistoryPage {
	entries: EntryRecord[];
	/** True when older entries may remain: request again with the oldest returned entry ID as `before`. */
	more: boolean;
	/** Opt-in paged snapshot context, echoed exactly. Legacy reads omit these fields. */
	context?: TranscriptContext;
	before?: number;
	nextBefore?: number;
}

/** Immutable storage range, not a mutation ACK or proof of the current agent context. */
export interface TranscriptContext {
	conversationId: number;
	tail: number;
	head?: { id: number; start: number };
}

/** Present only on explicitly requested recent snapshots. No prefix frame follows. */
export interface TranscriptHistory {
	/** Current question boundary, not inferred by loading historical question records. */
	question?: EntryRecord | null;
	context: TranscriptContext;
	more: boolean;
	before?: number;
}
