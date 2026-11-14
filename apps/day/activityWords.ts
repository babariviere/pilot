// Words for how long Pilot's planning agent has worked and when it last
// saved a step, against this window's clock, so a cached page never shows
// an old "ago". Activity, not progress: a time is never an estimate.
import type { PlanActivity } from "pilot-day/native";

/** No saved step for this long while working reads as quiet. */
export const QUIET_MS = 5 * 60 * 1000;

/** A span in words, rounded down: "40 s", "12 min", "2 h 5 min". */
export function span(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s} s`;
	if (s < 3600) return `${Math.floor(s / 60)} min`;
	const h = Math.floor(s / 3600);
	const min = Math.floor((s % 3600) / 60);
	return min === 0 ? `${h} h` : `${h} h ${min} min`;
}

/** "Working for 4 min · last step 20 s ago", or the part Pilot knows. Empty while idle. */
export function activityTime(a: PlanActivity, now: number): string {
	if (!a.working) return "";
	const since = a.workingSince;
	const last = a.lastStepAt;
	if (since != null && last != null) return `Working for ${span(now - since)} · last step ${span(now - last)} ago`;
	if (since != null) return `Working for ${span(now - since)}`;
	if (last != null) return `Last step ${span(now - last)} ago`;
	return "";
}

/** What a long quiet while working can mean and what to do, or "". */
export function activityQuiet(a: PlanActivity, now: number): string {
	if (!a.working) return "";
	const at = a.lastStepAt ?? a.workingSince;
	if (at == null || now - at < QUIET_MS) return "";
	return `No new step for ${span(now - at)}. A long answer can take this long. Open the planning chat to see its last step.`;
}
