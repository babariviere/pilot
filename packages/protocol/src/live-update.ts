/** Proposal only. The receiving host must validate the local release and require native user approval. */
export interface LiveUpdateProposalArgs {
	/** Absolute local directory containing the built app release. Never a URL or installer command. */
	directory: string;
	/** Full lowercase source commit (40 hexadecimal characters). */
	source: string;
	/** Numeric dotted GUI build identifier. */
	build: string;
	summary: string;
}

/** POST /api/update/pause (tool drain) or legacy /prepare (idle only). Both hold a 30-second admission lease. */
export interface UpdatePreparation {
	/** Pause endpoints identify the process whose workers were drained. */
	processId?: number;
	ready: boolean;
}

/** Point-in-time observations, not an upgrade reservation or proof of idle work. */
export interface DaemonUpdateBlocker {
	kind: string;
	id: string;
	sessionId?: string;
	title?: string;
}
export interface DaemonUpdateBlockers {
	processId: number;
	daemonId: string;
	lineageId: string;
	blockers: DaemonUpdateBlocker[];
	truncated: boolean;
}
