import type { SessionManagerOptions } from "../sessions/sessions.ts";

/** Synthetic workers do not imply account/config access. Fixtures select these services independently. */
export function offlineSessionOptions(options: SessionManagerOptions = {}): SessionManagerOptions {
	return {
		...options,
		subscriptionUsage: options.subscriptionUsage ?? false,
		workerUsageHistory: options.workerUsageHistory ?? false,
	};
}
