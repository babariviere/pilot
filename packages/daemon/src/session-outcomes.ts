import type { SessionCompletion, SessionOutcome } from "@pilot/protocol";

export interface OutcomeMeta {
	/** Last known activity, so interrupted work can resume after a restart. */
	working?: boolean;
	outcome?: SessionOutcome;
	outcomeAt?: number;
	outcomeReason?: string;
	/** Retained while working, so replays cannot resurrect an old completion. */
	lastCompletionAt?: number;
	/** High-water mark also includes daemon failures, whose clock is independent of the kernel. */
	lastOutcomeAt?: number;
}

/** Normalize old persisted attention without changing its completion/replay versions. */
export function normalizeLegacyOutcome(meta: { outcome?: string; outcomeReason?: string }): void {
	if (meta.outcome !== "needs_input") return;
	meta.outcome = "done";
	delete meta.outcomeReason;
}

/** Apply kernel activity without guessing a completion from an idle transition. */
export function applyActivity(meta: OutcomeMeta, working: boolean, completion?: SessionCompletion): boolean {
	let changed = meta.working !== working;
	meta.working = working;
	const last = Math.max(meta.lastOutcomeAt ?? -1, meta.outcomeAt ?? -1);
	const lastCompletion = meta.lastCompletionAt ?? meta.outcomeAt ?? -1;
	if (working) {
		if (meta.outcomeAt !== undefined) {
			meta.lastOutcomeAt = last;
			meta.lastCompletionAt ??= meta.outcomeAt;
		}
		changed ||= meta.outcome !== undefined || meta.outcomeAt !== undefined || meta.outcomeReason !== undefined;
		delete meta.outcome;
		delete meta.outcomeAt;
		delete meta.outcomeReason;
	} else if (completion && completion.outcomeAt > lastCompletion) {
		// Cold views (or an older worker) can still contain the retired persisted outcome.
		completion = { ...completion };
		normalizeLegacyOutcome(completion);
		meta.outcome = completion.outcome;
		// Keep client attention versions monotonic across the independent kernel and daemon clocks.
		meta.outcomeAt = Math.max(completion.outcomeAt, last + 1);
		meta.lastOutcomeAt = meta.outcomeAt;
		meta.lastCompletionAt = completion.outcomeAt;
		if (completion.outcomeReason !== undefined) meta.outcomeReason = completion.outcomeReason;
		else delete meta.outcomeReason;
		changed = true;
	}
	return changed;
}

/** Daemon-generated failures get a version newer than any completion we have observed. */
export function applyFailure(meta: OutcomeMeta, reason: string, now: number): boolean {
	if (meta.outcome === "failed" && meta.outcomeReason === reason && !meta.working) return false;
	meta.lastCompletionAt ??= meta.outcomeAt ?? -1;
	meta.working = false;
	meta.outcome = "failed";
	meta.outcomeAt = Math.max(now, Math.max(meta.lastOutcomeAt ?? -1, meta.outcomeAt ?? -1) + 1);
	meta.lastOutcomeAt = meta.outcomeAt;
	meta.outcomeReason = reason;
	return true;
}
