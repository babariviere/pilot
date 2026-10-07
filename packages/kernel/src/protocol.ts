/** IPC between pilotd and one kernel worker process. */
import type { AgentEvent, DeliveryMode, SessionCompletion, SessionUsage } from "@pilot/protocol";
import type { PilotContext } from "./policy.ts";

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
}

export type KernelCommand =
	| { type: "start"; spec: KernelSpec }
	| { type: "input"; requestId: string; content: string; mode: DeliveryMode }
	| { type: "editQueuedMessage"; requestId: string; submissionId: number; content: string }
	| { type: "abort"; requestId: string }
	| { type: "watch"; watchId: string; includeTodos?: boolean }
	| { type: "unwatch"; watchId: string }
	| { type: "shutdown" };

export type KernelPacket =
	| { type: "ready"; model: string; working: boolean; usage: SessionUsage; completion?: SessionCompletion }
	| { type: "usage"; usage: SessionUsage }
	| { type: "artifacts.changed" }
	| { type: "accepted"; requestId: string }
	| { type: "aborted"; requestId: string }
	| { type: "working"; working: boolean; completion?: SessionCompletion }
	| { type: "events"; watchId: string; events: AgentEvent[] }
	| { type: "error"; requestId?: string; message: string };
