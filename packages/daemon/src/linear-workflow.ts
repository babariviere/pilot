import type { LinearWorkflowState, TrackingJson } from "@pilot/protocol";
import { LookupFormatChanged } from "./tracking-lookup.ts";

/** Share parsing between the settings lookup and the last live check before a start. */
export function startedWorkflowStates(response: TrackingJson): LinearWorkflowState[] {
	const states = Array.isArray(response)
		? response
		: response && typeof response === "object"
			? response.statuses
			: undefined;
	if (!Array.isArray(states) || states.length > 500) throw new LookupFormatChanged();
	const result: LinearWorkflowState[] = [];
	for (const state of states) {
		if (!state || typeof state !== "object" || Array.isArray(state)) throw new LookupFormatChanged();
		if (state.type !== "started") continue;
		const { id, name } = state;
		if (
			typeof id !== "string" ||
			!id.trim() ||
			id.length > 200 ||
			typeof name !== "string" ||
			!name.trim() ||
			name.length > 200
		)
			throw new LookupFormatChanged();
		if (result.some((existing) => existing.id === id)) throw new LookupFormatChanged();
		result.push({ id, name });
	}
	return result.sort((a, b) => a.name.localeCompare(b.name));
}
