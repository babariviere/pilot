/** App-owned retained bytes and FULL SQLite commits, off the daemon event loop. */
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { bindingRecord, changeIdPattern, exact, identifier, repositoryIdPattern } from "./jj-ownership-contract.ts";
import { captureReview, snapshotHash } from "./review-snapshot-capture.ts";
import {
	captureRequest,
	REVIEW_SNAPSHOT_LIMITS,
	type ReviewCaptureRequest,
	type ReviewSnapshot,
	type ReviewSnapshotManifest,
	type ReviewSourceRef,
	reviewPath,
	snapshotManifest,
} from "./review-snapshot-contract.ts";

const directory = dirname(workerData.file);
const firstCreated = mkdirSync(directory, { recursive: true, mode: 0o700 });
if (realpathSync(directory) !== directory || !lstatSync(directory).isDirectory() || lstatSync(directory).mode & 0o077)
	throw new Error("Snapshot store needs a canonical private directory");
try {
	if (!lstatSync(workerData.file).isFile() || lstatSync(workerData.file).isSymbolicLink())
		throw new Error("Unsafe snapshot database");
} catch (error) {
	if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const db = new DatabaseSync(workerData.file);
chmodSync(workerData.file, 0o600);
const pageBytes = Number(db.prepare("PRAGMA page_size").get()!.page_size);
db.exec(`PRAGMA max_page_count=${Math.floor(REVIEW_SNAPSHOT_LIMITS.storeBytes / pageBytes)}`);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
 CREATE TABLE IF NOT EXISTS review_snapshot_meta(version INTEGER NOT NULL);
 INSERT INTO review_snapshot_meta SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM review_snapshot_meta);`);
if (db.prepare("SELECT version FROM review_snapshot_meta").get()?.version !== 1)
	throw new Error("Unsupported snapshot store version");
db.exec(`CREATE TABLE IF NOT EXISTS captures(
 request_id TEXT PRIMARY KEY, request TEXT NOT NULL, provenance TEXT NOT NULL, snapshot_id TEXT);
 CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY, manifest TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS snapshots_by_custody ON snapshots(json_extract(manifest,'$.request.repositoryId'),json_extract(manifest,'$.provenance.ledger.ownership.binding.sessionId'),json_extract(manifest,'$.provenance.ledger.ownership.binding.missionId'));
 CREATE TABLE IF NOT EXISTS snapshot_bytes(snapshot_id TEXT NOT NULL, sha256 TEXT NOT NULL, bytes BLOB NOT NULL,
 PRIMARY KEY(snapshot_id,sha256));`);
// The first ACK also needs the newly created database's directory entry durable.
for (let path = directory; ; path = dirname(path)) {
	const dir = openSync(path, "r");
	try {
		fsyncSync(dir);
	} finally {
		closeSync(dir);
	}
	if (!firstCreated || path === dirname(firstCreated)) break;
}

function transact<T>(action: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = action();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}
function get(id: unknown): ReviewSnapshot {
	identifier(id, repositoryIdPattern);
	const size = db.prepare("SELECT length(CAST(manifest AS BLOB)) AS bytes FROM snapshots WHERE id=?").get(id);
	if (!size || Number(size.bytes) > 8 * 1024 * 1024) throw new Error("Missing or oversized review manifest");
	const row = db.prepare("SELECT manifest FROM snapshots WHERE id=?").get(id);
	if (!row) throw new Error("Unknown review snapshot");
	const json = String(row.manifest);
	if (snapshotHash(json) !== id) throw new Error("Corrupt review manifest");
	const manifest: unknown = JSON.parse(json);
	snapshotManifest(manifest);
	return { snapshotId: id, manifest };
}
function lookup(request: ReviewCaptureRequest) {
	const row = db.prepare("SELECT * FROM captures WHERE request_id=?").get(request.requestId);
	if (!row) return { status: "absent" as const };
	if (row.request !== JSON.stringify(request)) throw new Error("Snapshot request identity conflict");
	return row.snapshot_id
		? { status: "done" as const, snapshot: get(row.snapshot_id) }
		: { status: "interrupted" as const };
}
function bytes(snapshotId: string, sha256: string, expected: number): Uint8Array {
	identifier(sha256, repositoryIdPattern);
	const size = db
		.prepare("SELECT length(bytes) AS size FROM snapshot_bytes WHERE snapshot_id=? AND sha256=?")
		.get(snapshotId, sha256);
	if (!size || size.size !== expected || expected > REVIEW_SNAPSHOT_LIMITS.diffBytes)
		throw new Error("Missing or corrupt retained size");
	const row = db.prepare("SELECT bytes FROM snapshot_bytes WHERE snapshot_id=? AND sha256=?").get(snapshotId, sha256);
	if (!row || !(row.bytes instanceof Uint8Array) || snapshotHash(row.bytes) !== sha256)
		throw new Error("Missing or corrupt retained source");
	return row.bytes;
}

let capturing = false;
const controllers = new Map<number, AbortController>();
async function dispatch(id: number, method: string, args: Record<string, unknown>): Promise<unknown> {
	if (method === "get") return get(args.snapshotId);
	if (method === "list") {
		exact(args, ["binding", "after"]);
		bindingRecord(args.binding);
		if (!Number.isSafeInteger(args.after) || Number(args.after) < 0) throw new Error("Invalid comparison cursor");
		const b = args.binding;
		const rows = db
			.prepare(`SELECT rowid,id FROM snapshots WHERE rowid>?
		 AND json_extract(manifest,'$.request.repositoryId')=?
		 AND json_extract(manifest,'$.provenance.ledger.ownership.binding.sessionId')=?
		 AND json_extract(manifest,'$.provenance.ledger.ownership.binding.missionId')=? ORDER BY rowid LIMIT 21`)
			.all(Number(args.after), b.repositoryId, b.sessionId, b.missionId);
		const comparisons = rows.slice(0, 20).map((row) => {
			const s = get(row.id),
				m = s.manifest;
			if (
				JSON.stringify(
					m.provenance.ledger.ownership.status === "owned" && m.provenance.ledger.ownership.binding,
				) !== JSON.stringify(b)
			)
				throw new Error("Snapshot custody changed");
			return {
				snapshotId: s.snapshotId,
				sequence: Number(row.rowid),
				capturedAt: m.provenance.capturedAt,
				request: m.request,
				status: m.status,
			};
		});
		return { comparisons, next: rows.length > 20 ? comparisons.at(-1)!.sequence : null };
	}
	if (method === "lookup") return lookup(captureRequest(args.request));
	if (method === "read") {
		const snapshot = get(args.snapshotId),
			ref = args.ref as ReviewSourceRef;
		exact(ref, ["snapshotId", "side", "path", "sha256"]);
		if (!ref || ref.snapshotId !== snapshot.snapshotId || !["before", "after"].includes(ref.side))
			throw new Error("Cross-source review reference");
		reviewPath(ref.path);
		const entry = snapshot.manifest[ref.side].find((e) => e.path === ref.path);
		if (!entry?.sha256 || entry.sha256 !== ref.sha256 || entry.state === "unavailable")
			throw new Error("Invalid or unavailable review source reference");
		return bytes(snapshot.snapshotId, ref.sha256, entry.bytes!);
	}
	if (method === "diff") {
		const snapshot = get(args.snapshotId);
		if (!snapshot.manifest.diff) throw new Error("Review diff unavailable");
		return bytes(snapshot.snapshotId, snapshot.manifest.diff.sha256, snapshot.manifest.diff.bytes);
	}
	if (method === "capture") {
		if (capturing) throw new Error("Snapshot capture busy");
		capturing = true;
		const controller = new AbortController();
		controllers.set(id, controller);
		const timer = setTimeout(
			() => controller.abort(new Error("Snapshot capture timed out")),
			REVIEW_SNAPSHOT_LIMITS.durationMs,
		);
		try {
			const request = captureRequest(args.request);
			const prior = lookup(request);
			if (prior.status === "done") return prior.snapshot;
			if (prior.status === "absent") {
				if (
					Number(db.prepare("SELECT count(*) AS count FROM captures").get()!.count) >=
					REVIEW_SNAPSHOT_LIMITS.requests
				)
					throw new Error("Snapshot request quota reached");
				const provenance = args.provenance as ReviewSnapshotManifest["provenance"];
				const ledger = provenance?.ledger;
				if (
					ledger?.ownership.status !== "owned" ||
					ledger.repositoryId !== request.repositoryId ||
					ledger.changeId !== request.changeId ||
					provenance.taskAttribution !== "unknown" ||
					!Number.isSafeInteger(provenance.capturedAt)
				)
					throw new Error("Invalid capture provenance");
				bindingRecord(ledger.ownership.binding);
				identifier(ledger.changeId, changeIdPattern);
				transact(() =>
					db
						.prepare("INSERT INTO captures VALUES(?,?,?,NULL)")
						.run(request.requestId, JSON.stringify(request), JSON.stringify(provenance)),
				);
			}
			const row = db.prepare("SELECT provenance FROM captures WHERE request_id=?").get(request.requestId)!;
			const provenance = JSON.parse(String(row.provenance)) as ReviewSnapshotManifest["provenance"];
			const captured = await captureReview(request, provenance, controller.signal);
			controller.signal.throwIfAborted();
			return transact(() => {
				const existing = lookup(request);
				if (existing.status === "done") return existing.snapshot;
				const json = JSON.stringify(captured.manifest),
					snapshotId = snapshotHash(json);
				db.prepare("INSERT OR IGNORE INTO snapshots VALUES(?,?)").run(snapshotId, json);
				const insert = db.prepare("INSERT OR IGNORE INTO snapshot_bytes VALUES(?,?,?)");
				for (const data of captured.content.values()) insert.run(snapshotId, snapshotHash(data), data);
				db.prepare("UPDATE captures SET snapshot_id=? WHERE request_id=?").run(snapshotId, request.requestId);
				return { snapshotId, manifest: captured.manifest };
			});
		} catch (error) {
			controller.signal.throwIfAborted();
			throw error;
		} finally {
			clearTimeout(timer);
			controllers.delete(id);
			capturing = false;
		}
	}
	if (method === "close") {
		if (capturing) throw new Error("Snapshot capture still active");
		db.close();
		return null;
	}
	throw new Error("Unknown snapshot method");
}

parentPort!.on("message", (message) => {
	if (message.cancel !== undefined) {
		controllers.get(message.cancel)?.abort(new Error("Snapshot capture cancelled"));
		return;
	}
	const { id, method, args } = message;
	void dispatch(id, method, args).then(
		(value) => parentPort!.postMessage({ id, value }),
		(error) => parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) }),
	);
});
