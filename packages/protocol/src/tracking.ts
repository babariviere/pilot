/** External text is untrusted. Tracking never starts agents. Only a confirmed Linear start may update its workflow state. */
export type TrackedKind = "linear" | "slack";
export type TrackingJson = null | boolean | number | string | TrackingJson[] | { [key: string]: TrackingJson };

export type SlackMessageType = "bug" | "question" | "request" | "unknown";
export type SlackSeverity = "low" | "medium" | "high" | "critical";
export type SlackLocalStatus = "open" | "in_progress" | "done" | "dismissed";
/**
 * What a project label does to its Slack messages. none: listed as usual. hide: kept out of the Inbox, behind
 * Show hidden in Slack triage. close: dismissed by Pilot when the label is applied (by the classifier or the user),
 * unless the user set the message's status; reopened when the label no longer applies or stops closing.
 */
export type SlackLabelEffect = "none" | "hide" | "close";
/** Name is the project-local label identity. No built-in labels. */
export interface SlackProjectLabel {
	name: string;
	description: string;
	/** Omitted means none. pilotd always stores it, and reads an older `hideFromInbox: true` as hide. */
	effect?: SlackLabelEffect;
}
export interface SlackOverrides {
	type?: SlackMessageType;
	/** null explicitly clears the label; omission leaves it unchanged. */
	label?: string | null;
	severity?: SlackSeverity;
	status?: SlackLocalStatus;
}
/** Effective values after applying durable user overrides. */
export interface SlackTriage {
	type: SlackMessageType;
	label: string | null;
	severity: SlackSeverity;
	status: SlackLocalStatus;
	overrides: SlackOverrides;
	/** Set while Pilot keeps the message dismissed because of this close label. Any status the user sets clears it. */
	closedByLabel?: string;
}
/** GET /api/tracking/slack/corrections?projectId=... (newest first, at most 20). */
export interface SlackCorrection {
	itemId: string;
	summary: string;
	correctedAt: number;
	values: SlackOverrides;
}
export interface ProjectTrackingConfig {
	slackLabels?: SlackProjectLabel[];
	/** Slack channel IDs from the channel picker. Older configs may hold names. */
	slackChannels: string[];
	/** Display names by channel ID, for settings and rows. Never part of the poll scope. */
	slackChannelNames?: Record<string, string>;
	/** Linear team ID from list_teams. Empty string in a settings request clears the team. */
	linearTeam?: string;
	/** Display name of the attached team. */
	linearTeamName?: string;
}
export interface TrackedItem {
	id: string;
	projectId: string;
	kind: TrackedKind;
	externalId: string;
	title: string;
	url: string;
	status: string;
	/** Local start results, preserved by sync:
	 * linearStart { outcome: moved|skipped|error, attemptedAt, error? };
	 * slackStart { outcome: reacted|skipped|error, attemptedAt, error? }, once per item. */
	metadata: Record<string, TrackingJson>;
	dismissed: boolean;
	slack?: SlackTriage;
	/** Latest chat and mission started from (or linked to) this item. */
	sessionId?: string;
	missionId?: string;
	/** Every bound chat and mission, oldest first, bounded. Present when at least one is bound. */
	sessionIds?: string[];
	missionIds?: string[];
	createdAt: number;
	updatedAt: number;
}
/** Local actions, except confirmed starts (Linear state or Slack eyes). A link adds to the item's bound chats or missions; null clears them all.
 * Source refreshes never overwrite these fields. */
export interface TrackedItemPatch {
	/** Only on confirmed Start chat/mission, with exactly one new link. Never for ordinary linking. */
	start?: boolean;
	slack?: SlackOverrides;
	dismissed?: boolean;
	sessionId?: string | null;
	missionId?: string | null;
}
/** GET /api/tracked-items?projectId=...&kind=...&dismissed=true&limit=...&offset=...
 * closedByLabel=true lists only Slack messages a close label dismissed (implies dismissed=true). */
