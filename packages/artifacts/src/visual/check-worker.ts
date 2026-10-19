/** Runs the visual pre-check off the kernel's event loop. The parent terminates this worker on timeout or abort. */
import { parentPort, workerData } from "node:worker_threads";
import { runVisualCheck, type VisualCheckInput } from "./check.ts";

try {
	parentPort?.postMessage(await runVisualCheck(workerData as VisualCheckInput));
} catch (error) {
	parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error), logs: [] });
}
