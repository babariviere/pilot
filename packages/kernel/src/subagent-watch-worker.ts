/**
 * Long-lived watcher for one subagent transcript. Polls only file metadata; on a change it reads just
 * the new entries in a short read transaction. Posts `{ full, events }` or `{ error }`.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { parentPort, workerData } from "node:worker_threads";
import { readSubagentTranscript } from "./snapshot.ts";
import { subagentStorageSignature } from "./subagent-watch.ts";

const { directory, conversationId, intervalMs } = workerData as {
	directory: string;
	conversationId: string;
	intervalMs?: number;
};
const interval = intervalMs ?? 250;
let signature: string | undefined;
let cursor: number | undefined;
let started = false;
let failures = 0;
for (;;) {
	// Read the signature first: a commit during the read changes it again and triggers another read.
	const next = subagentStorageSignature(directory);
	if (next !== signature) {
		try {
			const read = await readSubagentTranscript(directory, conversationId, started ? cursor : undefined);
			signature = next;
			started = true;
			failures = 0;
			cursor = read.cursor ?? (read.full ? undefined : cursor);
			if (read.full || read.events.length) parentPort?.postMessage({ full: read.full, events: read.events });
		} catch (error) {
			failures++;
			parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
			await sleep(Math.min(5_000, interval * 2 ** failures));
		}
	}
	await sleep(interval);
}
