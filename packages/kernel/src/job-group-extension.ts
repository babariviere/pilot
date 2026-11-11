/** Keep the pinned provider's storage, notifications and tools; add only owned-group supervision. */
import { fileURLToPath, pathToFileURL } from "node:url";
import { PILOT_PROFILE_PATH } from "@babariviere/pi-extensions/profile";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function ownedJobs(pi: ExtensionAPI): Promise<void> {
	// Use the normal trusted TS loader, without importing the dependency's
	// non-erasable implementation into Pilot's TypeScript compilation unit.
	const path = fileURLToPath(new URL("../extensions/jobs/index.ts", pathToFileURL(PILOT_PROFILE_PATH)));
	const { default: jobs } = await import(path);
	jobs({
		...pi,
		events: {
			...pi.events,
			emit(name: string, value: unknown) {
				pi.events.emit(name, value);
				if (name !== "sandbox:wrap-command") return;
				const request = value as { result?: Promise<string> };
				if (!request.result) return; // Preserve the provider's missing-sandbox refusal.
				request.result = request.result.then((command) => {
					const wrapped: { command: string; result?: Promise<string> } = { command };
					pi.events.emit("pilot:job-group:wrap", wrapped);
					return wrapped.result ?? Promise.reject(new Error("Owned job-group runtime is unavailable"));
				});
			},
		},
	});
}
