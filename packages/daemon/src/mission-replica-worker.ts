/**
 * Applies mission-store changesets to missions.sqlite off pilotd's event loop. pilotd keeps the store in memory and
 * ships each commit here; batches commit with synchronous=FULL, so a resolved durable() means on disk.
 */
import { constants, DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

/** [0]: last saved sequence number; [1]: 1 once the connection is closed or could not be opened. */
const { file, applied } = workerData as { file: string; applied: Int32Array };

function open(): DatabaseSync {
	const db = new DatabaseSync(file);
	try {
		// Changesets already contain the primary's trigger effects. SQLite applyChangeset also runs
		// destination triggers, so retaining these would double revisions/changefeed entries. Startup
		// migration reinstalls them before loading the next in-memory primary; only the disk mirror
		// drops them. This worker is never a canonical writer.
		for (const row of db
			.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'shared_%'")
			.all()) {
			db.exec(`DROP TRIGGER "${String(row.name).replaceAll('"', '""')}"`);
		}
		// pilotd's in-memory primary already enforced foreign keys; its changesets include cascaded changes.
		db.exec(
			"PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = OFF;",
		);
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

let db: DatabaseSync;
try {
	db = open();
} catch (error) {
	// close() may already be blocking pilotd's thread, which can't see the worker's error event. The file is
	// not held, so report it released and wake both waits rather than letting close() sit out its timeout.
	Atomics.store(applied, 1, 1);
	Atomics.notify(applied, 1);
	Atomics.notify(applied, 0);
	throw error;
}

const queue: { seq: number; changes: Uint8Array }[] = [];
let scheduled = false;
let retryMs = 0;

// The disk copy mirrors the primary, so a conflict means it drifted (or a batch is being retried): the primary wins.
function onConflict(type: number): number {
	if (type === constants.SQLITE_CHANGESET_DATA || type === constants.SQLITE_CHANGESET_CONFLICT)
		return constants.SQLITE_CHANGESET_REPLACE;
	if (type === constants.SQLITE_CHANGESET_NOTFOUND) return constants.SQLITE_CHANGESET_OMIT;
	return constants.SQLITE_CHANGESET_ABORT;
}

function drain(): void {
	scheduled = false;
	if (!queue.length) return;
	const batch = queue.slice();
	const seq = batch.at(-1)!.seq;
	try {
		db.exec("BEGIN IMMEDIATE");
		try {
			for (const { changes } of batch)
				if (!db.applyChangeset(changes, { onConflict })) throw new Error("changeset aborted by a constraint");
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
		queue.splice(0, batch.length);
		retryMs = 0;
		Atomics.store(applied, 0, seq);
		Atomics.notify(applied, 0);
		parentPort!.postMessage({ seq });
		schedule();
	} catch (error) {
		// Keep the batch and retry with backoff (a full disk can recover). pilotd fails waiting acknowledgements.
		retryMs = Math.min(30_000, Math.max(1_000, retryMs * 2));
		parentPort!.postMessage({ seq, error: error instanceof Error ? error.message : String(error) });
		setTimeout(schedule, retryMs);
	}
}

function schedule(): void {
	if (scheduled || !queue.length) return;
	scheduled = true;
	// Messages already delivered join this batch: one disk sync covers every commit made meanwhile.
	setImmediate(drain);
}

parentPort!.on("message", (message: { seq: number; changes: Uint8Array } | { close: true }) => {
	if ("close" in message) {
		// Everything acknowledged is saved; release the file for the next store before exiting.
		db.close();
		Atomics.store(applied, 1, 1);
		Atomics.notify(applied, 1);
		process.exit(0);
	}
	queue.push(message);
	if (!retryMs) schedule();
});
