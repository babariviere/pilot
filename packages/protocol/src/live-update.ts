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
