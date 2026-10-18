/** All watch SQLite work, including startup and indexed matching, stays off the daemon loop. */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import type { WatchNotice, WatchObservation, WatchTransition } from "./watch-delivery.ts";
import { WatchEventsDisk } from "./watch-events-disk.ts";
import { MAX_WATCHES, validateWatch, type Watch, type WatchInput } from "./watches.ts";

const { path } = workerData as { path: string };
if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(path);
db.exec(`
 PRAGMA journal_mode=WAL;
 PRAGMA synchronous=FULL;
 PRAGMA max_page_count=32768;
 PRAGMA journal_size_limit=4194304;
 CREATE TABLE IF NOT EXISTS watches (
 id TEXT PRIMARY KEY, event TEXT NOT NULL, target_kind TEXT NOT NULL,
 target_id TEXT NOT NULL, target_scope TEXT NOT NULL, data TEXT NOT NULL, expires_at INTEGER
 );
 CREATE INDEX IF NOT EXISTS watches_match ON watches(event, target_kind, target_id, target_scope);
 CREATE INDEX IF NOT EXISTS watches_expiry ON watches(expires_at) WHERE expires_at IS NOT NULL;
`);
const events = new WatchEventsDisk(db);
function prune(now: number): void {
	db.prepare("DELETE FROM watches WHERE expires_at <= ?").run(now);
}
function list(now: number): Watch[] {
	prune(now);
	return db
		.prepare("SELECT data FROM watches ORDER BY rowid")
		.all()
		.map((row) => JSON.parse(String(row.data)));
}
function dispatch(op: string, args: unknown): unknown {
	const now = Date.now();
	if (op === "self") return events.setControl(String(args));
	if (op === "expiry") {
		prune(now);
		const row = db.prepare("SELECT MIN(expires_at) AS at FROM watches WHERE expires_at IS NOT NULL").get();
		return row?.at ?? undefined;
	}
	if (op === "cursor") return events.cursor(String(args));
	if (op === "consume") {
		const a = args as { source: string; events: WatchObservation[]; self?: string };
		return events.consume(a.source, a.events, a.self);
	}
	if (op === "targets") {
		prune(now);
		return db
			.prepare("SELECT DISTINCT target_id, target_scope FROM watches WHERE target_kind=?")
			.all(String(args))
			.map((row) => ({
				kind: String(args),
				id: String(row.target_id),
				...(row.target_scope ? { missionId: String(row.target_scope) } : {}),
			}));
	}
	if (op === "transition") {
		const a = args as { input: WatchTransition; self?: string };
		return events.transition(a.input, a.self);
	}
	if (op === "attribute") {
		const a = args as { sessionId: string; origin: string };
		return events.attributeSessionRun(a.sessionId, a.origin);
	}
	if (op === "observe") {
		const input = args as { events: WatchObservation[]; self?: string };
		return events.observe(input.events, input.self);
	}
	if (op === "activity") {
		const a = args as { busy: boolean; now: number };
		return events.activity(a.busy, a.now);
	}
	if (op === "deadline") return events.deadline(Number(args));
	if (op === "prepare") return events.prepare(Number(args));
	if (op === "pending") return events.pending();
	if (op === "acknowledge") {
		const a = args as { notice: WatchNotice; now: number };
		return events.acknowledge(a.notice, a.now);
	}
	if (op === "list") return list(now);
	if (op === "dashboard") {
		prune(now);
		return {
			watches: db
				.prepare("SELECT data FROM watches ORDER BY id LIMIT 100")
				.all()
				.map((row) => JSON.parse(String(row.data))),
			total: Number(db.prepare("SELECT COUNT(*) AS n FROM watches").get()!.n),
		};
	}
	if (op === "page") {
		prune(now);
		const { after, limit } = args as { after?: string; limit: number };
		const rows = db.prepare("SELECT data FROM watches WHERE id > ? ORDER BY id LIMIT ?").all(after ?? "", limit + 1);
		const watches: Watch[] = rows.slice(0, limit).map((row) => JSON.parse(String(row.data)));
		return { watches, ...(rows.length > limit ? { next: watches.at(-1)!.id } : {}) };
	}
	if (op === "add") {
		const input = validateWatch(args as WatchInput, now);
		prune(now);
		if (Number(db.prepare("SELECT COUNT(*) AS n FROM watches").get()!.n) >= MAX_WATCHES)
			throw new Error("Watch limit reached");
		const watch: Watch = { ...input, id: randomUUID(), createdAt: now };
		db.prepare("INSERT INTO watches VALUES (?, ?, ?, ?, ?, ?, ?)").run(
			watch.id,
			watch.event,
			watch.target.kind,
			watch.target.id,
			watch.target.missionId ?? "",
			JSON.stringify(watch),
			watch.expiresAt ?? null,
		);
		return watch;
	}
	if (op === "remove") return Number(db.prepare("DELETE FROM watches WHERE id = ?").run(String(args)).changes) > 0;
	if (op === "close") {
		db.close();
		return null;
	}
	throw new Error("Unknown watch operation");
}
parentPort!.on("message", ({ id, op, args }: { id: number; op: string; args: unknown }) => {
	try {
		parentPort!.postMessage({ id, value: dispatch(op, args) });
	} catch (error) {
		parentPort!.postMessage({ id, error: String(error) });
	}
	if (op === "close") parentPort!.close();
});
