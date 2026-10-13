import type { PullRequestReadiness, PullRequestReadinessReason } from "@pilot/protocol";
import type { PullRequestProblems } from "./github.ts";

/** Only explicit positive evidence yields ready. Missing/future server fields stay pending. */
export function mergeReadiness(
	pr: { state: unknown; isDraft?: unknown; mergeable?: unknown; reviewDecision?: unknown; mergeStateStatus?: unknown },
	problems: PullRequestProblems,
	pendingChecks: boolean,
	now = Date.now(),
): PullRequestReadiness | undefined {
	if (pr.state !== "OPEN") return undefined;
	const reasons: PullRequestReadinessReason[] = [];
	if (problems.failedChecks.length) reasons.push({ code: "failing_checks", names: problems.failedChecks });
	if (problems.reviewComments) reasons.push({ code: "unresolved_comments", count: problems.reviewComments });
	if (problems.mergeConflicts || pr.mergeable === "CONFLICTING") reasons.push({ code: "conflicts" });
	if (pr.isDraft === true || pr.mergeStateStatus === "DRAFT") reasons.push({ code: "draft" });
	if (pr.reviewDecision === "CHANGES_REQUESTED") reasons.push({ code: "changes_requested" });
	if (pr.reviewDecision === "REVIEW_REQUIRED") reasons.push({ code: "review_required" });
	if (problems.divergedFrom || pr.mergeStateStatus === "BEHIND")
		reasons.push({ code: "behind", value: problems.divergedFrom ?? "BEHIND" });
	if (["BLOCKED", "UNSTABLE", "DIRTY"].includes(String(pr.mergeStateStatus)))
		reasons.push({ code: "merge_state", value: String(pr.mergeStateStatus) });
	const blocked = reasons.length > 0;
	if (pendingChecks) reasons.push({ code: "checks_pending" });
	if (pr.mergeable !== "MERGEABLE" && pr.mergeable !== "CONFLICTING") reasons.push({ code: "mergeability_unknown" });
	if (
		typeof pr.isDraft !== "boolean" ||
		![null, "APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"].includes(pr.reviewDecision as string | null) ||
		!["CLEAN", "BEHIND", "BLOCKED", "UNSTABLE", "DIRTY", "DRAFT"].includes(String(pr.mergeStateStatus))
	)
		reasons.push({ code: "readiness_unknown" });
	return { state: blocked ? "blocked" : reasons.length ? "pending" : "ready", reasons, checkedAt: now };
}

export function readinessReasonLabel(reason: PullRequestReadinessReason): string {
	switch (reason.code) {
		case "failing_checks":
			return `Failing checks: ${reason.names?.join(", ") ?? "unknown"}`;
		case "unresolved_comments":
			return `${reason.count ?? 0} unresolved review threads`;
		case "conflicts":
			return "Merge conflicts";
		case "draft":
			return "Draft";
		case "changes_requested":
			return "Changes requested";
		case "review_required":
			return "Review required";
		case "behind":
			return reason.value === "BEHIND" ? "Behind base branch" : `Behind ${reason.value}`;
		case "merge_state":
			return `Merge blocked: ${reason.value}`;
		case "checks_pending":
			return "Checks pending";
		case "mergeability_unknown":
			return "Mergeability unknown";
		case "readiness_unknown":
			return "Readiness unknown";
	}
	// A downgraded daemon can read cached reason codes written by a newer version.
	return "Readiness unknown";
}
