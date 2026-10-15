/** Wire protocol between pilotd and its clients. Types only, safe to import from the browser. */
import type { UserMessage } from "@earendil-works/pi-ai";
import type { AgentEvent as DurableAgentEvent, EntryRecord } from "@earendil-works/pi-durable";
import type { ProjectTrackingConfig, TrackingSource } from "./tracking.ts";

export type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
export type {
	EntryRecord,
	MessageChange,
	SnapshotEvent,
	ToolSlot,
} from "@earendil-works/pi-durable";

/** Lifecycle as seen by the daemon. "parked" means no worker is running; the session resumes on demand. */
export type SessionState = "parked" | "starting" | "idle" | "working" | "failed";

/**
 * Result of the latest settled run, independent of whether a worker is parked. "question": the run ended on an
 * ask_user question, so the chat waits for the user's reply.
 */
export type SessionOutcome = "done" | "failed" | "stopped" | "question";

export interface SessionCompletion {
	outcome: SessionOutcome;
	/** Stable completion version, in milliseconds. Reopening a session does not change it. */
	outcomeAt: number;
	/** Bounded, redacted failure diagnostic, including the failing step and available causes. For a question, its text. */
	outcomeReason?: string;
}

/** A GitHub pull request discovered from a session branch or explicitly bound to the session. */
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
	/** Read-only GitHub stack membership. Absent for unstacked PRs or unsupported servers. */
	stack?: PullRequestStack;
	/** Merge readiness from the last successful health lookup. Absent until checked, or for terminal PRs. */
	readiness?: PullRequestReadiness;
}

/** POST /api/sessions/:id/pull-requests. Returns SessionSummary & PullRequestBindingResult. */
export interface BindPullRequestRequest {
	/** GitHub PR URL, or a positive number (123 or #123, no leading zero) in the project's GitHub upstream. */
	url: string;
	/** Optional mission task ID or number to disambiguate the owning task. */
	taskId?: string;
}

/** DELETE /api/sessions/:id/pull-requests. Returns SessionSummary & PullRequestBindingResult. */
export interface UnbindPullRequestRequest {
	url: string;
}

export interface PullRequestReadiness {
	state: "ready" | "pending" | "blocked";
	reasons: PullRequestReadinessReason[];
	/** Health lookup time, independent of PR discovery, epoch milliseconds. Cached across restarts. */
	checkedAt: number;
}

export interface PullRequestReadinessReason {
	code:
		| "failing_checks"
		| "unresolved_comments"
		| "conflicts"
		| "draft"
		| "changes_requested"
		| "review_required"
		| "behind"
		| "merge_state"
		| "checks_pending"
		| "mergeability_unknown"
		| "readiness_unknown";
	names?: string[];
	count?: number;
	/** Raw GitHub review decision, merge state or diverged base branch. */
	value?: string;
}

export interface PullRequestStack {
	/** Stack number within the PR's repository. */
	number: number;
	/** One-based position, bottom to top. */
	position: number;
	size: number;
	/** Ultimate base of the stack, not this PR's immediate base. */
	baseBranch: string;
}

/** How a message joins a busy session: steer the current run, or queue a follow-up run. */
export type DeliveryMode = "steer" | "followUp";

/**
 * Source of automatic input, which is not typed by the user. Such `pi.user` entries carry `origin` in transcript
 * events and history, and wait in `queue_update.automatic` instead of its editable `items`. Entries the user typed
 * omit it. `coordinator` is a message from the mission coordinator; `mission` covers other mission input.
 */
export type InputOrigin = "job" | "subagent" | "extension" | "coordinator" | "mission" | "pullRequest";

