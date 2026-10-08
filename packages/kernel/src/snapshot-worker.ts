/** Lightweight one-shot reader. No native SDK, extension runtime, Harness, or writer lease. */
import { parentPort, workerData } from "node:worker_threads";
import { readSessionSnapshot, readSubagentSnapshot } from "./snapshot.ts";

const { directory, cwd, includeTodos, subagentConversation } = workerData as {
	directory: string;
	cwd: string;
	includeTodos?: boolean;
	subagentConversation?: string;
};
try {
	const view =
		subagentConversation === undefined
			? await readSessionSnapshot(directory, cwd, includeTodos)
			: { events: await readSubagentSnapshot(directory, subagentConversation) };
	parentPort?.postMessage({ view, bytes: Buffer.byteLength(JSON.stringify(view)) });
} catch (error) {
	parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
} finally {
	parentPort?.close();
}
