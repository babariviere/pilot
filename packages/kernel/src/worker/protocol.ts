/** IPC between pilotd and one kernel worker process. */

import type { JsonValue } from "@earendil-works/chord/json";
import type {
	AgentEvent,
	ArtifactRevision,
	DeliveryMode,
	DiagnosticLogRequest,
	DiagnosticLogResult,
	DiagnosticTargetReference,
	OperationHost,
	RewindAction,
	SessionAttempt,
	SessionCommand,
	SessionCompletion,
	SessionJob,
	SessionSubagent,
	ToolActivitySnapshot,
} from "@pilot/protocol";
import type { TelemetryEnvironment, TelemetryHostKind, TraceCarrier } from "@pilot/telemetry";
import type { CredentialEndpoint } from "../credentials/credential-rpc.ts";
import type { MissionAction } from "../missions/mission-tools.ts";
import type { MissionContext, PilotContext, WorkspaceContext } from "../runtime/policy.ts";
import type { KernelUsage } from "../funding/usage.ts";

/** Durable Harness identities, never inferred from wall-clock outcome timestamps. */
export interface ExecutionEvidence {
	attemptId: string;
	inputSubmissionId?: number;
	inputOperationId?: string;
	completionEntry?: number;
}

/** A subagent as reported by the kernel, including where its read-only transcript lives. */
export interface KernelSubagent extends SessionSubagent {
	/** Private durable directory holding the child's `runs.sqlite`. Never sent to clients. */
	storage: string;
	/** Child conversation inside `runs.sqlite`, once started. */
	conversationId?: string;
}

export interface KernelSpec {
	/** Declares a protected host tool, not a metrics grant. Daemon checks each read. */
	scopedMetrics?: boolean;
	/** Protected target-only log reads backed by an exact saved feedback admission. */
	feedbackLogs?: boolean;
	/** Creation-only trusted profile. Never inferred from membership or prompt text. */
	planning?: import("../missions/planning-worker.ts").PlanningWorkerBinding;
	planningHeldOnOpen?: boolean;
	/** Local accounting epoch, never telemetry or provider options. */
	usageHistory?: import("../funding/usage-capture.ts").UsageCaptureEpoch;
	usageMission?: NonNullable<import("@pilot/protocol").UsageObservation["attribution"]>["mission"];
	/** Runtime-enforced specialist profile. Omitted for ordinary Build and Ask sessions. */
	role?: import("@pilot/protocol").SessionRole;
	insightsBinding?: import("@pilot/protocol").InsightsBinding;
	insightsOwnerBinding?: import("@pilot/protocol").InsightsOwnerBinding;
	/** One non-reopenable, empty durable context for this host-admitted Day report run. */
	dayInsightsRunId?: string;
	/** Host-admitted chat that a diagnostics specialist may inspect. */
	diagnosticTarget?: DiagnosticTargetReference;
	/** Host-admitted app scope when no chat is attached. */
	diagnosticScope?: { kind: "app"; host: OperationHost };
	/** Explicit user grant for bounded target conversation/tool history. Missing means content-free diagnostics only. */
	diagnosticHistoryAccess?: boolean;
	/** Native-confirmed repair-only read scope. Never inherited by child agents. */
	repairDiagnostics?: import("@pilot/protocol").DiagnosticEvidenceSubject;
	/** Ephemeral capability, never stored in session metadata or transcripts. Inherited by descendants. */
	credentials?: CredentialEndpoint;
	/** Host-resolved trust for read-only Linux configuration; never a writable trust-store exception. */
	projectTrusted?: boolean;
	/** Pilot session ID, reused as the native session ID. */
	sessionId: string;
	/** Project identity attached to published artifacts. */
	projectId?: string;
	/** Private directory holding this session's durable storage. */
	storageDir: string;
	/** Host-owned admission policy shared with subagents, outside their durable model history. */
	subscriptionPolicy?: string;
	/** Daemon-confirmed internet reachability, shared with child workers. */
	connectivityPolicy?: string;
	cwd: string;
	/** Used only when the session is created; later starts reuse the pinned model. */
	model?: string;
	thinking?: string;
	/** Cancel parked work before recovery can dispatch a model request or tool. */
	stopOnOpen?: boolean;
	/** Short-lived configuration worker, opened under the existing Stop request/tool barriers. */
	configurationOnly?: true;
	/** Park queued input before recovered work can reach its next boundary. */
	pauseInputsOnOpen?: number;
	/** Explicit same-provider continuation after the previous worker's tool drain and close. */
	continuationModel?: { model: string; thinking?: string; requestId: string };
	/** Activated only by explicit user recovery, configured before resume. */
	recoveryModel?: { model: string; thinking?: string };
	agentDir?: string;
	/** Directory whose pi project trust applies (the project's own checkout, not its clone). */
	trustDirectory?: string;
	/** Workspace and policy context for Pilot's prompt section. */
	pilot?: PilotContext;
	/** The mission this chat belongs to, when it starts. Later changes arrive as `mission.context`. */
	mission?: MissionContext;
	/** Supervised host admission for proposal-only updates in writable local Pilot project chats. */
	liveUpdateProposals?: boolean;
	/** Host-owned export consent. No credential, arbitrary header or analytics identity crosses IPC. */
	telemetry?: KernelTelemetryConfiguration;
}

