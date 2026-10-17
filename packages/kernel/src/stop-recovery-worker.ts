import { parentPort, workerData } from "node:worker_threads";
import { type RecoveryStop, stopRecoveryChildren } from "./stop-recovery.ts";

try {
	parentPort?.postMessage({ subagents: await stopRecoveryChildren(workerData as RecoveryStop) });
} catch (error) {
	parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
} finally {
	parentPort?.close();
}
