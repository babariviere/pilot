import type { ArtifactKind } from "./artifacts.ts";
import type { SessionPullRequest } from "./pull-requests.ts";
import type { ChatMode } from "./session.ts";
import type { MissionLinearSync } from "./tracking.ts";

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
	/** Creation-only opt-in. Missing: legacy planning. Unknown versions are readable, not writable. */
	planningVersion?: number;
	/** Every member session belongs to this project. */
	projectId: string;
	title: string;
	goal: string;
	status: MissionStatus;
	/** Status-only lifecycle keeps chats intact and automatic coordinator notices paused. */
	passiveLifecycle?: boolean;
	/** Chat holding the coordinator role. Omitted: the user coordinates. */
	coordinatorSessionId?: string;
	/** The coordinator may start chats for unblocked tasks without being asked. */
	autopilot?: boolean;
	/** Later phases cannot be claimed or started until earlier phases finish. Defaults to false. */
	phaseGating?: boolean;
	/** First unfinished phase in order, with its progress, for summaries. Omitted when no phase is unfinished. */
	currentPhase?: MissionCurrentPhase;
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

/** Active decisions are binding. Text edits/removals remain user-only. */
export type MissionDecisionAudience = "all" | "coordinator" | "reference";

export interface MissionDecision {
	id: string;
	number: number;
	audience: MissionDecisionAudience;
	text: string;
	/** Explicitly retired guidance. Target identity survives a later user removal; text is read separately. */
	replacement?: { id: string; number: number; at: number; reason?: string; revisionId?: string; humanSource?: string };
	/** User-accepted withdrawal. Original text and historical pins remain readable. */
	withdrawn?: { at: number; reason: string; proposalId: string; revisionId?: string; humanSource?: string };
	authorSessionId?: string;
	createdAt: number;
	updatedAt: number;
}