export interface KernelTelemetryConfiguration {
	enabled: boolean;
	endpoint?: string;
	serviceVersion: string;
	environment: TelemetryEnvironment;
	hostKind: TelemetryHostKind;
	hostId: string;
	localDiagnostics: boolean;
}

/**
 * Calls a kernel tool makes to pilotd. The kernel sends `host.call` with the method and its arguments, and pilotd answers
 * with one `host.result` (a result or an error). `host.cancel` aborts the call in pilotd. pilotd checks the caller's
 * identity and role from the supervised worker, never from these arguments.
 */
export interface HostCalls {
	/** Re-checks a clarification admission right before the kernel commits it. */
	"question.guard": { args: { requestId: string }; result: void };
	/** The planning profile's bound native port. */
	planning: {
		args: { request: import("../missions/planning-worker.ts").PlanningWorkerRequest };
		result: import("../missions/planning-worker.ts").PlanningWorkerReply;
	};
	"planning.guard": { args: { operationId: string }; result: void };
	"model.configuration.guard": { args: { requestId: string }; result: void };
	"usage-history": {
		args: { row: import("@pilot/protocol").UsageObservation };
		result: import("@pilot/protocol").UsageHistoryWriteResult;
	};
	"usage-history.epoch": { args: Record<string, never>; result: import("../funding/usage-capture.ts").UsageCaptureEpoch };
	/** Confirm a provider-reported usage hold before retrying only its pending request. */
	"subscription.limit": { args: { limit: import("../funding/subscription-limit.ts").SubscriptionLimitReport }; result: void };
	/** A `mission` tool call. */
	mission: { args: { action: MissionAction; args: Record<string, JsonValue> }; result: JsonValue };
	"insights.backlog": { args: { request: unknown }; result: JsonValue };
	/** Only the supervised coordinator may request its current scope. */
	"source.scope": { args: Record<string, never>; result: import("../missions/coordinator-sources.ts").CoordinatorSources };
	/** pilotd resolves this session's project dependency and linked-project roots. */
	"source.references": { args: Record<string, never>; result: import("../tools/sources/reference-sources.ts").ReferenceSource[] };
	memory: {
		args: { operationId?: string; action: "wake" | "note" | "recall" | "zoom"; args: Record<string, JsonValue> };
		result: JsonValue;
	};
	/** pilotd derives project, author and write capability from this session. */
	knowledge: {
		args: {
			operationId?: string;
			action: import("../tools/knowledge/knowledge-tools.ts").KnowledgeAction | import("../tools/knowledge/knowledge-tools.ts").ProjectContextAction;
			args: Record<string, JsonValue>;
		};
		result: JsonValue;
	};
	/** Proposal only. pilotd rechecks scope and validates the release. */
	"liveUpdate.propose": {
		args: { operationId: string; args: import("@pilot/protocol").LiveUpdateProposalArgs };
		result: JsonValue;
	};
	/** A `slack_status` tool call. Applies only to Slack messages linked to this chat. */
	slack: { args: { args: Record<string, JsonValue> }; result: JsonValue };
	/** A `chat_report` tool call. Only job chats (`pilot.job`) declare the tool. */
	chatReport: { args: { args: Record<string, JsonValue> }; result: JsonValue };
	/** Content-free diagnostic read. */
	diagnostics: {
		args: { sessionId?: string; limit?: number };
		result: import("@pilot/protocol").DiagnosticSnapshot;
	};
	"diagnostics.context": {
		args: { request: import("@pilot/protocol").DiagnosticContextRequest };
		result: import("@pilot/protocol").DiagnosticContextResponse;
	};
	/** A ui_* tool call of a screen agent chat, answered by the bound Day window. For a screenshot: ScreenPictureData. */
	screen: { args: { operation: import("@pilot/protocol").ScreenOperation }; result: JsonValue };
	/** Explicitly granted target-history read. */
	"diagnostics.history": {
		args: { sessionId: string; before?: number; limit?: number };
		result: import("@pilot/protocol").DiagnosticHistoryPage;
	};
	/** Fixed-host Pilot log inventory, search and excerpts. No caller-supplied paths or host or session selectors. */
	"diagnostics.logs": { args: { request: DiagnosticLogRequest }; result: DiagnosticLogResult };
	/** Limited proposal publication. This cannot create or change a repair or target chat. */
	"diagnostics.proposal": {
		args: { proposal: import("@pilot/protocol").DiagnosticRepairProposalDraft };
		result: import("@pilot/protocol").DiagnosticRepairProposal;
	};
	/** Read-only linked source lookup. */
	"artifact.reference": { args: { id: string; revision?: number }; result: Omit<ArtifactRevision, "html"> };
	/** Passive exact-bookmark custody read, no caller-supplied repository or ownership. */
	"publication.source": { args: { bookmark?: string }; result: import("@pilot/protocol").PublicationSource };
}

