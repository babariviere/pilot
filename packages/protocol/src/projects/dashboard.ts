import type { MissionSuccessorLink } from "../missions/missions.ts";
import type { SessionPullRequest } from "../github/pull-requests.ts";
import type { ChatMode, NeedsYouReason, NeedsYouReasonKind, SessionOutcome } from "../chats/session.ts";

/** Rows each project dashboard section carries. Sections also report their full `total`. */
export const DASHBOARD_SECTION_LIMIT = 5;

/** A bounded slice of a dashboard section: at most DASHBOARD_SECTION_LIMIT rows plus the full count. */
export interface DashboardSection<T> {
	/** Every matching row, not just those in `items`. */
	total: number;
	items: T[];
}

/**
 * Why something needs the user, most urgent first.
 * - `failed`: a chat's latest run failed and has not been reviewed.
 * - `question`: a chat's agent asked a question that is not answered yet (with `sessionId`), or an active mission
 *   has blocked tasks or open agent comments with no coordinator chat to take them (with `missionId` and `count`).
 * - `scheduled_failed`: a one-time scheduled item could not start.
 * - `scheduled_notice`: a recurring run was late, skipped, missed or failed. Late successes do not count in badges.
 * - `long_job`: a live job has run for at least one hour. User-only, even inside a mission.
 * - `unread`: a chat finished or stopped and its result has not been reviewed.
 */
export type DashboardNeedsYouKind =
	| "failed"
	| "question"
	| "scheduled_failed"
	| "scheduled_notice"
	| "long_job"
	| "mcp"
	| "tool_stall"
	| "pr_stuck"
	| "automation"
	| "no_pr"
	| "unread";

export interface DashboardNeedsYouItem {
	kind: DashboardNeedsYouKind;
	/** Stable row key. */
	id: string;
	title: string;
	/** `failed` and `unread`. */
	sessionId?: string;
	/** `question` always, chats when they belong to a mission. */
	missionId?: string;
	/** Scheduled failure or recurring notice: the scheduled item. */
	scheduledId?: string;
	/** Exact occurrence/handling times, without the saved prompt. */
	scheduleRun?: import("../automation/schedules.ts").ScheduleRun;
	scheduleTimeZone?: string;
	/** Late successes remain visible but do not count in badges. Omitted means true. */
	countsInBadge?: false;
	/** `failed` and `unread`. */
	outcome?: SessionOutcome;
	/** The chat can take one Continue (see SessionSummary.canContinue). */
	canContinue?: true;
	/** Failure or stop reason, one short line. */
	reason?: string;
	/** Shared attention vocabulary for metadata, tooltips and accessibility. */
	attentionReason: NeedsYouReason;
	/** `question`: blocked tasks plus open comments awaiting the user. */
	count?: number;
	/** `waits`: the chat's last message, at most a few screens. Only the Day overview fills it. */
	says?: string;
	/** Epoch ms: completion time, mission update time, or the item's scheduled time. Newest first within a kind. */
	at: number;
}

/** A PR a row can show without the whole SessionPullRequest. */
export interface DashboardPullRequestRef {
	number: number;
	url: string;
	state: SessionPullRequest["state"];
}

export interface DashboardWorkingItem {
	sessionId: string;
	title: string;
	state: "starting" | "working";
	mode: ChatMode;
	missionId?: string;
	missionTitle?: string;
	model?: string;
	branch?: string;
	pullRequest?: DashboardPullRequestRef;
	/** Latest user submission (else creation), epoch ms. Clients compute elapsed time locally. */
	startedAt: number;
}

/**
 * Merge readiness of an open PR, projected from SessionPullRequest.readiness.
 * Reasons are display labels; the session PR retains structured reasons and the health timestamp.
 */
export interface DashboardPullRequestReadiness {
	state: "ready" | "pending" | "blocked";
	reasons?: string[];
}

export interface DashboardPullRequest {
	number: number;
	url: string;
	title: string;
	state: "draft" | "open";
	branch?: string;
	/** Chat that owns the PR. */
	sessionId: string;
	sessionTitle: string;
	missionId?: string;
	checkedAt: number;
	readiness?: DashboardPullRequestReadiness;
}

export interface DashboardMission {
	id: string;
	title: string;
	/** Tasks by status, and tasks overall (dropped tasks excluded). To do and delegated tasks are the rest. */
	tasksDone: number;
	tasksInReview: number;
	tasksInProgress: number;
	tasksBlocked: number;
	tasksTotal: number;
	/** Member chats working now. */
	working: number;
	/** Needs-you rows belonging to the mission: its question count plus member chats with an unreviewed result. */
	needsYou: number;
	coordinatorSessionId?: string;
	/** Day overview only: the new mission that re-plans this old one. */
	successor?: MissionSuccessorLink;
	/** Day overview only: the old mission this new one re-plans. */
	replaces?: MissionSuccessorLink;
}