export interface TrackedItemList {
	items: TrackedItem[];
	total: number;
}
export type SourceStatus = "not_configured" | "idle" | "ok" | "syncing" | "sign_in_required" | "error";
/** Browser sign-in to the dedicated MCP server of a kind, run by pilotd through pi's MCP OAuth flow.
 * One at a time per server. Tokens stay in pi's mcp-auth.json and never reach clients. */
export interface SourceSignIn {
	kind: TrackedKind;
	/** waiting: the browser was opened (or is about to be) and pilotd waits for approval. */
	state: "waiting" | "done" | "failed" | "cancelled";
	/** Sign in again while signed in (another account or new scope). */
	again?: boolean;
	startedAt: number;
	/** When a waiting sign-in gives up. */
	expiresAt: number;
	finishedAt?: number;
	/** Short, sanitized reason for a failed sign-in. */
	error?: string;
}
/** POST /api/tracking/:kind/sign-in starts (or returns the running) sign-in; DELETE cancels it. */
export interface SourceSignInRequest {
	again?: boolean;
}
/** Progress covers only my issues, never the team's overall workload. */
export interface LinearCycleSummary {
	id: string;
	name?: string;
	number: number;
	startsAt: string;
	endsAt: string;
	progress: number;
	total: number;
	done: number;
	inProgress: number;
	todo: number;
}
export interface LinearSourceSummary {
	cycleStatus: "current" | "no_active_cycle";
	currentCycle?: LinearCycleSummary;
	statusMessage?: string;
}
/** GET /api/tracked-items/:id/prefill. Transient, never bulk-stored or broadcast. */
export interface TrackedItemPrefill {
	itemId: string;
	identifier: string;
	title: string;
	url: string;
	description: string;
	gitBranchName?: string;
	/** Explicitly quoted external content. User confirmation is required before starting work. */
	prompt: string;
}
/** GET /api/tracked-items/:id/excerpt. The first message of a Slack thread, read on demand for the triage
 * inspector. Transient: never stored or broadcast. Plain text, bounded and stripped of control characters. */
export interface SlackExcerpt {
	itemId: string;
	/** Display name of the author, when Slack shows one. */
	author?: string;
	/** Empty when the message has no text (for example, only files). */
	text: string;
	/** The message was longer and was cut, ending with an ellipsis. */
	truncated: boolean;
}
/** Per-channel health of a configured Slack channel. */
export interface SlackChannelStatus {
	/** As configured: a channel ID, or a name in older configs. */
	id: string;
	name?: string;
	/** pending: not pulled since it was added. */
	status: "pending" | "ok" | "error" | "sign_in_required";
	lastPulledAt?: number;
	error?: string;
}
export interface TrackingSource {
	/** Stable project-scoped identifier, <projectId>:<kind>. */
	id: string;
	projectId: string;
	kind: TrackedKind;
	label: string;
	configured: boolean;
	status: SourceStatus;
	lastPolledAt?: number;
	error?: string;
	/** Terminal fallback. Clients offer Sign in (POST /api/tracking/:kind/sign-in) instead. */
	signInCommand?: string;
	nextPollAt?: number;
	linear?: LinearSourceSummary;
	/** Slack only: one entry per configured channel, in configuration order. */
	channels?: SlackChannelStatus[];
	/** Latest browser sign-in for this kind's server, shared by every project. */
	signIn?: SourceSignIn;
}
/** A team from the dedicated linear server's list_teams, for the project settings picker. */
export interface LinearTeamOption {
	id: string;
	name: string;
	key: string;
	/** Parent team ID when the team is a sub-team. */
	parentId?: string;
}
/** A channel from slack_search_channels or slack_list_user_channels. */
export interface SlackChannelOption {
	id: string;
	name: string;
	private: boolean;
}
/** GET /api/tracking/linear/teams?query=... and GET /api/tracking/slack/channels?query=...
 * Read-only lookups for project settings. A missing query lists my channels (Slack) or all teams (Linear). */
export interface TrackingLookup<T> {
	status: "ok" | "sign_in_required" | "error";
	items: T[];
	/** More results exist than were returned. Refine the query. */
	more?: boolean;
	error?: string;
	signInCommand?: string;
}
