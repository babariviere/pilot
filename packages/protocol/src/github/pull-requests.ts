/** A GitHub pull request discovered from a session branch or explicitly bound to the session. */
export interface SessionPullRequest {
	number: number;
	url: string;
	title: string;
	state: "draft" | "open" | "merged" | "closed";
	/** Head branch. Omitted by older daemons. */
	branch?: string;
	/** GitHub's merge time, epoch milliseconds, for merged PRs. */
	mergedAt?: number;
	/** GitHub's creation time, epoch milliseconds. Omitted by older daemons and caches. */
	createdAt?: number;
	/** Last successful GitHub lookup, epoch milliseconds. Cached across restarts. */
	checkedAt: number;
	/** Read-only GitHub stack membership. Absent for unstacked PRs or unsupported servers. */
	stack?: PullRequestStack;
	/** Merge readiness from the last successful health lookup. Absent until checked, or for terminal PRs. */
	readiness?: PullRequestReadiness;
}

/** POST /api/sessions/:id/pull-requests. Returns SessionSummary & PullRequestBindingResult. */
export interface BindPullRequestRequest {
	/** GitHub PR URL, or a positive number (123 or #123, no leading zero) in the project's GitHub upstream. */
	url: string;
	/** Optional mission task ID or number to disambiguate the owning task. */
	taskId?: string;
}

/** DELETE /api/sessions/:id/pull-requests. Returns SessionSummary & PullRequestBindingResult. */
export interface UnbindPullRequestRequest {
	url: string;
}

/** DELETE /api/sessions/:id/branches. Stops tracking a branch without a PR; returns SessionSummary. */
export interface DetachBranchRequest {
	branch: string;
}

export type PullRequestMergeMethod = "squash" | "merge" | "rebase";

/** Fresh confirmation data for a user-initiated merge. Never enables auto-merge or bypasses protection. */
export interface PullRequestMergePreview {
	url: string;
	number: number;
	title: string;
	headSha: string;
	headBranch: string;
	baseBranch: string;
	methods: PullRequestMergeMethod[];
}

/** POST /api/sessions/:id/pull-requests/merge. Returns { merged: true }. */
export interface MergePullRequestRequest {
	url: string;
	headSha: string;
	baseBranch: string;
	method: PullRequestMergeMethod;
}

export interface PullRequestReadiness {
	state: "ready" | "pending" | "blocked";
	reasons: PullRequestReadinessReason[];
	/** Health lookup time, independent of PR discovery, epoch milliseconds. Cached across restarts. */
	checkedAt: number;
}

export interface PullRequestReadinessReason {
	code:
		| "failing_checks"
		| "unresolved_comments"
		| "conflicts"
		| "draft"
		| "changes_requested"
		| "review_required"
		| "behind"
		| "merge_state"
		| "checks_pending"
		| "mergeability_unknown"
		| "readiness_unknown";
	names?: string[];
	count?: number;
	/** Raw GitHub review decision, merge state or diverged base branch. */
	value?: string;
}

export interface PullRequestStack {
	/** Stack number within the PR's repository. */
	number: number;
	/** One-based position, bottom to top. */
	position: number;
	size: number;
	/** Ultimate base of the stack, not this PR's immediate base. */
	baseBranch: string;
}

export interface PullRequestBindingResult {
	changed: boolean;
	previousOwner: { id: string; title: string } | null;
	taskLinkRemoved: boolean;
}
