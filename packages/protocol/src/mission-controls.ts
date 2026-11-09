/** Host-confirmed control, distinct from archive, autopilot and daemon upgrades. */
export interface MissionControlCommand {
	version: 1;
	operationId: string;
	home: { daemonId: string; lineageId: string };
	projectId: string;
	coordinatorSessionId: string | null;
	expectedRevision: number;
	action: "pause" | "resume";
	/** Required for Resume. Only this Pause's work may resume. */
	pauseOperationId?: string;
}

export interface MissionControl {
	version: 1;
	missionId: string;
	revision: number;
	pauseGeneration: number;
	stopGeneration: number;
	held: boolean;
	state: "running" | "pausing" | "paused" | "resuming" | "unknown";
	operationId?: string;
	pauseOperationId?: string;
}

export interface MissionControlMember {
	sessionId: string;
	state: "pending" | "entered" | "paused" | "resumed" | "held" | "unknown";
	reason?: string;
}

/** Historical receipt. GET never executes or retries work. */
export interface MissionControlOperation {
	version: 1;
	missionId: string;
	command: MissionControlCommand;
	/** Opaque exact membership/coordinator event fence, including ABA changes. */
	ownerFence: string;
	control: MissionControl;
	members: MissionControlMember[];
	issues?: string[];
	state: "entered" | "acknowledged" | "unknown";
}