/** Coordinator suggestion. Only user acceptance edits or removes the recorded text. */
export interface MissionDecisionProposal {
	id: string;
	decisionId: string;
	kind: "edit" | "remove" | "withdraw";
	/** Withdrawal proposals require an explicit retry identity, never inferred authority. */
	operationId?: string;
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

export interface MissionPhase {
	id: string;
	missionId: string;
	name: string;
	goal?: string;
	order: number;
	completedAt?: number;
}

/** A summary's current phase. Dropped tasks are excluded from both counts. */
export interface MissionCurrentPhase {
	id: string;
	name: string;
	done: number;
	total: number;
}

/** POST /api/missions/:id/phases; PATCH /api/missions/:id/phases/:phaseId. */
export interface MissionPhaseWrite {
	name?: string;
	goal?: string;
	order?: number;
}

/** A submission, not acceptance, completion, or evidence of code review or merge. */
export type MissionNonCodeDeliveryReference =
	| { kind: "brief"; revision: number }
	| { kind: "artifact"; artifactId: string; revision: number };

export interface MissionNonCodeDelivery {
	kind: "non-code";
	references: MissionNonCodeDeliveryReference[];
	checks: string;
	limitations: string;
}

/** Legacy receipts validate hash format only, not existence or landing. */
export interface MissionCodeCompletion {
	commit: string;
	checks: string;
	issues: string;
}

export interface MissionTask {
	id: string;
	/** Coordinator-owned definition, separate from execution status and log/comment reports. */
	assignment?: MissionAssignment;
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
	/** Canonical phase membership. milestone remains a name alias for older clients. */
	phaseId?: string;
	/** Earlier incomplete phase IDs. Status is derived as blocked, never persisted. */
	blockedByPhases?: string[];
	/** Actual status when phase gating derives a blocked status. */
	storedStatus?: MissionTaskStatus;
	/** Task IDs that must be done before this one can start. */
	dependsOn?: string[];
	/** Decisions pinned to this task, sent in full to its chat. */
	decisionIds?: string[];
	/** Owning chat. At most one; claiming another chat's task is rejected with 409. */
	sessionId?: string;
	/** Model for new chats on this task unless a start picks another: a scoped provider/modelId within the task-start price cap. */
	preferredModel?: string;
	/** Thinking level for the preferred model. Omitted: the model's configured default. */
	preferredThinking?: string;
	/** Who set the preference. The coordinator never changes or overrides a user-set preference. */
	preferredModelSetBy?: "user" | "coordinator";
	createdAt: number;
	updatedAt: number;
	completedAt?: number;
}

/** POST /api/missions/:id/tasks; PATCH /api/missions/:id/tasks/:taskId sends only changed fields. */
export interface MissionTaskWrite {
	/** Complete replacement, guarded by the current assignment revision (0 when absent). */
	assignment?: MissionAssignmentWrite;
	title?: string;
	body?: string;
	status?: MissionTaskStatus;
	order?: number;
	milestone?: string;
	/** Null removes phase membership. */
	phaseId?: string | null;
	/** Explicit user-only bypass when assigning a gated task to a chat. */
	overridePhaseGating?: boolean;
	/** Explicit user assignment to a delivered member; never granted to agent claims. */
	overrideRetirement?: boolean;
	dependsOn?: string[];
	/** Decisions pinned to this task, sent in full to its chat. */
	decisionIds?: string[];
	/** Coordinator/user assignment: a member chat ID, or null to release. Workers only report facts. */
	sessionId?: string | null;
	/**
	 * Preferred model for new chats, validated against the task-start scope and price cap; null clears it.
	 * Setting the model replaces the thinking level too (preferredThinking or the model's default).
	 */
	preferredModel?: string | null;
	/** Thinking level for the preferred model; null clears. Requires a preferred model. */
	preferredThinking?: string | null;
}

/** Small versioned planning contract. Does not grant build, review or merge authority. */
export interface MissionAssignment {
	/** Unknown stored versions remain inspectable; writes support only v1. */
	version: number;
	revision: number;
	intent: string;
	scope: string;
	criteria: string[];
	/** Planning assessment, not session capabilities, contribution proof or authority. Absent is unknown. */
	classification?: MissionClassification;
}

export interface MissionAssignmentWrite {
	version: 1;
	expectedRevision: number;
	/** Existing task-definition fence. Required when classification is supplied; 0 for task creation. */
	expectedDefinitionRevision?: number;
	/** Omission preserves on unchanged content, otherwise clears to unknown. Null explicitly clears. */
	classification?: MissionClassification | null;
	intent: string;
	scope: string;
	criteria: string[];
}

/** Independent planning dimensions. Role is assignment intent, not trusted membership. */
export interface MissionClassification {
	version: 1;
	effort: "small" | "medium" | "large" | "unknown";
	difficulty: "routine" | "substantive" | "hard" | "unknown";
	risk: "low" | "medium" | "high" | "unknown";
	uncertainty: "known" | "unknown";
	scope: "bounded" | "expanded" | "unknown";
	role: "builder" | "explorer" | "reviewer" | "unknown";
	/** A declaration only. Research does not prove absence of code contributions. */
	deliveryKind: "code" | "native-ui" | "research" | "unknown";
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

/** Linear lifecycle authority is separate from GitHub PR ownership. */
export type MissionLinearRole = "reference" | "managed" | "contribution";

/** Daemon-owned synchronization for a managed ticket. References never have this field. */
/** POST /api/missions/:id/resources/:resourceId/linear-sync. Explicit user review, not an agent action. */
export interface MissionLinearSyncWrite {
	action: "pause" | "resume";
}

/** External link. Kind and external ID are parsed by pilotd when saved. */
export interface MissionResource {
	/** Linear issues only. Older links are read-only references, never implicit contributions. */
	linearRole?: MissionLinearRole;
	/** Canonical workspace/issue identifier, at most 256 ASCII characters; independent of URL slug/query/fragment. */
	linearKey?: string;
	linearSync?: MissionLinearSync;
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
	/** Defaults to reference. Managed requires mission scope; contribution requires task scope and a manager. */
	linearRole?: MissionLinearRole;
	/** Defaults to ownership for task PRs, reference otherwise. Does not bind a chat. */
	relationship?: "ownership" | "reference";
	/** Task ID or display number. */
	taskId?: string;
	url: string;
	title?: string;
}

/** PATCH /api/missions/:id/resources/:resourceId. Explicitly upgrade or demote an existing Linear link. */
export interface MissionResourceUpdate {
	linearRole: MissionLinearRole;
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
	/** Passive execution queue. Absent on older services, never start authority. */
	execution?: MissionExecutionView;
	/** GET /api/missions/:id only: how open tasks pick their start model. Tasks on the default model are absent. */
	taskModels?: import("./work-profiles.ts").TaskModelRoute[];
	mission: Mission;
	brief?: MissionBrief;
	decisions: MissionDecision[];
	decisionProposals: MissionDecisionProposal[];
	/** Open comments, plus recently resolved ones. */
	comments: MissionComment[];
	tasks: MissionTask[];
	phases: MissionPhase[];
	artifacts: MissionArtifactLink[];
	resources: MissionResource[];
	/** Most recent first, bounded. Older entries: GET /api/missions/:id/events?before=<id>. */
	events: MissionEvent[];
}

export interface MissionExecutionView {
	version: 1;
	started: boolean;
	total: number;
	queue: Array<{ taskId: string; title: string; reason: string }>;
}

/** POST /api/missions. */
export interface CreateMissionRequest {
	/** Explicit new-mission opt-in only. Existing missions are never adopted implicitly. */
	planningVersion?: 1;
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
	phaseGating?: boolean;
}

/** Responsibility metadata. Only explorer selects an enforced read-only runtime. */
export type MissionRole = "coordinator" | "explorer" | "builder" | "reviewer";
export type MissionWorkerRole = Exclude<MissionRole, "coordinator">;

/** PUT /api/sessions/:id/mission. The session must belong to the mission's project. */
export interface JoinMissionRequest {
	missionId: string;
	/** Opted-in missions only. Explorer requires an existing Ask session; roles cannot change in place. */
	role?: MissionWorkerRole;
	/** Task to claim for this chat. */
	taskId?: string;
}

/** POST /api/missions/:id/tasks/:taskId/start: a new chat in the mission's project that claims the task. */
export interface StartMissionTaskRequest {
	/** Opted-in missions only. Omitted means builder; explorer uses the existing Ask runtime. */
	role?: MissionWorkerRole;
	/** User-only bypass. Not exposed by the coordinator tool. */
	overridePhaseGating?: boolean;
	/** References are saved on the task before the chat starts. */
	artifacts?: Array<{ artifactId: string; revision?: number }>;
	links?: Array<{ url: string; title?: string }>;
	message?: string;
	/** Omitted: the task's preferred model (with its thinking), else the project's default. */
	model?: string;
	thinking?: string;
	mode?: ChatMode;
	baseBranch?: string;
}

/**
 * One side of a re-planning link between an old mission and the new mission that re-plans it.
 * `planning` is open; `abandoned` means the user stopped re-planning; `finished` means the migration ended.
 */
export interface MissionSuccessorLink {
	missionId: string;
	state: "planning" | "finished" | "abandoned";
}

/** Explicit status-only lifecycle, distinct from legacy PATCH side effects. No replay key. */
export interface MissionLifecycleRequest {
	operationId: string;
	home: { daemonId: string; lineageId: string };
	projectId: string;
	expectedStatus: MissionStatus;
	action: "archive" | "reopen" | "complete";
}
export interface MissionLifecycleResponse {
	operationId: string;
	mission: Mission;
}

/** Passive future-chat preference only. Operation ID correlates ACK, never authorizes replay. */
export interface TaskModelRequest {
	operationId: string;
	home: { daemonId: string; lineageId: string };
	projectId: string;
	preferredModel: string | null;
	preferredThinking: string | null;
}
export interface TaskModelResponse {
	operationId: string;
	home: { daemonId: string; lineageId: string };
	missionId: string;
	projectId: string;
	task: MissionTask;
}
