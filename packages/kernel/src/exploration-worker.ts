import { parentPort, workerData } from "node:worker_threads";
import type { ExplorationQuery } from "./exploration-contract.ts";
import { scanSource } from "./exploration-scan.ts";
import type { AskContext } from "./policy.ts";

const controller = new AbortController();
parentPort!.on("message", () => controller.abort(new Error("Exploration cancelled")));
const { source, query } = workerData as { source: AskContext; query: ExplorationQuery };
try {
	const result = await scanSource(source, query, controller.signal);
	parentPort!.postMessage({ result });
} catch (error) {
	parentPort!.postMessage({ error: error instanceof Error ? error.message : "Exploration failed" });
} finally {
	parentPort!.close();
}
