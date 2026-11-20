/** Discovery reads and parsing, off pilotd's event loop. Never executes anything. */
import { parentPort } from "node:worker_threads";
import { readDiscoveryFiles, resolveDiscovery } from "./environment-discovery.ts";

parentPort?.on("message", (message: { id: number; projectId: string; root: string }) => {
	try {
		const result = resolveDiscovery(message.projectId, readDiscoveryFiles(message.root));
		parentPort?.postMessage({ id: message.id, result });
	} catch (error) {
		parentPort?.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
	}
});
