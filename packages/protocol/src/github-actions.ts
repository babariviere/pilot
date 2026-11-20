/** Sanitized execution audit. Null means no authoritative command exit was exposed. */
export type PublicationSource =
	| { status: "unknown" }
	| {
			status: "owned";
			repositoryId: string;
			operationId: string;
			/** Exact selected bookmark tips only, not the complete contribution. */
			revisions: { changeId: string; commitId: string; startCommitId: string; baselineCommitId?: string }[];
	  };
export type GitHubAction = {
	id: string;
	/** Optional only for audits recorded by older kernels. */
	kind?: "push" | "pr_opened" | "pr_ready" | "pr_draft" | "pr_edited" | "pr_reopened" | "github_updated";
	branch?: string;
	prNumber?: number;
	title?: string;
	/** Exact URL of a PR the action created, only from confirmed `gh pr create` provenance. */
	url?: string;
	/** Top-level call, including when a nested codemode call performed the action. */
	toolCallId?: string;
	afterEntryId?: number;
	conversationId?: string;
	/** Membership at execution time, not at replay time. */
	missionId?: string;
	summary: string;
	description: string;
	target?: string;
	at: number;
	exitCode: number | null;
	/** Separate dispatch/result observations. Missing result stays Unknown; never replay a mutation. */
	publication?: {
		attemptId: string;
		stage: "attempted" | "confirmed" | "unknown";
		evidence: "command-dispatch" | "command-result";
		/** Pre-dispatch local selection, not proof that this revision reached a remote. */
		local: PublicationSource;
	};
};
/** User-facing automatic event. The full agent-facing message remains on the entry. */
export interface ChatEventSummary {
	kind:
		| "mission_updated"
		| "mission_decisions_changed"
		| "mission_task_done"
		| "mission_member_finished"
		| "watch_notice"
		| "automation_finished"
		| "automation_failed"
		/** The user retried a run that failed in automatic handoff. */
		| "handoff_retry"
		/** A provider blocked a turn as cyber work and Pilot sent it again with the Cyber profile. */
		| "cyber_retry";
	text: string;
}
