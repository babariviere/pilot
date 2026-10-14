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
import type { MissionAction } from "./mission-tools.ts";
import type { MissionContext, PilotContext, WorkspaceContext } from "./policy.ts";
import type { KernelUsage } from "./usage.ts";

export type { KernelUsage } from "./usage.ts";

/** A subagent as reported by the kernel, including where its read-only transcript lives. */
export interface KernelSubagent extends SessionSubagent {
	/** Private durable directory holding the child's `runs.sqlite`. Never sent to clients. */
	storage: string;
	/** Child conversation inside `runs.sqlite`, once started. */
	conversationId?: string;
}

export interface KernelSpec {
	/** Pilot session ID, reused as the native session ID. */
	sessionId: string;
	/** Project identity attached to published artifacts. */
	projectId?: string;
	/** Private directory holding this session's durable storage. */
	storageDir: string;
	cwd: string;
	/** Used only when the session is created; later starts reuse the pinned model. */
	model?: string;
	thinking?: string;
	agentDir?: string;
	/** Directory whose pi project trust applies (the project's own checkout, not its clone). */
	trustDirectory?: string;
	/** Workspace and policy context for Pilot's prompt section. */
	pilot?: PilotContext;
	/** The mission this chat belongs to, when it starts. Later changes arrive as `mission.context`. */
	mission?: MissionContext;
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
	  }
	/** Passive, display-only daemon activity. Never schedules a model turn. */
	| { type: "activity"; requestId: string; text: string }
	| { type: "editQueuedMessage"; requestId: string; submissionId: number; content: string; mode?: DeliveryMode }
	| { type: "changeModel"; requestId: string; model: string; thinking?: string }
	| { type: "removeQueuedMessage"; requestId: string; submissionId: number }
	/** Manual compaction, acknowledged with `accepted` once its task is committed. */
	| { type: "compact"; requestId: string; instructions?: string }
	| { type: "abort"; requestId: string }
	/** Stop work and continue from an earlier point in a new attempt. Answered by `rewound`. */
	| { type: "rewind"; requestId: string; action: RewindAction; entryId: number }
	/** Stop work and continue another attempt. Answered by `rewound`. */
	| { type: "activateAttempt"; requestId: string; attemptId: number }
	| { type: "inspectChildren"; requestId: string }
	| { type: "inspectJobs"; requestId: string }
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
	| { type: "artifact.reference.result"; callId: string; result?: Omit<ArtifactRevision, "html">; error?: string }
	| { type: "workspace.prepared"; callId: string; workspace?: WorkspaceContext }
	| { type: "shutdown" };

export type KernelPacket =
	| {
			type: "ready";
			model: string;
			thinking?: string;
			working: boolean;
			usage: KernelUsage;
			completion?: SessionCompletion;
			/** Prompt templates and skill commands the native kernel expands on input. */
			commands?: SessionCommand[];
			/** Omitted while the session has a single attempt. */
			attempts?: SessionAttempt[];
	  }
	| { type: "jobs.changed"; jobs: SessionJob[] }
	| { type: "usage"; usage: KernelUsage }
	| { type: "children"; requestId: string; hasChildren: boolean }
	| { type: "jobs"; requestId: string; jobs: SessionJob[] }
	/** Full replacement, after every change reported by the subagents extension. */
	| { type: "subagents"; subagents: KernelSubagent[] }
	| { type: "artifacts.changed" }
	| { type: "pullRequest.created"; url: string }
	/** The agent may have created, moved or pushed a branch. A hint to recheck PRs, not ownership. */
	| { type: "refs.changed" }
	| { type: "github.action"; action: import("@pilot/protocol").GitHubAction }
	/** A `mission` tool call, answered by `mission.result`. */
	| { type: "mission.call"; callId: string; action: MissionAction; args: Record<string, JsonValue> }
	| {
			type: "memory.call";
			callId: string;
			action: "wake" | "note" | "recall" | "zoom";
			args: Record<string, JsonValue>;
	  }
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
	| { type: "modelChanged"; requestId: string; model: string; thinking: string; usage: KernelUsage }
	| { type: "working"; working: boolean; completion?: SessionCompletion }
	| { type: "events"; watchId: string; events: AgentEvent[] }
	| { type: "error"; requestId?: string; message: string; code?: "busy" };
