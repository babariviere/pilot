/** One bounded, cancellable capture worker. No author session, SDK, tools or live path resolution. */
import { parentPort, workerData } from "node:worker_threads";
import type { ReviewHistoryExport } from "@pilot/kernel/review-history";
import { exportCommittedHistory, REVIEW_HISTORY_LIMITS } from "@pilot/kernel/review-history";
import type { SessionHistorySelection } from "./critical-review-session.ts";

const { sources, budget } = workerData as {
	sources: SessionHistorySelection[];
	budget: { bytes: number; records: number; reads: number; durationMs: number };
};
const started = performance.now();
const exports: ReviewHistoryExport[] = [];
let bytes = budget.bytes,
	records = budget.records,
	reads = budget.reads;
for (const source of sources) {
	const durationMs = Math.floor(budget.durationMs - (performance.now() - started));
	if (bytes < 1024 || records < 1 || reads < 1 || durationMs < 1) {
		exports.push({
			pin: source.pin,
			status: "unavailable",
			entries: 0,
			conversations: [],
			chunks: [],
			bytes: 0,
			rawBytes: 0,
			records: 0,
			reads: 0,
			disclosures: [{ code: "capture_limit", count: 1, entryIds: [] }],
		});
		continue;
	}
	const result = exportCommittedHistory(source.directory, source.pin, {
		bytes,
		records,
		reads,
		durationMs: Math.min(REVIEW_HISTORY_LIMITS.durationMs, durationMs),
	});
	exports.push(result);
	bytes -= Math.max(result.bytes, result.rawBytes);
	records -= result.records;
	reads -= result.reads;
}
parentPort!.postMessage(exports);