/** Durable user input waiting to join a run, in submission order. Passive writes are not messages. */
export interface QueuedMessage {
	id: number;
	mode: DeliveryMode;
	content: UserMessage["content"];
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

/** Sanitized execution audit. Null means no authoritative command exit was exposed. */
export type GitHubAction = {
	id: string;
	/** Optional only for audits recorded by older kernels. */
	kind?: "push" | "pr_opened" | "pr_ready" | "pr_draft" | "pr_edited" | "pr_reopened" | "github_updated";
	branch?: string;
	prNumber?: number;
	title?: string;
	/** Top-level call, including when a nested codemode call performed the action. */
	toolCallId?: string;
	afterEntryId?: number;
	conversationId?: string;
	/** Membership at execution time, not at replay time. */
	missionId?: string;
	summary: string;
	description: string;
	target?: string;
	at: number;
	exitCode: number | null;
};
/** User-facing automatic event. The full agent-facing message remains on the entry. */
export interface ChatEventSummary {
	kind: "mission_updated" | "mission_decisions_changed" | "mission_task_done" | "mission_member_finished";
	text: string;
}
export interface GitHubActionsUpdateEvent {
	type: "github_actions_update";
	actions: GitHubAction[];
}
export type AgentEvent =
	| DurableAgentEvent
	| QueueUpdateEvent
	| TodosUpdateEvent
	| SnapshotPrefixEvent
	| GitHubActionsUpdateEvent;

/** POST /api/update/pause (tool drain) or legacy /prepare (idle only). Both hold a 30-second admission lease. */
export interface UpdatePreparation {
	/** Pause endpoints identify the process whose workers were drained. */
	processId?: number;
	ready: boolean;
}

export interface SessionSummary {
	/** Fresh provider-safe chat which continues this readable, permanently read-only chat. */
	continuedTo?: string;
	/** Original chat whose workspace and task ownership this fresh chat continues. */
	continuationOf?: string;
	/** Durable work paused by the Mac sleep policy, awaiting a later full wake with connectivity. */
	sleepPaused?: boolean;
	/** Omitted by older daemons, meaning Build. */
	mode?: ChatMode;
	/** Actual Build workspace policy, including isolated workspaces without a task branch. */
	workspace?: WorkspaceMode;
	/** Shared jj repository storage. Omitted for legacy clones and direct checkouts. */
	workspaceStorage?: "shared";
	/** Current coordinator base and successful refresh time (epoch milliseconds). */
	workspaceBase?: string;
	workspaceUpdatedAt?: number;
	workspaceBehind?: string;
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
	/** Pinned chats sort first and are exempt from automatic archiving. Omitted means unpinned. */
	pinned?: boolean;
	/** Live worker-owned jobs. Omitted when none; never restored from stale metadata. */
	runningJobs?: SessionJob[];
	/** User-only attention (live jobs or stuck owned PRs). Does not change outcomes or coordinator admission. */
	attentionReason?: NeedsYouReason;
	/** Epoch ms when live job attention became due. Cleared with the job. */
	attentionAt?: number;
	state: SessionState;
	/** Daemon-derived user-visible work, including live jobs and their pending follow-up. Prefer over state. */
	working?: boolean;
	/** Worker startup failed. POST /api/sessions/:id/retry-startup reloads it with the existing outbox. */
	canRetryStartup?: boolean;
	outcome?: SessionOutcome;
	outcomeAt?: number;
	outcomeReason?: string;
	/** Primary discovered or explicitly bound PR. */
	pullRequest?: SessionPullRequest;
	/**
	 * Every discovered or explicitly bound PR associated with the session, primary first.
	 * Omitted when there are none, or by older daemons (use pullRequest).
	 */
	pullRequests?: SessionPullRequest[];
	/**
	 * URLs of PRs explicitly bound to this chat (POST /api/sessions/:id/pull-requests), excluding detached ones.
	 * They can be on a branch the chat never used. Omitted when none, or by older daemons.
	 */
	boundPullRequests?: string[];
	/**
	 * Every branch or bookmark the session created or used, the current one first. Pair with pullRequests by
	 * branch. Shared jj workspaces only list bookmarks created from their own workspace. Omitted when none.
	 */
	branches?: string[];
	/** A lookup failed; pull requests, if present, are the last known status, not a fresh result. */
	pullRequestError?: string;
	/**
	 * The workspace has work no PR carries: uncommitted edits, commits without a PR, or new commits after a merge.
	 * Such chats stay active: no automatic archiving and no terminal-PR presentation. Omitted when none or unknown.
	 */
	unpublishedWork?: boolean;
	/** Resolved "provider/modelId", once the kernel has started. */
	model?: string;
	/** Effective thinking level, once the kernel has started. */
	thinking?: string;
	/** Latest context estimate and optional pi-extensions subscription snapshot. */
	usage?: SessionUsage;
	/** Subscription windows holding this chat or its working subagents. Force is scoped to these windows. */
	subscriptionPause?: SubscriptionPause;
	/** Named background subagents, in spawn order. Omitted when the session has none. */
	subagents?: SessionSubagent[];
	/** Mission this chat belongs to. Omitted when it has none. */
	missionId?: string;
	/** Current coordinator of an active mission. Exempt from terminal-PR treatment and merge auto-archiving. */
	activeMissionCoordinator?: boolean;
	/** Current role, including a done or archived mission. */
	missionCoordinator?: boolean;
	/**
	 * Conversation attempts created by retry, edit and restore, oldest first, the original included. Omitted while the
	 * session has a single attempt. Attempts that only hold a failed turn are left out.
	 */
	attempts?: SessionAttempt[];
	error?: string;
}

/** How an attempt was started: retrying a failed turn, editing a sent message, or restoring an earlier point. */
export type RewindAction = "retry" | "edit" | "restore";

/** One conversation of a session. The session shows and continues exactly one, its active attempt. */
export interface SessionAttempt {
	/** Durable conversation ID. */
	id: string;
	/** Omitted for the original conversation. */
	reason?: RewindAction;
	/** Epoch milliseconds. Omitted for the original conversation. */
	createdAt?: number;
	/** Start of the message this attempt resent, when it resent one. */
	preview?: string;
	active?: boolean;
}

export interface ContextUsage {
	tokens?: number;
	contextWindow: number;
	percent?: number;
}

/** GET /api/sessions. Defaults to active sessions; projectId and missionId narrow either view. */
export interface SessionListQuery {
	archived?: "false" | "true" | "all";
	projectId?: string;
	missionId?: string;
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

export interface SubscriptionPauseWindow {
	provider: "anthropic" | "openai";
	label: string;
	usedPercent: number;
	resetsAt?: string;
}

export interface SubscriptionPause {
	windows: SubscriptionPauseWindow[];
	/** User explicitly allowed this chat and its children past these windows, until reset. */
	forced?: boolean;
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
	tracking?: ProjectTrackingConfig;
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
	/** Library versions the revision was prepared with. Absent on revisions saved before versions were recorded. */
	libraryVersions?: Partial<Record<ArtifactLibrary, string>>;
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

/**
 * Data of a `pilot.question` transcript entry, written by the agent's ask_user tool. The question is pending until a
 * later user message; that message is the reply.
 */
export interface AgentQuestion {
	question: string;
	context?: string;
	/** At most nine answers, in the order shown and numbered from 1. May be empty for an open question. */
	options: Array<{ label: string; detail?: string; suggested?: boolean }>;
	/** Several answers can be picked together. */
	multiSelect?: boolean;
}

/** POST /api/projects, PATCH /api/projects/:id (partial). An empty model clears it. */
export interface ProjectRequest {
	path: string;
	name?: string;
	model?: string;
	workspace?: WorkspaceMode;
	requirePullRequest?: boolean;
	tracking?: ProjectTrackingConfig;
}

/** Missions: a goal spanning several chats of one project. State is daemon-owned. */
export type MissionStatus = "active" | "done" | "archived";
export type MissionTaskStatus = "todo" | "in_progress" | "blocked" | "in_review" | "delegated" | "done" | "dropped";
export type MissionHealth = "on_track" | "at_risk" | "off_track";
export type MissionResourceKind =
	| "linear.project"
	| "linear.issue"
	| "github.issue"
	| "github.pr"
	| "slack.thread"
	| "url";
export type MissionEventKind =
	| "created"
	| "status"
	| "handoff"
	| "update"
	| "brief"
	| "decision"
	| "comment"
	| "task"
	| "claim"
	| "artifact"
	| "resource"
	| "member"
	| "coordinator"
	| "github";

export interface Mission {
	id: string;
	/** Every member session belongs to this project. */
	projectId: string;
	title: string;
	goal: string;
	status: MissionStatus;
	/** Chat holding the coordinator role. Omitted: the user coordinates. */
	coordinatorSessionId?: string;
	/** The coordinator may start chats for unblocked tasks without being asked. */
	autopilot?: boolean;
	/** Latest brief revision; 0 before the first save. */
	briefRevision: number;
	/** Blocked tasks plus open, unaddressed agent comments when there is no coordinator.
	 * Excludes unread member-chat results, which clients count locally. */
	needsYouCount: number;
	/** Done and total tasks, dropped tasks excluded from both. */
	tasksDone: number;
	tasksTotal: number;
	/** First blocked task, unaddressed agent question or pending decision proposal, bounded to one line. */
	needsYouReason?: string;
	createdAt: number;
	updatedAt: number;
	completedAt?: number;
	archivedAt?: number;
}

/** One immutable brief revision. Omitted authorSessionId means the user wrote it. */
export interface MissionBrief {
	missionId: string;
	revision: number;
	markdown: string;
	authorSessionId?: string;
	createdAt: number;
}

/** Revision history entry, without content. */
export interface MissionBriefRevision {
	revision: number;
	authorSessionId?: string;
	createdAt: number;
}

/** PUT /api/missions/:id/brief. A stale expectedRevision is rejected with 409. */
export interface MissionBriefWrite {
	markdown: string;
	expectedRevision: number;
}

/** Binding statement. Agents may add decisions; only the user edits or removes them. */
export type MissionDecisionAudience = "all" | "coordinator" | "reference";

export interface MissionDecision {
	id: string;
	number: number;
	audience: MissionDecisionAudience;
	text: string;
	authorSessionId?: string;
	createdAt: number;
	updatedAt: number;
}

/** Coordinator suggestion. The recorded decision stays binding until the user accepts. */
export interface MissionDecisionProposal {
	id: string;
	decisionId: string;
	kind: "edit" | "remove";
	text?: string;
	reason: string;
	authorSessionId: string;
	status: "pending" | "accepted" | "rejected";
	createdAt: number;
	resolvedAt?: number;
}

/** Annotation anchored to a brief excerpt, optionally addressed to one member chat. */
export interface MissionComment {
	id: string;
	text: string;
	/** Quoted brief excerpt the comment refers to. Omitted: the whole brief. */
	anchor?: string;
	/** Brief revision the anchor was taken from. */
	revision?: number;
	authorSessionId?: string;
	/** Addressed chat. Omitted: the coordinator, or the user when there is none. */
	targetSessionId?: string;
	createdAt: number;
	resolvedAt?: number;
	resolvedBySessionId?: string;
}

export interface MissionTask {
	id: string;
	/** Per-mission display number, stable once assigned. */
	number: number;
	title: string;
	body?: string;
	status: MissionTaskStatus;
	/** Linear assignee display name for automatically delegated work. */
	delegatedTo?: string;
	/** Sort key within the mission. */
	order: number;
	milestone?: string;
	/** Task IDs that must be done before this one can start. */
	dependsOn?: string[];
	/** Decisions pinned to this task, sent in full to its chat. */
	decisionIds?: string[];
	/** Owning chat. At most one; claiming another chat's task is rejected with 409. */
	sessionId?: string;
	createdAt: number;
	updatedAt: number;
	completedAt?: number;
}

/** POST /api/missions/:id/tasks; PATCH /api/missions/:id/tasks/:taskId sends only changed fields. */
export interface MissionTaskWrite {
	title?: string;
	body?: string;
	status?: MissionTaskStatus;
	order?: number;
	milestone?: string;
	dependsOn?: string[];
	/** Decisions pinned to this task, sent in full to its chat. */
	decisionIds?: string[];
	/** User assignment: a member chat ID, or null to release. Agents claim through the mission tool instead. */
	sessionId?: string | null;
}

/** An artifact linked to a mission. It stays owned by its session. */
export interface MissionArtifactLink {
	/** Omitted for mission-level references. */
	taskId?: string;
	artifactId: string;
	sessionId: string;
	title: string;
	kind: ArtifactKind;
	/** Pinned revision. Omitted opens the latest. */
	revision?: number;
	linkedBySessionId?: string;
	linkedAt: number;
}

/** External link. Kind and external ID are parsed by pilotd when saved. */
export interface MissionResource {
	/** Task ownership drives PR status; references are related work only. */
	relationship: "ownership" | "reference";
	/** Current chat owning this PR in tool get results; null when unbound. */
	owner?: { id: string; title: string } | null;
	/** Last known GitHub PR state, refreshed by daemon tracking. */
	pullRequest?: SessionPullRequest;
	/** Omitted for mission-level links. */
	taskId?: string;
	id: string;
	url: string;
	title?: string;
	kind: MissionResourceKind;
	/** Linear identifier ("ENG-123" or project slug), GitHub "owner/repo#42", Slack "channel/ts". */
	externalId?: string;
	addedBySessionId?: string;
	createdAt: number;
}

export interface MissionResourceWrite {
	/** Defaults to ownership for task PRs, reference otherwise. Does not bind a chat. */
	relationship?: "ownership" | "reference";
	/** Task ID or display number. */
	taskId?: string;
	url: string;
	title?: string;
}

export interface PullRequestBindingResult {
	changed: boolean;
	previousOwner: { id: string; title: string } | null;
	taskLinkRemoved: boolean;
}

/** POST /api/missions/:id/decisions; PATCH /api/missions/:id/decisions/:decisionId. */
export interface MissionDecisionWrite {
	text?: string;
	audience?: MissionDecisionAudience;
}

/** POST /api/missions/:id/comments. */
export interface MissionCommentWrite {
	text: string;
	anchor?: string;
	targetSessionId?: string;
}

/** POST /api/missions/:id/artifacts. The artifact must belong to a member chat. */
export interface MissionArtifactLinkWrite {
	/** Task ID or display number. */
	taskId?: string;
	sessionId: string;
	artifactId: string;
	revision?: number;
}

/** POST /api/missions/:id/events: a handoff or status update. */
export interface MissionEventWrite {
	text: string;
	kind?: "update" | "handoff";
	health?: MissionHealth;
}

/** Append-only activity entry. Omitted sessionId means the user or the daemon. */
export interface MissionEvent {
	id: number;
	kind: MissionEventKind;
	text: string;
	sessionId?: string;
	taskId?: string;
	/** Only on status updates. */
	health?: MissionHealth;
	at: number;
}

/** GET /api/missions/:id, and the payload of WS `mission`. Member sessions come from the session list. */
export interface MissionDetail {
	mission: Mission;
	brief?: MissionBrief;
	decisions: MissionDecision[];
	decisionProposals: MissionDecisionProposal[];
	/** Open comments, plus recently resolved ones. */
	comments: MissionComment[];
	tasks: MissionTask[];
	artifacts: MissionArtifactLink[];
	resources: MissionResource[];
	/** Most recent first, bounded. Older entries: GET /api/missions/:id/events?before=<id>. */
	events: MissionEvent[];
}

/** POST /api/missions. */
export interface CreateMissionRequest {
	projectId: string;
	title: string;
	/** Empty when omitted, for example while the chat drafts it. */
	goal?: string;
	brief?: string;
	tasks?: Array<{ title: string; body?: string }>;
	/** Chat that joins the new mission ("Make a mission"). Must belong to projectId. */
	fromSessionId?: string;
	/** With fromSessionId: that chat becomes coordinator. Defaults to true. */
	coordinator?: boolean;
	/** With fromSessionId: ask that chat to draft the goal, brief and tasks from its conversation. Defaults to true. */
	draft?: boolean;
	/** Start a new coordinator. Omitted/false preserves title-and-goal creation. */
	startCoordinator?: boolean;
	model?: string;
	thinking?: string;
	/** Extra context, links and constraints for the draft request. */
	message?: string;
}

/** POST /api/missions/:id/coordinator/start. Uses task-start model admission. */
export interface StartMissionCoordinatorRequest {
	model?: string;
	thinking?: string;
	message?: string;
}

/** PATCH /api/missions/:id. A null coordinatorSessionId hands coordination back to the user. */
export interface UpdateMissionRequest {
	title?: string;
	goal?: string;
	status?: MissionStatus;
	coordinatorSessionId?: string | null;
	autopilot?: boolean;
}

/** PUT /api/sessions/:id/mission. The session must belong to the mission's project. */
export interface JoinMissionRequest {
	missionId: string;
	/** Task to claim for this chat. */
	taskId?: string;
}

/** POST /api/missions/:id/tasks/:taskId/start: a new chat in the mission's project that claims the task. */
export interface StartMissionTaskRequest {
	/** References are saved on the task before the chat starts. */
	artifacts?: Array<{ artifactId: string; revision?: number }>;
	links?: Array<{ url: string; title?: string }>;
	message?: string;
	model?: string;
	thinking?: string;
	mode?: ChatMode;
	baseBranch?: string;
}

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
 * - `scheduled_failed`: a scheduled item could not start.
 * - `long_job`: a live job has run for at least one hour. User-only, even inside a mission.
 * - `unread`: a chat finished or stopped and its result has not been reviewed.
 */
export type DashboardNeedsYouKind = "failed" | "question" | "scheduled_failed" | "long_job" | "pr_stuck" | "unread";

export type NeedsYouReasonKind =
	| "failed"
	| "asks"
	| "not_reviewed"
	| "couldnt_start"
	| "mission"
	| "limit"
	| "pr_stuck"
	| "long_job";

/**
 * One reason per row. Not-reviewed age is formatted by clients from the row's `at`.
 * `limit`: a failed chat stopped by a subscription limit ("Limit reached · resumes at 18:00").
 */
export interface NeedsYouReason {
	kind: NeedsYouReasonKind;
	/** First non-empty line, at most 200 characters. Omitted for not_reviewed and limit. */
	detail?: string;
	/** `limit`: epoch ms when the exhausted subscription window resets, when known. */
	resumesAt?: number;
}

export interface DashboardNeedsYouItem {
	kind: DashboardNeedsYouKind;
	/** Stable row key. */
	id: string;
	title: string;
	/** `failed` and `unread`. */
	sessionId?: string;
	/** `question` always, chats when they belong to a mission. */
	missionId?: string;
	/** `scheduled_failed`: the scheduled item. */
	scheduledId?: string;
	/** `failed` and `unread`. */
	outcome?: SessionOutcome;
	/** Failure or stop reason, one short line. */
	reason?: string;
	/** Shared attention vocabulary for metadata, tooltips and accessibility. */
	attentionReason: NeedsYouReason;
	/** `question`: blocked tasks plus open comments awaiting the user. */
	count?: number;
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
	/** Tasks done, and tasks overall (dropped tasks excluded). */
	tasksDone: number;
	tasksTotal: number;
	/** Member chats working now. */
	working: number;
	/** Needs-you rows belonging to the mission: its question count plus member chats with an unreviewed result. */
	needsYou: number;
	coordinatorSessionId?: string;
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
	trigger: import("./schedules.ts").ScheduleTrigger | "removed";
	/** Epoch ms, for `at` triggers. */
	at?: number;
	/** `pending` rows list under Scheduled, `failed` ones under Needs you. */
	state: "pending" | "failed";
	/** Why it could not start. */
	error?: string;
	/** Target chat of a message. */
	sessionId?: string;
}

/** Health of one tracked-item source. */
export type DashboardSourceStatus = import("./tracking.ts").SourceStatus;

export interface DashboardTrackedItem {
	slack?: import("./tracking.ts").SlackTriage;
	id: string;
	title: string;
	url?: string;
	/** Source-specific label, for example a Linear state or a local Slack status. */
	status?: string;
	updatedAt?: number;
	externalId?: string;
	metadata?: Record<string, import("./tracking.ts").TrackingJson>;
	sessionId?: string;
	missionId?: string;
	sessionIds?: string[];
	missionIds?: string[];
}

/** Extension point for tracked items, one group per configured source. Empty until a source is configured. */
export interface DashboardTrackedSource {
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
	linear?: import("./tracking.ts").LinearSourceSummary;
}

/** Counts for the headline sentence and the sidebar. */
export interface ProjectDashboardSummary {
	/** Active (not archived) chats of the project. 0 means a new project. */
	chats: number;
	working: number;
	/** Equals `needsYou.total`. */
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
	/** Memory provider extension point; absent when unavailable or not yet loaded. */
	memory?: import("./memory.ts").ProjectMemorySummary;
	/** Finished chats that are no longer waiting on the user, latest first. */
	recent: DashboardSection<DashboardRecentItem>;
}

/** Per-project counts for the sidebar scope switcher. Same figures as `ProjectDashboardSummary`. */
export interface ProjectDashboardCount {
	working: number;
	needsYou: number;
	/** Uncapped row totals by reason. Omitted when no rows need the user. */
	needsYouReasons?: Partial<Record<NeedsYouReasonKind, number>>;
	/** Open tracked items the Inbox lists (Linear and Slack, without hidden labels). Omitted when 0. */
	tracked?: number;
}

/** GET /api/dashboard/counts, and the payload of WS `dashboard.counts`. Projects with no counts are omitted. */
export interface ProjectDashboardCounts {
	projects: Record<string, ProjectDashboardCount>;
}

/** POST /api/reviews: the user has seen these chat results (up to 1000 marks). Marks only move forward. */
export interface ReviewRequest {
	marks: Array<{ sessionId: string; outcomeAt: number }>;
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

/** GET /api/models?projectId=… or ?cwd=…; purpose=task-start applies the task-start price cap. */
export interface ModelList {
	models: ModelOption[];
	/** pi's default model for that directory. */
	defaultModel?: string;
}

/** POST /api/sessions. Needs a missionId, projectId or cwd (cwd overrides a non-mission project's path). */
/** Returns a durable `starting` session before workspace preparation and kernel startup finish. */
export interface SpawnRequest {
	/** Join an active mission before the first turn. Uses its project; cwd overrides are not allowed. */
	missionId?: string;
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

/** POST /api/sessions/:id/continue-model. Returns the same chat or a provider-safe replacement. */
export type ContinueModelRequest = ChangeModelRequest;

/** POST /api/sessions/:id/subscription-force. Returns SessionSummary. */
export interface SubscriptionForceRequest {
	force: boolean;
}

/** POST /api/sessions/:id/title. Renames a chat; the title is trimmed and must not be empty. */
export interface RenameSessionRequest {
	title: string;
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

/**
 * A slash command the session's kernel expands when it is sent as a message. Prompt templates are invoked as
 * `/name args` and skills as `/skill:name args`. Built-in client commands such as `/compact` are not listed.
 */
export interface SessionCommand {
	/** Invocation name without the leading slash, for example "review" or "skill:commit". */
	name: string;
	source: "prompt" | "skill";
	description?: string;
	/** Argument placeholder from a prompt template's `argument-hint` frontmatter. */
	argumentHint?: string;
}

/** GET /api/sessions/:id/commands. Reopens a parked session only when no list is cached. */
export interface SessionCommandsResponse {
	commands: SessionCommand[];
}

/** A running shell job owned by the current session worker. Handles and logs are runtime-local. */
export interface SessionJob {
	id: string;
	name: string;
	state: "running";
	startedAt: number;
	outputPath: string;
}

/** GET /api/sessions/:id/jobs. Read-only; never starts a model turn or reopens a parked worker. */
export interface SessionJobsResponse {
	jobs: SessionJob[];
}

/*
 * POST /api/sessions/:id/jobs/:jobId/stop stops one running job and answers 202 { ok: true }, or 404 once it no longer
 * runs. The agent receives a job result saying the user stopped it, and its follow-up turn ends the wait.
 */

/**
 * GET /api/sessions/:id/history?before=<entryId>[&limit=<n>]: retained entries older than the active transcript,
 * which compaction or reset hides from the snapshot. Read from storage without waking a parked session. Entries are
 * oldest first and include older compaction and reset markers. `limit` defaults to 100 (at most 500); a page may
 * end early when its entries are large.
 */
export interface SessionHistoryPage {
	entries: EntryRecord[];
	/** True when older entries may remain: request again with the oldest returned entry ID as `before`. */
	more: boolean;
}

/**
 * POST /api/sessions/:id/stop. Aborts the current run and withdraws queued input. The user's own queued messages come
 * back as `draft`, in delivery order, so the composer keeps them instead of losing them.
 */
export interface StopResponse {
	ok: true;
	draft?: string;
}

/**
 * POST /api/sessions/:id/rewind. Stops current work, then continues the session from an earlier point in a new
 * attempt. The previous attempt stays available. Workspace files are not reverted.
 * - `retry`: `entryId` is a failed assistant entry. Resends the user message that started its turn.
 * - `edit`: `entryId` is a user entry. Continues from just before it and returns its text as `draft`.
 * - `restore`: `entryId` is an assistant entry. Continues from the end of its turn.
 */
export interface RewindRequest {
	action: RewindAction;
	entryId: number;
}

export interface RewindResponse {
	session: SessionSummary;
	/** Text of the edited message, for the composer. */
	draft?: string;
}

/**
 * POST /api/sessions/:id/compact. Starts a manual compaction and returns once it is durably queued. The conversation
 * keeps working; the summary is placed when idle or at the next turn boundary. Stop cancels it.
 */
export interface CompactRequest {
	/** Optional guidance for what the summary should keep. */
	instructions?: string;
}

/**
 * PATCH /api/sessions/:id/queue/:submissionId. Keeps the message's queue position. Without `mode`, the delivery mode
 * is unchanged; with it, the message is delivered as steering or as a follow-up from then on.
 */
export interface EditQueuedMessageRequest {
	message: string;
	mode?: DeliveryMode;
}

/** DELETE /api/sessions/:id/queue/:submissionId. No body. Only withdraws an input still in the durable queue. */
export interface RemoveQueuedMessageResponse {
	ok: true;
}

/**
 * POST /api/sessions/:id/held/send starts one run with every held input (steering first, then follow-ups).
 * DELETE /api/sessions/:id/held discards all held input; /held/:submissionId discards one.
 * Waiting automatic input is never editable or discardable. The next user input also carries held input.
 */
export interface HeldMessagesResponse {
	ok: true;
}

/** Client to daemon, over /api/ws. */
export type ClientMessage =
	/** Receive `mission` details for one mission: the current detail first, then after every change. */
	| { type: "mission.subscribe"; missionId: string }
	| { type: "mission.unsubscribe"; missionId: string }
	/** Receive `dashboard` for one project: the current dashboard first, then whenever it changes. */
	| { type: "dashboard.subscribe"; projectId: string }
	| { type: "dashboard.unsubscribe"; projectId: string }
	/**
	 * The client is in the foreground showing these sessions (at most 50). The daemon rechecks their
	 * pull requests soon unless they were checked recently. Opening a chat socket implies the same.
	 */
	| { type: "focus"; sessionIds: string[] };

/** Daemon to client, over /api/ws and the dedicated sockets below (see their message types). */
export type ServerMessage =
	| { type: "power"; power: import("./power.ts").PowerStatus }
	| import("./schedules.ts").SchedulesMessage
	/** Includes both active and archived sessions, so clients can switch views locally. */
	| { type: "sessions"; sessions: SessionSummary[] }
	| { type: "session"; session: SessionSummary }
	| { type: "projects"; projects: Project[] }
	| { type: "sources"; sources: TrackingSource[] }
	/** Invalidation only; clients fetch a bounded list. Dashboards use their existing subscription. */
	| { type: "tracked.changed"; projectId: string }
	| { type: "artifacts"; sessionId: string; artifacts: ArtifactSummary[] }
	/** All missions, including done and archived ones, so clients can filter locally. */
	| { type: "missions"; missions: Mission[] }
	/** Full detail for a subscribed mission, on subscription and after every change. */
	| { type: "mission"; mission: MissionDetail }
	/** A subscribed project's dashboard, on subscription and after every change that alters it. */
	| { type: "dashboard"; dashboard: ProjectDashboard }
	/** Sidebar counts for every project, on connection and whenever they change. */
	| { type: "dashboard.counts"; counts: ProjectDashboardCounts }
	/** A chat stream's batches, numbered from 1 for resuming. A new stream's first batch holds a snapshot. */
	| { type: "events"; sessionId: string; events: AgentEvent[]; seq: number }
	/**
	 * First frame on every chat socket connection. `resumed`: the frames after the requested `after` follow. Otherwise
	 * this is a new stream and its first batch holds a snapshot. Reconnect with `?stream=<streamId>&after=<last seq>`.
	 */
	| { type: "chat.stream"; sessionId: string; streamId: string; resumed: boolean }
	| { type: "terminal.data"; sessionId: string; data: string }
	| { type: "terminal.exit"; sessionId: string; code: number }
	/** Replaces the transcript when it contains a snapshot (or is empty); otherwise appends entries. */
	| { type: "subagent.events"; sessionId: string; name: string; events: AgentEvent[] }
	| { type: "error"; sessionId?: string; name?: string; message: string };

/**
 * Dedicated sockets. Each has its own send queue, so one stream never delays another. Close codes in 4400–4499
 * are final (4404: unknown session or subagent, 4409: refused, for example a read-only session's terminal), so
 * clients do not reconnect. 1013 asks the client to reconnect (overload, or a temporary refusal such as a pending
 * update).
 *
 * Chat socket, /api/sessions/:id/ws[?stream=<id>&after=<seq>], one per open chat. Opening it subscribes and closing
 * it unsubscribes; clients send nothing. The first frame is `chat.stream`, then numbered `events` batches starting
 * with a snapshot, unless the stream resumed. Artifact index updates for the session are repeated here so they
 * stay ordered with the initial index.
 */
export type ChatServerMessage = Extract<ServerMessage, { type: "chat.stream" | "events" | "artifacts" | "error" }>;

/**
 * Terminal socket, /api/sessions/:id/terminal/ws?cols=<n>&rows=<n>[&restart=1]. Connecting attaches to the session's
 * daemon-owned shell (starting it, or replacing it with `restart`); the daemon replies with the retained scrollback,
 * then live output. Closing detaches; the shell keeps running.
 */
export type TerminalServerMessage = Extract<ServerMessage, { type: "terminal.data" | "terminal.exit" | "error" }>;
export type TerminalSocketMessage =
	| { type: "terminal.input"; data: string }
	| { type: "terminal.resize"; cols: number; rows: number };

/**
 * Subagent socket, /api/sessions/:id/subagents/:name/ws. Streams one subagent's transcript: a snapshot first (also
 * after reconnects), then appended entries. Clients send nothing.
 */
export type SubagentServerMessage = Extract<ServerMessage, { type: "subagent.events" | "error" }>;

export const DEFAULT_PORT = 4319;
export type * from "./inbox.ts";
export type * from "./memory.ts";
export type { PowerSettings, PowerStatus } from "./power.ts";
export type * from "./schedules.ts";
export type * from "./tracking.ts";
