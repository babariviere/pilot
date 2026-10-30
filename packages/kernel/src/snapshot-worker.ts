/** One-shot reader. No extension/agent initialization or writer lease; compaction metadata may load the SDK estimator. */
import { parentPort, workerData } from "node:worker_threads";
import {
	readDiagnosticHistoryPage,
	readEarlierEntries,
	readSessionSnapshot,
	readSessionTodoCount,
	readSubagentTranscript,
} from "./snapshot.ts";

const { directory, cwd, includeTodos, subagentConversation, after, earlier, diagnosticHistory, todoCount, recent } =
	workerData as {
		directory: string;
		cwd: string;
		includeTodos?: boolean;
		recent?: boolean;
		subagentConversation?: string;
		after?: number;
		/** Read a page of entries hidden by compaction instead of the active view. */
		earlier?: { before: number; limit: number; view?: import("@pilot/protocol").TranscriptContext };
		diagnosticHistory?: {
			target: import("@pilot/protocol").DiagnosticTargetReference;
			before?: number;
			limit: number;
		};
		todoCount?: boolean;
	};
try {
	const view = todoCount
		? { openCount: await readSessionTodoCount(directory) }
		: diagnosticHistory !== undefined
			? await readDiagnosticHistoryPage(
					directory,
					diagnosticHistory.target,
					diagnosticHistory.before,
					diagnosticHistory.limit,
				)
			: earlier !== undefined
				? await readEarlierEntries(directory, earlier.before, earlier.limit, earlier.view)
				: subagentConversation === undefined
					? await readSessionSnapshot(directory, cwd, includeTodos, recent)
					: await readSubagentTranscript(directory, subagentConversation, after);
	parentPort?.postMessage({ view, bytes: Buffer.byteLength(JSON.stringify(view)) });
} catch (error) {
	parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
} finally {
	parentPort?.close();
}
