import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { CoordinatorSkillResource } from "./coordinator-skill-resources.ts";

/** A fresh host-admitted scope of canonical roots for one finite native request, never a reusable capability. */
export interface CoordinatorSources {
	main: string;
	members: { sessionId: string; path: string }[];
	scratch: string;
}

export type ReadCoordinatorSources = (signal?: AbortSignal) => Promise<CoordinatorSources>;

/** Host-only resource metadata accompanies native admission, never the daemon's source IPC. */
export interface CoordinatorSourceAccess extends CoordinatorSources {
	skills: readonly CoordinatorSkillResource[];
}
export type ReadCoordinatorSourceAccess = (signal?: AbortSignal) => Promise<CoordinatorSourceAccess>;

/** Trusted extension bus only. Native codemode has no event-bus access. */
export const COORDINATOR_SOURCES_EVENT = "pilot:coordinator-sources";
export interface CoordinatorSourcesRequest {
	signal?: AbortSignal;
	result?: Promise<CoordinatorSourceAccess>;
}

/** Keep the IPC closure in the native host; the bundled TS extension receives only this trusted bus port. */
export function coordinatorSourceBridge(
	read: ReadCoordinatorSources,
	readSkills: () => readonly CoordinatorSkillResource[],
): ExtensionFactory {
	return (pi) => {
		let unsubscribe: (() => void) | undefined;
		pi.on("session_start", () => {
			unsubscribe = pi.events.on(COORDINATOR_SOURCES_EVENT, (value) => {
				const request = value as CoordinatorSourcesRequest;
				request.result = read(request.signal).then((scope) => ({ ...scope, skills: readSkills() }));
			});
		});
		pi.on("session_shutdown", () => {
			unsubscribe?.();
			unsubscribe = undefined;
		});
	};
}
