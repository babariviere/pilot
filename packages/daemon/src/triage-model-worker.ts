import { parentPort, workerData } from "node:worker_threads";
import { observedBackgroundRuntime } from "./background-usage.ts";
import { ModelCatalog } from "./models.ts";

try {
	const catalog = new ModelCatalog(workerData.agentDir);
	if (workerData.captureUsage)
		catalog.setBackgroundUsage({
			runtime: (runtime) =>
				observedBackgroundRuntime(
					runtime,
					(usage) =>
						new Promise<void>((resolve) => {
							parentPort!.once("message", () => resolve());
							parentPort!.postMessage({ usage });
						}),
				),
		});
	const text = await catalog.completeTriage(
		workerData.cwd,
		workerData.prompt,
		workerData.schema,
		new AbortController().signal,
	);
	parentPort!.postMessage({ text });
} catch {
	parentPort!.postMessage({ error: true });
}
