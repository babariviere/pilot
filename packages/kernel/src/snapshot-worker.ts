/** Lightweight one-shot reader. No native SDK, extension runtime, Harness, or writer lease. */
import { parentPort, workerData } from "node:worker_threads";
import { readSessionSnapshot, readSubagentTranscript } from "./snapshot.ts";

const { directory, cwd, includeTodos, subagentConversation, after } = workerData as {
	directory: string;
	cwd: string;
	includeTodos?: boolean;
	subagentConversation?: string;
	after?: number;
};
try {
	const view =
		subagentConversation === undefined
			? await readSessionSnapshot(directory, cwd, includeTodos)
			: await readSubagentTranscript(directory, subagentConversation, after);
	parentPort?.postMessage({ view, bytes: Buffer.byteLength(JSON.stringify(view)) });
} catch (error) {
	parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
} finally {
	parentPort?.close();
}
