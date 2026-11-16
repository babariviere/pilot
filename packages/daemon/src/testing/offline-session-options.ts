import type { SessionManagerOptions } from "../sessions.ts";

/** Synthetic workers do not imply account/config access. Fixtures select these services independently. */
export function offlineSessionOptions(options: SessionManagerOptions = {}): SessionManagerOptions {
	return {
		...options,
		databases: options.databases ?? false,
		subscriptionUsage: options.subscriptionUsage ?? false,
		workerUsageHistory: options.workerUsageHistory ?? false,
	};
}
