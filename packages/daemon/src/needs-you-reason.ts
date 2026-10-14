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

export function sessionNeedsYouReason(session: SessionSummary): NeedsYouReason {
	if (session.outcome === "failed" || (!session.outcome && session.state === "failed"))
		return {
			kind: "failed",
			detail: reasonLine(session.outcomeReason) ?? reasonLine(session.error) ?? "The chat failed",
		};
	if (session.outcome === "question")
		return { kind: "asks", detail: reasonLine(session.outcomeReason) ?? "A question is waiting for your answer" };
	return { kind: "not_reviewed" };
}
