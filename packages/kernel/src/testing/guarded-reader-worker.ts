/** Test-only import boundary. Install before dynamically importing the real reader entry. */
import { registerHooks } from "node:module";
import { workerData } from "node:worker_threads";

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "@earendil-works/pi-coding-agent" || specifier.startsWith("@earendil-works/pi-coding-agent/"))
			throw new Error(`Cold reader eagerly loaded the coding SDK from ${context.parentURL}`);
		return next(specifier, context);
	},
});

await import(workerData.entry as string);
