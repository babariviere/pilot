/** A remote update belongs to the host, not to the observing app connection. */
export type RuntimeUpdatePhase =
	| "staged"
	| "requested"
	| "waiting"
	| "draining"
	| "ready"
	| "stopping"
	| "switching"
	| "validating"
	| "completed"
	| "cancelled"
	| "needs-repair";
export interface RuntimeUpdateStatus {
	id: string;
	version: string;
	phase: RuntimeUpdatePhase;
	/** False for staging alone. Reuse the same id; an independent update has not been confirmed. */
	requestConfirmed: boolean;
	revision: number;
	blockers: { kind: string; id: string; sessionId?: string }[];
	detail?: string;
}
export interface RuntimeProcessIdentity {
	bootId: string;
	pid: number;
	start: string;
}
