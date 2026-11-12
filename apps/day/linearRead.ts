// The canonical wire leaf has no Node or SDK imports. No second source store.

import { call, type Reply } from "./bridge";
import type { LinearCycleSummary, SavedLinearRead, TrackedItem } from "./linearContract";

export type { LinearCycleSummary, SavedLinearRead, TrackedItem };

/** Read the native root's selected project's saved own issues and last cycle summary. */
export function readSavedLinear(window: string): Promise<Reply<SavedLinearRead>> {
	return call<SavedLinearRead>(window, "day.linear.read", {});
}
