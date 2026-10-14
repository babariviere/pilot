import type { NeedsYouReason, SessionSummary } from "@pilot/protocol";

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
	if (session.attentionReason) return session.attentionReason;
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
	return { kind: "not_reviewed" };
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