export type HostMethod = keyof HostCalls;
export type HostCallPacket = {
	[M in HostMethod]: { type: "host.call"; callId: string; method: M; args: HostCalls[M]["args"] };
}[HostMethod];
export type HostCall = <M extends HostMethod>(
	method: M,
	args: HostCalls[M]["args"],
	signal?: AbortSignal,
) => Promise<HostCalls[M]["result"]>;

export type KernelCommand =
	| { type: "question.clarify"; requestId: string; questionId: number; question: string }
	| { type: "planning.input"; requestId: string; input: import("../missions/planning-worker.ts").PlanningInput }
	| { type: "plan.start"; requestId: string; content: string }
	| { type: "start"; spec: KernelSpec }
	/** Older workers cannot ignore this mode and resume a recovered inbox. */
	| { type: "startConfiguration"; spec: KernelSpec }
	| {
			type: "input";
			requestId: string;
			content: string;
			mode: DeliveryMode;
			onlyIfIdle?: boolean;
			reportDelivery?: boolean;
			/** Explicit redirect releases the Stop hold without impersonating a user submission. */
			resumeHeld?: boolean;
			/** Coordinator reply to this exact pending ordinary question entry. */
			answerQuestionId?: number;
			/** Native user reply, atomically fenced to the exact immutable question entry. */
			questionReplyId?: number;
			/** Exact native human submission, checked again on the kernel mutation line. */
			interviewReply?: import("@pilot/protocol").StandaloneInterviewReply;
			/** Native capture's Stop generation, retained in pilotd's outbox. */
			inputGeneration?: number;
			/** A newer Stop permits receipt dedupe only, never a new submission. */
			dedupeOnly?: boolean;
			/** Ephemeral W3C parent context from pilotd. Never contains baggage or conversation data. */
			trace?: TraceCarrier;
			event?: import("@pilot/protocol").ChatEventSummary;
	  }
	/** Passive, display-only daemon activity. Never schedules a model turn. */
	| { type: "activity"; requestId: string; text: string; event?: import("@pilot/protocol").ChatEventSummary }
	| {
			type: "editQueuedMessage";
			requestId: string;
			submissionId: number;
			content: string;
			mode?: DeliveryMode;
			guardToken?: string;
	  }
	/** signedIn: a work profile's model, which needs only a sign-in, not the chat model list. */
	| { type: "changeModel"; requestId: string; model: string; thinking?: string; signedIn?: true }
	/** Distinct command: older workers cannot silently ignore the configuration-only guard. */
	| { type: "changeModelConfiguration"; requestId: string; model: string; thinking?: string }
	/** Idle-only extension/resource and MCP configuration reload. Busy is a refusal, never an abort. */
	| { type: "reloadPi"; requestId: string }
	/** Drain committed tool effects and quiesce children before relinquishing workspace ownership. */
	| { type: "continuation.pause"; requestId: string }
	| { type: "removeQueuedMessage"; requestId: string; submissionId: number; guardToken?: string }
	/** Manual compaction, acknowledged with `accepted` once its task is committed. */
	| { type: "compact"; requestId: string; instructions?: string }
	| { type: "abort"; requestId: string }
	| { type: "pauseInputs"; requestId: string; revision: number }
	| { type: "resumeInputs"; requestId: string; revision: number }
	| { type: "sendHeldMessages"; requestId: string }
	| { type: "discardHeldMessages"; requestId: string; submissionId?: number }
	| { type: "systemMessageState.ack"; id: string }
	/** Stop work and continue from an earlier point in a new attempt. Answered by `rewound`. */
	| { type: "rewind"; requestId: string; action: RewindAction; entryId: number }
	/** Stop work and continue another attempt. Answered by `rewound`. */
	| { type: "activateAttempt"; requestId: string; attemptId: number }
	| { type: "inspectChildren"; requestId: string }
	| { type: "inspectJobs"; requestId: string }
	/** Stop one running job for the user and tell the agent. Answered by `accepted`, or `error` for an unknown job. */
	| { type: "stopJob"; requestId: string; jobId: string }
	| {
			type: "subagent";
			requestId: string;
			action: "send" | "stop";
			name: string;
			message?: string;
			mode?: DeliveryMode;
	  }
	| { type: "watch"; watchId: string; includeTodos?: boolean; activityOnly?: boolean; recent?: boolean }
	| { type: "unwatch"; watchId: string }
	/** Replaces the mission context; omitted when the chat left its mission. */
	| { type: "mission.context"; context?: MissionContext }
	/** Whether the chat is attached to a Slack triage message, which declares or withdraws `slack_status`. */
	| { type: "slack.linked"; linked: boolean }
	| { type: "workspace.prepared"; callId: string; workspace?: WorkspaceContext }
	| { type: "update.pause"; id: string }
	| { type: "checkpointUpdate"; requestId: string }
	| { type: "checkpointLifecycle"; requestId: string; operationId: string; notifyUpdate?: true }
	| { type: "update.resume" }
	| { type: "telemetry.configure"; configuration: KernelTelemetryConfiguration }
	| { type: "diagnostics.configure"; enabled: boolean }
	| { type: "diagnostics.clear.prepare"; requestId: string }
	| { type: "host.result"; callId: string; result?: unknown; error?: string }
	| { type: "shutdown" };

