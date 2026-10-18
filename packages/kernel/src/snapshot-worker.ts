/** One-shot reader. No extension/agent initialization or writer lease; compaction metadata may load the SDK estimator. */
import { parentPort, workerData } from "node:worker_threads";
import {
	readDiagnosticHistoryPage,
	readEarlierEntries,
	readSessionSnapshot,
	readSessionTodoCount,
	readSubagentTranscript,
} from "./snapshot.ts";

const {
	directory,
	cwd,
	includeTodos,
	subagentConversation,
	after,
	earlier,
	diagnosticHistory,
	todoCount,
	controlTurn,
} = workerData as {
	directory: string;
	cwd: string;
	includeTodos?: boolean;
	subagentConversation?: string;
	after?: number;
	/** Read a page of entries hidden by compaction instead of the active view. */
	earlier?: { before: number; limit: number };
	diagnosticHistory?: {
		target: import("@pilot/protocol").DiagnosticTargetReference;
		before?: number;
		limit: number;
	};
	todoCount?: boolean;
	controlTurn?: boolean;
};
try {
	const view = controlTurn
		? { turn: await (await import("./control-turn-origin.ts")).readControlTurnOrigin(directory) }
		: todoCount
			? { openCount: await readSessionTodoCount(directory) }
			: diagnosticHistory !== undefined
				? await readDiagnosticHistoryPage(
						directory,
						diagnosticHistory.target,
						diagnosticHistory.before,
						diagnosticHistory.limit,
					)
				: earlier !== undefined
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
