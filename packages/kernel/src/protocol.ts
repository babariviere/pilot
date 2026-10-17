/** IPC between pilotd and one kernel worker process. */

import type { JsonValue } from "@earendil-works/chord";
import type {
	AgentEvent,
	ArtifactRevision,
	DeliveryMode,
	RewindAction,
	SessionAttempt,
	SessionCommand,
	SessionCompletion,
	SessionJob,
	SessionSubagent,
} from "@pilot/protocol";
import type { ControlCall } from "./control-turn.ts";
import type { CredentialEndpoint } from "./credential-rpc.ts";
import type { DatabaseAction } from "./database-tool.ts";
import type { MissionAction } from "./mission-tools.ts";
import type { PilotAction } from "./pilot-tool.ts";
import type { MissionContext, PilotContext, WorkspaceContext } from "./policy.ts";
import type { KernelUsage } from "./usage.ts";

export type { KernelUsage } from "./usage.ts";
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
	control?: boolean;
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
	/** Explicit same-provider continuation after the previous worker's tool drain and close. */
	continuationModel?: { model: string; thinking?: string; requestId: string };
	agentDir?: string;
	/** Directory whose pi project trust applies (the project's own checkout, not its clone). */
	trustDirectory?: string;
	/** Workspace and policy context for Pilot's prompt section. */
	pilot?: PilotContext;
	/** The mission this chat belongs to, when it starts. Later changes arrive as `mission.context`. */
	mission?: MissionContext;
	/** pilotd has a database config; register the `db` tool. Connection details stay in pilotd. */
	databases?: boolean;
}

export type KernelCommand =
	| { type: "start"; spec: KernelSpec }
	| {
			type: "input";
			requestId: string;
			content: string;
			mode: DeliveryMode;
			onlyIfIdle?: boolean;
			reportDelivery?: boolean;
			event?: import("@pilot/protocol").ChatEventSummary;
	  }
	/** Passive, display-only daemon activity. Never schedules a model turn. */
	| { type: "activity"; requestId: string; text: string }
	| { type: "editQueuedMessage"; requestId: string; submissionId: number; content: string; mode?: DeliveryMode }
	| { type: "changeModel"; requestId: string; model: string; thinking?: string }
	/** Drain committed tool effects and quiesce children before relinquishing workspace ownership. */
	| { type: "continuation.pause"; requestId: string }
	| { type: "removeQueuedMessage"; requestId: string; submissionId: number }
	/** Manual compaction, acknowledged with `accepted` once its task is committed. */
	| { type: "compact"; requestId: string; instructions?: string }
	| { type: "abort"; requestId: string }
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
	| { type: "watch"; watchId: string; includeTodos?: boolean; activityOnly?: boolean }
	| { type: "unwatch"; watchId: string }
	/** Replaces the mission context; omitted when the chat left its mission. */
	| { type: "mission.context"; context?: MissionContext }
	| { type: "mission.result"; callId: string; result?: JsonValue; error?: string }
	| { type: "memory.result"; callId: string; result?: JsonValue; error?: string }
	| { type: "control.result"; callId: string; result?: JsonValue; error?: string }
	| { type: "pilot.result"; callId: string; result?: JsonValue; error?: string }
	| { type: "watch.run.result"; callId: string; error?: string }
	| { type: "database.result"; callId: string; result?: JsonValue; error?: string }
	| { type: "slack.result"; callId: string; result?: JsonValue; error?: string }
	/** Whether the chat is attached to a Slack triage message, which declares or withdraws `slack_status`. */
	| { type: "slack.linked"; linked: boolean }
	| { type: "subscription.limit.result"; callId: string; error?: string }
	| { type: "artifact.reference.result"; callId: string; result?: Omit<ArtifactRevision, "html">; error?: string }
	| { type: "workspace.prepared"; callId: string; workspace?: WorkspaceContext }
	| { type: "update.pause"; id: string }
	| { type: "update.resume" }
	| { type: "shutdown" };

export type KernelPacket =
	/** Lifecycle admission, never mere queue placement. Acknowledged before publishing completion. */
	| { type: "watch.run"; callId: string; controlCaused: boolean }
	| { type: "update.paused"; id: string; error?: string }
	| { type: "systemMessageState"; event: import("./held-inputs.ts").SystemMessageStateEvent }
	| {
			type: "ready";
			execution?: ExecutionEvidence;
			model: string;
			thinking?: string;
			working: boolean;
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
	| { type: "todos.changed"; openCount: number }
	| { type: "usage"; usage: KernelUsage }
	/** Confirm a provider-reported usage hold before retrying only its pending request. */
	| { type: "subscription.limit"; callId: string; limit: import("./subscription-limit.ts").SubscriptionLimitReport }
	| { type: "children"; requestId: string; hasChildren: boolean }
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
	/** A `mission` tool call, answered by `mission.result`. */
	| { type: "mission.call"; callId: string; action: MissionAction; args: Record<string, JsonValue> }
	| { type: "pilot.call"; callId: string; operationId: string; action: PilotAction; args: Record<string, JsonValue> }
	| { type: "control.call"; callId: string; action: Parameters<ControlCall>[0]; args: Record<string, JsonValue> }
	| {
			type: "memory.call";
			callId: string;
			operationId?: string;
			action: "wake" | "note" | "recall" | "zoom";
			args: Record<string, JsonValue>;
	  }
	/** A `db` tool call, answered by `database.result`. Grants are checked in pilotd. */
	| { type: "database.call"; callId: string; action: DatabaseAction; args: Record<string, JsonValue> }
	/** A `slack_status` tool call, answered by `slack.result`. Applies only to Slack messages linked to this chat. */
	| { type: "slack.call"; callId: string; args: Record<string, JsonValue> }
	/** Read-only linked source lookup. Caller identity comes from the supervised worker, not this packet. */
	| { type: "artifact.reference.get"; callId: string; id: string; revision?: number }
	/** The kernel is awaiting its first prompt preparation. No model or tools are running. */
	| { type: "workspace.prepare"; callId: string }
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
	| { type: "events"; watchId: string; events: AgentEvent[] }
	| { type: "error"; requestId?: string; message: string; code?: "busy" };