export type KernelPacket =
	| { type: "piReloaded"; requestId: string; commands: SessionCommand[] }
	/** Lifecycle admission, never mere queue placement. Acknowledged before publishing completion. */
	| { type: "update.paused"; id: string; error?: string }
	| { type: "systemMessageState"; event: import("../session/input/held-inputs-doc.ts").SystemMessageStateEvent }
	| {
			type: "ready";
			/** Provider-free model configuration command and host-boundary guard handshake. */
			modelConfiguration?: 1;
			questionClarification?: 1;
			toolsRunning?: boolean;
			execution?: ExecutionEvidence;
			model: string;
			thinking?: string;
			working: boolean;
			/** A compaction is summarizing the conversation, possibly without a run. */
			compacting?: boolean;
			usage: KernelUsage;
			/** All statuses except done/closed; absent on older kernels. */
			openTodoCount?: number;
			completion?: SessionCompletion;
			/** Prompt templates and skill commands the native kernel expands on input. */
			commands?: SessionCommand[];
			/** Omitted while the session has a single attempt. */
			attempts?: SessionAttempt[];
	  }
	| { type: "jobs.changed"; jobs: SessionJob[] }
	| { type: "tool.activity"; activity: ToolActivitySnapshot }
	/** Active top-level call, including its entire codemode script. Never gated by diagnostics. */
	| { type: "tools.running"; running: boolean }
	/** The live run awaits this blocking ask_user question; omitted once answered, stopped or ended. Presentation only. */
	| { type: "question.awaited"; question?: string }
	| { type: "todos.changed"; openCount: number }
	| { type: "usage"; usage: KernelUsage }
	| { type: "children"; requestId: string; hasChildren: boolean }
	/** Private final child identities and independent census after durable close, before its ACK. */
	| {
			type: "lifecycle.checkpointed";
			requestId: string;
			operationId: string;
			conversationId: string;
			/** Durable context write, not proof that the model read the notice. */
			updateNoticeOperationId?: string;
			children: KernelSubagent[];
			jobs: number;
			hasChildren: boolean;
	  }
	| { type: "jobs"; requestId: string; jobs: SessionJob[] }
	/** Full replacement, after every change reported by the subagents extension. */
	| { type: "subagents"; subagents: KernelSubagent[] }
	| { type: "artifacts.changed" }
	| { type: "pullRequest.created"; url: string }
	/** The agent ran a gh PR creation whose URL could not be confirmed. A hint to look for a new PR on its branch. */
	| { type: "pullRequest.attempted" }
	/** The agent may have created, moved or pushed a branch. A hint to recheck PRs, not ownership. */
	| { type: "refs.changed" }
	| { type: "github.action"; action: import("@pilot/protocol").GitHubAction }
	/** A top-level tool call reached for MCP servers (namespaces, dashes as underscores). A hint, at most once a minute. */
	| { type: "mcp.used"; namespaces: string[]; failed: boolean }
	/** The kernel is awaiting its first prompt preparation. No model or tools are running. */
	| { type: "workspace.prepare"; callId: string }
	| HostCallPacket
	| { type: "host.cancel"; callId: string }
	| { type: "accepted"; requestId: string; delivery?: "delivered" | "queued" | "not_started"; reason?: string }
	/** `withdrawn` holds the user's own queued messages, in delivery order, which Stop restores to the composer. */
	| { type: "aborted"; requestId: string; withdrawn?: { requestId?: string; content: string }[] }
	/**
	 * The active attempt changed (`switched`): this kernel accepts no more work and must be replaced. `content` is the
	 * message retry resends or edit restores to the composer.
	 */
	| { type: "rewound"; requestId: string; switched: boolean; content?: string; attempts?: SessionAttempt[] }
	| {
			type: "modelChanged";
			requestId: string;
			model: string;
			thinking: string;
			usage: KernelUsage;
			switched?: boolean;
			attempts?: SessionAttempt[];
	  }
	| { type: "working"; working: boolean; completion?: SessionCompletion; execution?: ExecutionEvidence }
	/** A compaction started or ended. Shown as work, but it is not a turn and produces no result. */
	| { type: "compacting"; compacting: boolean }
	| { type: "events"; watchId: string; events: AgentEvent[] }
	| { type: "error"; requestId?: string; message: string; code?: "busy" | "stale_question" | "stopped" };
