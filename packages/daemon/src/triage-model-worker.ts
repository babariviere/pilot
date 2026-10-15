import { parentPort, workerData } from "node:worker_threads";
import { ModelCatalog } from "./models.ts";
try {
	const text = await new ModelCatalog(workerData.agentDir).completeTriage(
		workerData.cwd,
		workerData.prompt,
		workerData.schema,
		new AbortController().signal,
	);
	parentPort!.postMessage({ text });
} catch {
	parentPort!.postMessage({ error: true });
}
