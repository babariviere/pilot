import type { DeliveryMode } from "./chat-input.ts";
import type { CodingQueueView } from "./coding-queue.ts";
import type { DiagnosticScope, DiagnosticTargetReference } from "../diagnostics/diagnostic-context.ts";
import type { DiagnosticRepairAdmission } from "../diagnostics/diagnostic-repair.ts";
import type { MissionRole } from "../missions/missions.ts";
import type { OperationHost } from "../operations/operations.ts";
import type { WorkspaceMode } from "../projects/projects.ts";
import type { SessionPullRequest } from "../github/pull-requests.ts";
import type { SessionUsage, SubscriptionPause } from "../funding/usage.ts";

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

/** Passive preference only. Applying it requires a separate explicit user recovery. */
export interface NextAttemptModel {
	model: string;
	thinking?: string;
}
export interface FailedModelSource {
	token: string;
	source: "startup" | "outcome";
}
export interface FailedModelRequest extends NextAttemptModel {
	operationId: string;
	daemonId: string;
	lineageId: string;
	source: FailedModelSource;
}
export interface FailedModelResponse extends FailedModelRequest {
	sessionId: string;
	session: SessionSummary;
}

export interface SessionSummary {
	/** Saved input is waiting for a coding slot, not a failed or admitted run. */
	codingQueueReason?: string;
	/** Where a chat waiting for a coding slot is in line, beside codingQueueReason. Passive; it starts nothing. */
	codingQueue?: CodingQueueView;
	/** Monotonic explicit-Stop fence for opt-in durable native sends. */
	inputGeneration?: number;
	/** Passive progress for manually started sequential chat flows. */
	flow?: import("../automation/automations.ts").FlowProgress;
	/** Latest workspace setup boundary, independent of the agent's run outcome. */
	workspaceSetup?: { state: "pending" | "ok" | "failed" | "cancelled"; detail?: string };
	/** Bounded retained command results, available without opening a kernel. */
	automationRuns?: import("../automation/automations.ts").AutomationRunRecord[];
	automation?: { state: "running" | "waiting"; name: string; trigger: string; startedAt: number };
	/** Captured failure/configuration precondition. Absent means passive configuration is unavailable. */
	failedModelSource?: FailedModelSource;
	/** Saved for a future explicit recovery, not the current worker or a retry receipt. */
	nextAttemptModel?: NextAttemptModel;
	/** The one project-less, pinned orchestration chat. */
	control?: boolean;
	/** On-demand read-only specialist. Target history still requires a separate explicit grant. */
	role?: SessionRole;
	/** App/host diagnostics with no implicit chat target or transcript grant. */
	diagnosticScope?: DiagnosticScope;
	/** Pinned app diagnostic execution identity; independent of a focus chat. */
	diagnosticHost?: OperationHost;
	/** Exact chat this specialist may inspect. Present only for diagnostics specialists. */
	diagnosticTargetId?: string;
	/** Canonical host-qualified form of the admitted target, for display and reopen verification. */
	diagnosticTarget?: DiagnosticTargetReference;
	/** Explicit user grant for bounded read-only history of the admitted target. Missing means no transcript access. */
	diagnosticHistoryAccess?: boolean;
	/** Latest bounded specialist-authored repair suggestion. It cannot execute a repair. */
	diagnosticRepairProposal?: import("../diagnostics/diagnostics.ts").DiagnosticRepairProposal;
	/** Fresh provider-safe chat which continues this readable, permanently read-only chat. */
	continuedTo?: string;
	/** Original chat whose workspace and task ownership this fresh chat continues. */
	continuationOf?: string;
	/** Slack message or Linear ticket the chat was started from or linked to in triage. Omitted when none. */
	trackedSource?: SessionTrackedSource;
	/** Durable work paused by the Mac sleep policy, awaiting a later full wake with connectivity. */
	sleepPaused?: boolean;
	/** Point-in-time host holds, not inferred outcomes. Refresh after global update changes; never start eligibility. */
	workHolds?: string[];
	/** Durable model work waiting for confirmed internet connectivity. */
	offlinePaused?: boolean;
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
	/** Legacy reclamation timestamp. A discard marker takes precedence over recovery metadata. */
	workspaceReclaimedAt?: number;
	/** Permanent workspace discard admission time. This chat cannot resume execution. */
	workspaceDiscardedAt?: number;
	/** Final archive is blocked; preserve this native coding copy through recovery and required review. */
	workspaceCustody?: "review";
	/** A preparation/configuration failure cannot safely recover by sending another message. */
	recoveryBlockedReason?: string;
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
	/**
	 * User-only attention (live jobs, a question the live run awaits, or stuck owned PRs). Does not change outcomes,
	 * state, working or coordinator admission.
	 */
	attentionReason?: NeedsYouReason;
	/** Epoch ms when live job attention became due. Cleared with the job. */
	attentionAt?: number;
	/**
	 * A follow-up message is scheduled for this chat (pending or dispatching). The chat waits on that schedule, not on
	 * the user, so it leaves Needs you except for live reasons (long job, MCP). Omitted when none.
	 */
	scheduledMessage?: boolean;
	state: SessionState;
	/** Daemon-derived user-visible work, including live jobs and their pending follow-up. Prefer over state. */
	working?: boolean;
	/** Worker startup failed. POST /api/sessions/:id/retry-startup reloads it with the existing outbox. */
	canRetryStartup?: boolean;
	/** The last run failed in automatic handoff. POST /api/sessions/:id/retry-handoff starts one fresh run. */
	canRetryHandoff?: boolean;
	/**
	 * Continue (the native `chat-continue` operation) can send its one fixed follow-up: the chat is idle and was
	 * stopped (an outcome or a mission User Stop hold), its last run failed and a new turn is safe, or it waits for a
	 * reply (`waitsForReply`). Omitted otherwise.
	 */
	canContinue?: true;
	/** This existing chat accepts an ordinary follow-up. The service rechecks on send. */
	canReply?: true;
	/**
	 * A mission builder ended its turn with its task open, no new delivery and no question, even after Pilot's one
	 * automatic reminder: it likely asks the user something in prose. Reply or Continue moves it. Omitted otherwise.
	 */
	waitsForReply?: true;
	/**
	 * A research or prototype chat's question or failure that no longer needs the user: its plan is published, its map
	 * question is resolved, or a newer chat for that question took over. Its outcome stays; the chat stays readable.
	 */
	questionSettled?: true;
	/**
	 * Pilot started this chat for a map question (research or prototype). Its finished results are the planner's: they
	 * never count as unread for the user. Its questions and failures still do until the plan settles them.
	 */
	mapExplorer?: true;
	/** The user dismissed this failed outcome from Needs you. A later outcome shows again. */
	failureDismissed?: true;
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
	/** Opted-in mission responsibility; reviewer does not grant an independent review engine. */
	missionRole?: MissionRole;
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

/**
 * The triage item a chat came from. When several items link to one chat, the one whose latest chat it is wins, then
 * the most recently updated.
 */
export interface SessionTrackedSource {
	kind: import("../sources/tracking.ts").TrackedKind;
	/** Tracked item ID, for opening it in triage. */
	itemId: string;
	/** "#channel" for Slack (or "Slack" without a channel name), the ticket identifier for Linear. */
	label: string;
	/** Message or ticket title, at most 200 characters. */
	title: string;
	url: string;
}

/** One conversation of a session. The session shows and continues exactly one, its active attempt. */
export interface SessionAttempt {
	/** Durable conversation ID. */
	id: string;
	/** Omitted for the original conversation. */
	reason?: RewindAction | "model";
	/** Epoch milliseconds. Omitted for the original conversation. */
	createdAt?: number;
	/** Start of the message this attempt resent, when it resent one. */
	preview?: string;
	active?: boolean;
}

/** GET /api/sessions. Defaults to active sessions; projectId and missionId narrow either view. */
export interface SessionListQuery {
	archived?: "false" | "true" | "all";
	projectId?: string;
	missionId?: string;
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

/** Build may modify its workspace; Ask is read-only. Omitted mode defaults to Build. */
export type ChatMode = "build" | "ask";
/**
 * Runtime-enforced specialist profile. Omitted means an ordinary chat. "screen" is a read-only Ask chat bound to
 * one Day window, with the ui_* tools (apps/day/screen-agent/day-screen-agent.md).
 */
export type SessionRole = "diagnostics" | "insights" | "screen";

export type NeedsYouReasonKind =
	| "failed"
	| "asks"
	| "not_reviewed"
	| "couldnt_start"
	| "schedule"
	| "mission"
	| "limit"
	| "pr_stuck"
	| "automation"
	| "no_pr"
	| "long_job"
	| "mcp"
	| "tool_stall"
	| "waits";

/**
 * One reason per row. Not-reviewed age is formatted by clients from the row's `at`.
 * `limit`: a failed chat stopped by a subscription limit ("Limit reached · resumes at 18:00").
 * `mcp`: the chat reached for an MCP server that needs the user ("datadog needs sign-in"); live-only.
 * `tool_stall`: bounded evidence suspects an unfinished tool is not progressing; live-only and uncertain.
 * `asks`: in a session summary, the live run is suspended in ask_user until the user replies; live-only. Elsewhere it
 * also names a turn that ended on a question.
 * `no_pr`: cached workspace changes exist, but no pull request has been created or attached.
 * `waits`: a mission chat ended its turn with no result and no question (SessionSummary.waitsForReply).
 */
export interface NeedsYouReason {
	kind: NeedsYouReasonKind;
	/** First non-empty line, at most 200 characters. Omitted for not_reviewed and limit. */
	detail?: string;
	/** `limit`: epoch ms when the exhausted subscription window resets, when known. */
	resumesAt?: number;
	/** `mcp`: the server to fix, by its mcp.json name (see McpStatus). */
	server?: string;
}

/** POST /api/sessions. Needs a missionId, projectId or cwd (cwd overrides a non-mission project's path). */
/** Returns a durable `starting` session before workspace preparation and kernel startup finish. */
export interface SpawnRequest {
	/** Join an active mission before the first turn. Uses its project; cwd overrides are not allowed. */
	missionId?: string;
	/** Diagnostics is a host-enforced read-only profile, not a prompt convention. */
	role?: SessionRole;
	/** Required for chat-scoped diagnostics. Mutually exclusive with diagnosticScope. */
	diagnosticTarget?: DiagnosticTargetReference;
	/** Required for app-scoped diagnostics. Mutually exclusive with diagnosticTarget. */
	diagnosticScope?: DiagnosticScope;
	/** App diagnosis execution identity, pinned by native setup rather than inferred from a chat. */
	diagnosticHost?: OperationHost;
	/** Explicit native grant for bounded target history reads. Omitted for generic no-link diagnostics. */
	diagnosticHistoryAccess?: boolean;
	/** Diagnostics-only title hint: ignore the fixed opening instruction and wait for substantive assistant text. */
	diagnosticTitleFromReply?: boolean;
	/** Native-reviewed proposal authority. Accepted only by a durable repair-create operation. */
	diagnosticRepair?: DiagnosticRepairAdmission;
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

/** POST /api/sessions/:id/subscription-force. Returns SessionSummary. */
export interface SubscriptionForceRequest {
	force: boolean;
}

/** POST /api/sessions/:id/title. Renames a chat; the title is trimmed and must not be empty. */
export interface RenameSessionRequest {
	title: string;
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
 * POST /api/sessions/:id/retry-handoff. Only for a chat whose summary has `canRetryHandoff`. Admits one explicit user
 * input, shown as a `handoff_retry` event, that starts a fresh run; that run makes a new handoff attempt. Earlier
 * messages and tool calls are not resent. `operationId` names the input, so a repeated request admits it once.
 * 409 means nothing was admitted. Returns the session summary.
 */
export interface RetryHandoffRequest {
	operationId: string;
}

/**
 * POST /api/sessions/:id/compact. Starts a manual compaction and returns once it is durably queued. The conversation
 * keeps working; the summary is placed when idle or at the next turn boundary. Stop cancels it.
 */
export interface CompactRequest {
	/** Optional guidance for what the summary should keep. */
	instructions?: string;
}

/** Guard is not a replay key. A lost response remains uncertain; never retry automatically. */
export interface QueuedMessageGuard {
	token: string;
	operationId: string;
	daemonId: string;
	lineageId: string;
}
export interface GuardedQueueResponse {
	ok: true;
	guard: QueuedMessageGuard;
	sessionId: string;
	submissionId: number;
	action: "edit" | "remove";
}
/**
 * PATCH /api/sessions/:id/queue/:submissionId. Keeps the message's queue position. Without `mode`, the delivery mode
 * is unchanged; with it, the message is delivered as steering or as a follow-up from then on.
 */
export interface EditQueuedMessageRequest {
	guard?: QueuedMessageGuard;
	message: string;
	mode?: DeliveryMode;
}

/** DELETE /api/sessions/:id/queue/:submissionId. Legacy: no body; guarded: {guard: QueuedMessageGuard}.
 * Only withdraws an input still in the durable queue. Guarded success returns GuardedQueueResponse. */
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
