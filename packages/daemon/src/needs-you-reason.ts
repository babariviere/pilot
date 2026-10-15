import type { NeedsYouReason, SessionPullRequest, SessionSummary } from "@pilot/protocol";

/** Bound diagnostics and questions before sending them to list surfaces. */
export function reasonLine(text: string | undefined): string | undefined {
	const line = text
		?.split(/\r?\n/)
		.find((candidate) => candidate.trim())
		?.trim();
	if (!line) return undefined;
	return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

export function sessionNeedsYouReason(session: SessionSummary, now = Date.now()): NeedsYouReason {
	if (session.attentionReason?.kind === "long_job") return session.attentionReason;
	if (session.outcome === "failed" || (!session.outcome && session.state === "failed")) {
		const limit = subscriptionLimit(session, now);
		if (limit) return { kind: "limit", ...(limit.resumesAt !== undefined ? { resumesAt: limit.resumesAt } : {}) };
		return {
			kind: "failed",
			detail: reasonLine(session.outcomeReason) ?? reasonLine(session.error) ?? "The chat failed",
		};
	}
	if (session.outcome === "question")
		return { kind: "asks", detail: reasonLine(session.outcomeReason) ?? "A question is waiting for your answer" };
	if (session.attentionReason) return session.attentionReason;
	return { kind: "not_reviewed" };
}

/** Health already cached for display, even when automatic follow-ups are unavailable. No new GitHub reads. */
export function stuckPullRequestReason(prs: SessionPullRequest[]): NeedsYouReason | undefined {
	let worst: { rank: number; detail: string } | undefined;
	for (const pr of prs) {
		if (pr.state !== "open" && pr.state !== "draft") continue;
		for (const reason of pr.readiness?.reasons ?? []) {
			let rank: number;
			let detail: string;
			switch (reason.code) {
				case "conflicts":
					rank = 0;
					detail = "merge conflicts";
					break;
				case "failing_checks":
					rank = 1;
					detail = "checks failing";
					break;
				case "behind":
					// BEHIND is branch protection, not evidence that a stacked head diverged.
					if (!reason.value || reason.value === "BEHIND") continue;
					rank = 2;
					detail = `diverged from ${reason.value}`;
					break;
				case "unresolved_comments":
					if (!reason.count || reason.count < 1) continue;
					rank = 3;
					detail = `${reason.count} review ${reason.count === 1 ? "thread" : "threads"}`;
					break;
				default:
					continue;
			}
			if (!worst || rank < worst.rank) worst = { rank, detail: `PR #${pr.number} · ${detail}` };
		}
	}
	return worst ? { kind: "pr_stuck", detail: reasonLine(worst.detail) } : undefined;
}

/** Provider errors that mean the account ran out of its subscription or rate allowance. */
const LIMIT_ERROR = /usage[ _-]?limit|rate[ _-]?limit|limit reached|quota|too many requests|\b429\b/i;

/**
 * Whether a failed chat was stopped by a subscription limit: its error reads as one, or its provider's cached
 * snapshot has a window used up that has not reset yet. Extra-usage spend is not a limit. Resumes when the
 * latest exhausted window resets.
 */
export function subscriptionLimit(session: SessionSummary, now = Date.now()): { resumesAt?: number } | undefined {
	const resets: number[] = [];
	let exhausted = false;
	for (const window of session.usage?.subscription?.windows ?? []) {
		if (window.label.startsWith("Extra") || !(window.usedPercent >= 100)) continue;
		const reset = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
		if (Number.isFinite(reset) && reset <= now) continue;
		exhausted = true;
		if (Number.isFinite(reset)) resets.push(reset);
	}
	if (!exhausted && !LIMIT_ERROR.test(`${session.outcomeReason ?? ""}\n${session.error ?? ""}`)) return undefined;
	return resets.length ? { resumesAt: Math.max(...resets) } : {};
}
