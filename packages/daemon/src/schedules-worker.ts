/** SQLite and fsync run off pilotd's event loop. pilotd is the sole store owner. */
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import type { ScheduledItem } from "@pilot/protocol";

mkdirSync(dirname(workerData.file), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(workerData.file);
if (workerData.file !== ":memory:") chmodSync(workerData.file, 0o600);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL, item TEXT NOT NULL);`);
const list = () =>
	db
		.prepare("SELECT item FROM schedules ORDER BY rowid")
		.all()
		.map((row) => JSON.parse(row.item as string) as ScheduledItem);
parentPort!.on("message", ({ id, method, item, expected, now }) => {
	try {
		let value: unknown;
		if (method === "snapshot") {
			const rows = list().filter((row) => !expected.projectId || row.projectId === expected.projectId);
			value = JSON.stringify(expected.ws ? { type: "schedules", schedules: rows } : rows);
		} else if (method === "load") {
			// An interrupted claim is never replayed: dispatch may already have produced an effect.
			db.exec("BEGIN IMMEDIATE");
			try {
				for (const row of list()) {
					// Decode old triggers only at the storage boundary. Never turn them into live work.
					const removed = ["on_join_network", "on_leave_network"].includes(String(row.trigger));
					const interrupted = !removed && row.state === "dispatching";
					const legacyWake = row.state === "pending" && row.wakeObserved && !row.sleepObserved;
					if (legacyWake) delete row.wakeObserved;
					if (removed) {
						row.trigger = "removed";
						row.state = "cancelled";
						row.error = "Wi-Fi triggers were removed";
						row.updatedAt = now;
						delete (row as ScheduledItem & { networkNames?: unknown }).networkNames;
						delete row.sleepObserved;
						delete row.wakeObserved;
					}
					if (interrupted) {
						row.state = "failed";
						row.error =
							"Dispatch interrupted by restart; delivery is uncertain. Check the chats before rescheduling.";
						row.updatedAt = now;
					}
					if (removed || legacyWake || interrupted) {
						row.revision++;
						db.prepare("UPDATE schedules SET revision=?,state=?,item=? WHERE id=?").run(
							row.revision,
							row.state,
							JSON.stringify(row),
							row.id,
						);
					}
				}
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
			value = list();
		} else if (method === "create") {
			if ((db.prepare("SELECT COUNT(*) AS n FROM schedules").get()!.n as number) >= 1000)
				throw new Error("Schedule limit reached (1000). Delete old items first.");
			const bytes = db
				.prepare("SELECT COALESCE(SUM(length(CAST(json_extract(item, '$.target') AS BLOB))),0) AS n FROM schedules")
				.get()!.n as number;
			if (bytes + Buffer.byteLength(JSON.stringify(item.target)) > 4 * 1024 * 1024)
				throw new Error("Schedule payload limit reached (4 MiB). Delete old items first.");
			db.prepare("INSERT INTO schedules VALUES (?,?,?,?)").run(
				item.id,
				item.revision,
				item.state,
				JSON.stringify(item),
			);
			value = item;
		} else if (method === "replace" || method === "remove") {
			if (method === "replace" && JSON.stringify(item.target) !== JSON.stringify(expected.target)) {
				const bytes = db
					.prepare(
						"SELECT COALESCE(SUM(length(CAST(json_extract(item, '$.target') AS BLOB))),0) AS n FROM schedules WHERE id != ?",
					)
					.get(item.id)!.n as number;
				if (bytes + Buffer.byteLength(JSON.stringify(item.target)) > 4 * 1024 * 1024)
					throw new Error("Schedule payload limit reached (4 MiB). Delete old items first.");
			}
			const result =
				method === "replace"
					? db
							.prepare("UPDATE schedules SET revision=?,state=?,item=? WHERE id=? AND revision=? AND state=?")
							.run(item.revision, item.state, JSON.stringify(item), item.id, expected.revision, expected.state)
					: db
							.prepare("DELETE FROM schedules WHERE id=? AND revision=? AND state=?")
							.run(item.id, expected.revision, expected.state);
			if (!result.changes) {
				const exists = db.prepare("SELECT id FROM schedules WHERE id=?").get(item.id);
				parentPort!.postMessage({
					id,
					error: exists ? "Schedule changed; reload before editing" : "Unknown schedule",
					kind: exists ? "conflict" : "not_found",
				});
				return;
			}
			value = method === "remove" ? undefined : item;
		} else if (method === "close") {
			db.close();
		} else throw new Error("Unknown schedule operation");
		parentPort!.postMessage({ id, value });
	} catch (error) {
		parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
	}
});
