import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/** A fresh host-admitted scope of canonical roots for one finite native request, never a reusable capability. */
export interface CoordinatorSources {
	main: string;
	members: { sessionId: string; path: string }[];
	scratch: string;
}

export type ReadCoordinatorSources = (signal?: AbortSignal) => Promise<CoordinatorSources>;

/** Trusted extension bus only. Native codemode has no event-bus access. */
export const COORDINATOR_SOURCES_EVENT = "pilot:coordinator-sources";
export interface CoordinatorSourcesRequest {
	signal?: AbortSignal;
	result?: Promise<CoordinatorSources>;
}

/** Keep the IPC closure in the native host; the bundled TS extension receives only this trusted bus port. */
export function coordinatorSourceBridge(read: ReadCoordinatorSources): ExtensionFactory {
	return (pi) => {
		let unsubscribe: (() => void) | undefined;
		pi.on("session_start", () => {
			unsubscribe = pi.events.on(COORDINATOR_SOURCES_EVENT, (value) => {
				const request = value as CoordinatorSourcesRequest;
				request.result = read(request.signal);
			});
		});
		pi.on("session_shutdown", () => {
			unsubscribe?.();
			unsubscribe = undefined;
		});
	};
}
