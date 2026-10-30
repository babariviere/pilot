import type { ConnectivityService } from "./connectivity.ts";
import type { ScheduleStore } from "./schedule-store.ts";
import type { ScheduleService } from "./schedules.ts";
import type { SystemEventsDetection } from "./system-events-detection.ts";

/** The daemon owns these resources; failed producer stops must not close their store. */
export async function shutdownSchedules(
	resources: {
		schedules: Pick<ScheduleService, "stop">;
		connectivity: Pick<ConnectivityService, "stop">;
		systemEvents?: Pick<SystemEventsDetection, "stop">;
		store: Pick<ScheduleStore, "close">;
	},
	drainRemaining: () => Promise<void>,
): Promise<void> {
	await resources.schedules.stop();
	await resources.connectivity.stop();
	resources.systemEvents?.stop();
	// ScheduleStore.close awaits worker termination even if its final RPC fails.
	// Only that terminal failure may cross into the otherwise unchanged drain.
	const failures: unknown[] = [];
	try {
		await resources.store.close();
	} catch (error) {
		failures.push(error);
	}
	try {
		await drainRemaining();
	} catch (error) {
		failures.push(error);
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, "Schedule store close and remaining shutdown failed");
}
