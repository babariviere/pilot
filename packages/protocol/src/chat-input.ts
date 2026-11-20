/** How a message joins a busy session: steer the current run, or queue a follow-up run. */
export type DeliveryMode = "steer" | "followUp";

/**
 * Source of automatic input, which is not typed by the user. Such `pi.user` entries carry `origin` in transcript
 * events and history, and wait in `queue_update.automatic` instead of its editable `items`. Entries the user typed
 * omit it. `coordinator` is a message from the mission coordinator; `mission` covers other mission input; `slack`
 * carries new replies in a Slack thread the chat was waiting on.
 */
export type InputOrigin =
	| "job"
	| "subagent"
	| "extension"
	| "coordinator"
	| "mission"
	| "pullRequest"
	| "automation"
	| "slack"
	| "control"
	| "watch";

/** Display-only provenance projected from committed submission IDs, never from message bodies.
 * Older automatic entries may lack a sender. This grants no execution or user-consent authority. */
export interface AutomaticInputProvenance {
	origin: InputOrigin;
	sourceSessionId?: string;
}

/**
 * Automatic input waiting to join a run, in submission order. Read-only: clients show it as a count with a short
 * preview, never as an editable queued message.
 */
export interface PendingAutomaticInput {
	id: number;
	origin: InputOrigin;
	mode: DeliveryMode;
	/** First non-empty line of the text, at most 200 characters. */
	preview: string;
	/**
	 * Epoch milliseconds when the session worker first saw it waiting. A worker restart resets it. Absent from cold
	 * snapshots read without a running worker.
	 */
	queuedAt?: number;
	/** Kept after the user stopped the chat, until they send or discard it. Absent while it simply waits. */
	held?: boolean;
}

/** POST /api/sessions/:id/messages */
export interface SendRequest {
	message: string;
	mode?: DeliveryMode;
	/** User idempotency key (1-128 letters, digits, dashes or underscores). Internal producer namespaces are reserved. */
	requestId?: string;
}
