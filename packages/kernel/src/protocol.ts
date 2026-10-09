/** IPC between pilotd and one kernel worker process. */
import type { AgentEvent, DeliveryMode, SessionCompletion, SessionSubagent, SessionUsage } from "@pilot/protocol";
import type { JsonValue } from "@earendil-works/chord";
import type { MissionAction } from "./mission-tools.ts";
import type { MissionContext, PilotContext } from "./policy.ts";

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
	| { type: "input"; requestId: string; content: string; mode: DeliveryMode; onlyIfIdle?: boolean }
	| { type: "editQueuedMessage"; requestId: string; submissionId: number; content: string; mode?: DeliveryMode }
	| { type: "changeModel"; requestId: string; model: string; thinking?: string }
	| { type: "removeQueuedMessage"; requestId: string; submissionId: number }
	| { type: "abort"; requestId: string }
	| { type: "inspectChildren"; requestId: string }
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
	| { type: "shutdown" };

export type KernelPacket =
	| {
			type: "ready";
			model: string;
			thinking?: string;
			working: boolean;
			usage: SessionUsage;
			completion?: SessionCompletion;
	  }
	| { type: "usage"; usage: SessionUsage }
	| { type: "children"; requestId: string; hasChildren: boolean }
	/** Full replacement, after every change reported by the subagents extension. */
	| { type: "subagents"; subagents: KernelSubagent[] }
	| { type: "artifacts.changed" }
	| { type: "pullRequest.created"; url: string }
	/** A `mission` tool call, answered by `mission.result`. */
	| { type: "mission.call"; callId: string; action: MissionAction; args: Record<string, JsonValue> }
	| { type: "accepted"; requestId: string }
	| { type: "aborted"; requestId: string }
	| { type: "modelChanged"; requestId: string; model: string; thinking: string; usage: SessionUsage }
	| { type: "working"; working: boolean; completion?: SessionCompletion }
	| { type: "events"; watchId: string; events: AgentEvent[] }
	| { type: "error"; requestId?: string; message: string; code?: "busy" };
