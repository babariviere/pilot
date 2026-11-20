import type { CompactionFailure, CompactionStatus } from "@earendil-works/pi-durable";

/** Keep Pilot's existing wire field while Durable names the cause `trigger`. */
export function wireCompactions(statuses: readonly CompactionStatus[] = []) {
	return statuses.map(({ trigger, ...status }) => ({ ...status, reason: trigger }));
}

export function wireCompactionFailure({ trigger, ...failure }: CompactionFailure) {
	return { ...failure, reason: trigger };
}
