/** IPC between pilotd and one kernel worker process. */
import type { AgentEvent, DeliveryMode } from "@pilot/protocol";

export interface KernelSpec {
	/** Pilot session ID, reused as the native session ID. */
	sessionId: string;
	/** Private directory holding this session's durable storage. */
	storageDir: string;
	cwd: string;
	/** Used only when the session is created; later starts reuse the pinned model. */
	model?: string;
	thinking?: string;
	agentDir?: string;
}

export type KernelCommand =
	| { type: "start"; spec: KernelSpec }
	| { type: "input"; requestId: string; content: string; mode: DeliveryMode }
	| { type: "abort"; requestId: string }
	| { type: "watch"; watchId: string }
	| { type: "unwatch"; watchId: string }
	| { type: "shutdown" };

export type KernelPacket =
	| { type: "ready"; model: string; working: boolean }
	| { type: "accepted"; requestId: string }
	| { type: "aborted"; requestId: string }
	| { type: "working"; working: boolean }
	| { type: "events"; watchId: string; events: AgentEvent[] }
	| { type: "error"; requestId?: string; message: string };
