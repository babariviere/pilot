/** Lightweight one-shot reader. No native SDK, extension runtime, Harness, or writer lease. */
import { parentPort, workerData } from "node:worker_threads";
import { readSessionSnapshot } from "./snapshot.ts";

const { directory, cwd } = workerData as { directory: string; cwd: string };
try {
	const view = await readSessionSnapshot(directory, cwd);
	parentPort?.postMessage({ view, bytes: Buffer.byteLength(JSON.stringify(view)) });
} catch (error) {
	parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
} finally {
	parentPort?.close();
}
