/** One-shot reader. No extension/agent initialization or writer lease; compaction metadata may load the SDK estimator. */
import { parentPort, workerData } from "node:worker_threads";
import { readEarlierEntries, readSessionSnapshot, readSubagentTranscript } from "./snapshot.ts";

const { directory, cwd, includeTodos, subagentConversation, after, earlier } = workerData as {
	directory: string;
	cwd: string;
	includeTodos?: boolean;
	subagentConversation?: string;
	after?: number;
	/** Read a page of entries hidden by compaction instead of the active view. */
	earlier?: { before: number; limit: number };
};
try {
	const view =
		earlier !== undefined
			? await readEarlierEntries(directory, earlier.before, earlier.limit)
			: subagentConversation === undefined
				? await readSessionSnapshot(directory, cwd, includeTodos)
				: await readSubagentTranscript(directory, subagentConversation, after);
	parentPort?.postMessage({ view, bytes: Buffer.byteLength(JSON.stringify(view)) });
} catch (error) {
	parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
} finally {
	parentPort?.close();
}