export interface DashboardRecentItem {
	sessionId: string;
	title: string;
	outcome: SessionOutcome;
	/** Epoch ms. */
	outcomeAt: number;
	missionId?: string;
	branch?: string;
	pullRequest?: DashboardPullRequestRef;
}

/** Extension point for scheduled items. Filled by the scheduler; absent until then (section total 0). */
export interface DashboardScheduledItem {
	id: string;
	title: string;
	/** What it will do. */
	kind: "chat" | "message";
	trigger: import("../automation/schedules.ts").ScheduleTrigger | "removed";
	/** Epoch ms: one-time instant or next recurring occurrence. */
	at?: number;
	/** Pending rows list under Scheduled. Failures and recurring notices also appear under Needs you. */
	state: "pending" | "failed" | "dispatching";
	recurrence?: import("../automation/schedules.ts").ScheduleRecurrence;
	paused?: true;
	/** Effective mission, host or global hold, observed without starting work. */
	held?: true;
	notice?: import("../automation/schedules.ts").ScheduleRun;
	/** Why it could not start. */
	error?: string;
	/** Target chat of a message, or most recent recurring run. */
	sessionId?: string;
}

/** Health of one tracked-item source. */
export type DashboardSourceStatus = import("../sources/tracking.ts").SourceStatus;

export interface DashboardTrackedItem {
	caseId?: string;
	linearSize?: import("../sources/tracking.ts").LinearSize;
	linearSizeOverride?: import("../sources/tracking.ts").LinearSize;
	slack?: import("../sources/tracking.ts").SlackTriage;
	id: string;
	title: string;
	url?: string;
	/** Source-specific label, for example a Linear state or a local Slack status. */
	status?: string;
	updatedAt?: number;
	externalId?: string;
	metadata?: Record<string, import("../sources/tracking.ts").TrackingJson>;
	/** Linear sub-issues: the parent's minimal header. */
	linearParent?: import("../sources/tracking.ts").LinearParentHeader;
	sessionId?: string;
	missionId?: string;
	sessionIds?: string[];
	missionIds?: string[];
}

/** Extension point for tracked items, one group per configured source. Empty until a source is configured. */
export interface DashboardTrackedSource {
	commonCases?: import("../sources/tracking.ts").SlackCommonCase[];
	/** Source identifier, for example "linear" or "slack". */
	source: string;
	label: string;
	status: DashboardSourceStatus;
	error?: string;
	/** Every active item of the source, including those in `done`. */
	total: number;
	/** Latest first. Linear lists open issues only: in progress, then to do, each by priority. */
	items: DashboardTrackedItem[];
	/** Linear only: completed and canceled issues, latest first, shown collapsed. */
	done?: DashboardSection<DashboardTrackedItem>;
	linear?: import("../sources/tracking.ts").LinearSourceSummary;
}

/** Counts for the headline sentence and the sidebar. */
export interface ProjectDashboardSummary {
	/** Active (not archived) chats of the project. 0 means a new project. */
	chats: number;
	working: number;
	/** Actionable rows only. Unlike `needsYou.total`, excludes informational late successes. */
	needsYou: number;
	openPullRequests: number;
	readyPullRequests: number;
	activeMissions: number;
}

/** GET /api/projects/:id/dashboard, and the payload of WS `dashboard`. Bounded, with no timestamps of its own. */
export interface ProjectDashboard {
	projectId: string;
	summary: ProjectDashboardSummary;
	needsYou: DashboardSection<DashboardNeedsYouItem>;
	working: DashboardSection<DashboardWorkingItem>;
	/** Open and draft PRs. Ready to merge first, then newest check first. */
	pullRequests: DashboardSection<DashboardPullRequest>;
	/** Active missions, those needing the user first. */
	missions: DashboardSection<DashboardMission>;
	scheduled: DashboardSection<DashboardScheduledItem>;
	/** One group per configured source, in a stable order. */
	tracked: DashboardTrackedSource[];
	/** Finished chats that are no longer waiting on the user, latest first. */
	recent: DashboardSection<DashboardRecentItem>;
}

/** Per-project counts for the sidebar scope switcher. Same figures as `ProjectDashboardSummary`. */
export interface ProjectDashboardCount {
	working: number;
	needsYou: number;
	/** Uncapped actionable row totals by reason. Excludes informational late successes. */
	needsYouReasons?: Partial<Record<NeedsYouReasonKind, number>>;
	/** Open tracked items the Inbox lists (Linear and Slack, without hidden labels). Omitted when 0. */
	tracked?: number;
}

/** GET /api/dashboard/counts, and the payload of WS `dashboard.counts`. Projects with no counts are omitted. */
export interface ProjectDashboardCounts {
	projects: Record<string, ProjectDashboardCount>;
}
