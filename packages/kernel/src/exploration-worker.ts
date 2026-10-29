import { parentPort, workerData } from "node:worker_threads";
import type { CallPathQuery } from "./call-path-contract.ts";
import { scanCallPaths } from "./call-path-scan.ts";
import type { ExplorationQuery } from "./exploration-contract.ts";
import { scanSource } from "./exploration-scan.ts";
import type { AskContext } from "./policy.ts";

const controller = new AbortController();
parentPort!.on("message", () => controller.abort(new Error("Exploration cancelled")));
const { source, query } = workerData as { source: AskContext; query: ExplorationQuery | CallPathQuery };
try {
	const result =
		query.tool === "code_call_paths"
			? await scanCallPaths(source, query, controller.signal)
			: await scanSource(source, query, controller.signal);
	parentPort!.postMessage({ result });
} catch (error) {
	parentPort!.postMessage({ error: error instanceof Error ? error.message : "Exploration failed" });
} finally {
	parentPort!.close();
}
