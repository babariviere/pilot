/** Worker-only: bounded local accounting materialization, never opened by UI/diagnostic reads. */
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { UsageHistoryPage, UsageHistoryQuery, UsageHistoryStatus, UsageHistoryWriteResult } from "@pilot/protocol";
import {
	parseUsageObservation,
	safeUsageInteger,
	USAGE_DAY_MS,
	USAGE_MAX_BYTES,
	USAGE_MAX_ROWS,
	USAGE_RETENTION_MS,
	USAGE_ROW_BYTES,
	usageIdentifier,
	usageUUID,
} from "./usage-history-validation.ts";

interface Meta {
	generation: string;
	started: number;
	capture: number;
	floor: number;
	rows: number;
	rejected: number;
	conflicts: number;
	expired: number;
}

export class UsageHistoryDisk {
	readonly db: DatabaseSync;
	readonly maxRows: number;
	constructor(file: string, now: number, limits: { maxRows?: number; maxBytes?: number } = {}) {
		this.maxRows = Math.min(USAGE_MAX_ROWS, Math.max(1, limits.maxRows ?? USAGE_MAX_ROWS));
		const maxBytes = Math.min(USAGE_MAX_BYTES, Math.max(65536, limits.maxBytes ?? USAGE_MAX_BYTES));
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		if (!lstatSync(dirname(file)).isDirectory() || lstatSync(dirname(file)).isSymbolicLink())
			throw new Error("Usage directory unavailable");
		chmodSync(dirname(file), 0o700);
		if (existsSync(file)) {
			const stat = lstatSync(file);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes)
				throw new Error("Usage database unavailable");
		}
		const fd = openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
		closeSync(fd);
		chmodSync(file, 0o600);
		const db = new DatabaseSync(file);
		this.db = db;
		try {
			const version = db.prepare("PRAGMA user_version").get()?.user_version;
			if (version !== 0 && version !== 1) throw new Error("Usage schema unavailable");
			if (version === 0 && db.prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get())
				throw new Error("Usage schema unavailable");
			db.exec(
				"PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;",
			);
			const pageSize = Number(db.prepare("PRAGMA page_size").get()?.page_size);
			db.exec(`PRAGMA max_page_count=${Math.floor(maxBytes / pageSize)}`);
			if (version === 0)
				this.transaction(() => {
					db.exec(`
					CREATE TABLE usage_meta (id INTEGER PRIMARY KEY CHECK(id=1), generation TEXT NOT NULL,
					 started INTEGER NOT NULL, capture INTEGER NOT NULL, floor INTEGER NOT NULL,
					 rows INTEGER NOT NULL, rejected INTEGER NOT NULL, conflicts INTEGER NOT NULL, expired INTEGER NOT NULL);
					CREATE TABLE usage_rows (source TEXT COLLATE NOCASE NOT NULL, operation TEXT NOT NULL,
					 revision INTEGER NOT NULL, kind TEXT NOT NULL, scope TEXT NOT NULL, completed INTEGER NOT NULL,
					 age INTEGER NOT NULL, chat TEXT COLLATE NOCASE, data TEXT NOT NULL, PRIMARY KEY(source, operation));
					CREATE INDEX usage_time ON usage_rows(kind, completed, source, operation);
					CREATE INDEX usage_age ON usage_rows(age);
					CREATE INDEX usage_chat ON usage_rows(chat);
					PRAGMA user_version=1;
				`);
					db.prepare("INSERT INTO usage_meta VALUES(1, ?, ?, 0, ?, 0, 0, 0, 0)").run(
						randomUUID(),
						now,
						Math.max(0, now - USAGE_RETENTION_MS),
					);
				});
			this.status(); // Verify required metadata, fail closed on malformed state.
			this.expire(now);
		} catch {
			db.close();
			throw new Error("Usage database unavailable");
		}
	}

	private transaction<T>(body: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = body();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	private meta(): Meta {
		const value = this.db.prepare("SELECT * FROM usage_meta WHERE id=1").get() as unknown as Meta;
		if (
			!value ||
			!usageUUID(value.generation) ||
			![value.started, value.capture, value.floor, value.rows, value.rejected, value.conflicts, value.expired].every(
				safeUsageInteger,
			) ||
			value.rows > this.maxRows
		)
			throw new Error("Usage metadata unavailable");
		return value;
	}
	status(): UsageHistoryStatus {
		const m = this.meta();
		return {
			schemaVersion: 1,
			generation: m.generation,
			coverageStartedAt: m.started,
			captureFloor: m.capture,
			retentionFloor: m.floor,
			retainedRows: m.rows,
			rejected: m.rejected,
			conflicts: m.conflicts,
			expired: m.expired,
			queueOverflows: 0,
			coverage: "partial",
		};
	}
	private reject(): "rejected" {
		this.db.exec("UPDATE usage_meta SET rejected=MIN(9007199254740991,rejected+1) WHERE id=1");
		return "rejected";
	}

	/** At most 500 rows deleted per transaction. The persisted floor fences even unprocessed expired rows. */
	expire(now: number): void {
		if (!safeUsageInteger(now)) throw new Error("Invalid usage clock");
		this.transaction(() => this.expireInside(now));
	}
	private expireInside(now: number): void {
		const floor = Math.max(this.meta().floor, now - USAGE_RETENTION_MS, 0);
		const result = this.db
			.prepare("DELETE FROM usage_rows WHERE rowid IN (SELECT rowid FROM usage_rows WHERE age < ? LIMIT 500)")
			.run(floor);
		this.db
			.prepare("UPDATE usage_meta SET floor=?, rows=rows-?, expired=MIN(9007199254740991,expired+?) WHERE id=1")
			.run(floor, result.changes, result.changes);
	}
	put(value: unknown, now: number): UsageHistoryWriteResult {
		if (!safeUsageInteger(now)) throw new Error("Invalid usage clock");
		let row: ReturnType<typeof parseUsageObservation>;
		try {
			row = parseUsageObservation(value);
		} catch {
			return this.reject();
		}
		try {
			return this.transaction(() => {
				this.expireInside(now);
				const m = this.meta();
				const age = Math.min(row.observedAt, row.completedAt ?? row.observedAt);
				if (
					row.generation !== m.generation ||
					age < Math.max(m.floor, m.capture) ||
					row.observedAt > now ||
					(row.kind === "request" && row.completedAt === undefined)
				)
					return this.reject();
				const previous = this.db
					.prepare("SELECT revision, kind, scope, data FROM usage_rows WHERE source=? AND operation=?")
					.get(row.sourceId, row.operationId);
				const data = JSON.stringify(row);
				if (previous) {
					if (row.revision < Number(previous.revision)) return "stale";
					if (
						row.kind !== previous.kind ||
						row.scope !== previous.scope ||
						(row.revision === previous.revision && data !== previous.data)
					) {
						this.db.exec("UPDATE usage_meta SET conflicts=MIN(9007199254740991,conflicts+1) WHERE id=1");
						return "conflict";
					}
					if (row.revision === previous.revision) return "duplicate";
				} else if (m.rows >= this.maxRows) return this.reject();
				this.db
					.prepare(`INSERT INTO usage_rows VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(source,operation)
				 DO UPDATE SET revision=excluded.revision, completed=excluded.completed, age=excluded.age, chat=excluded.chat, data=excluded.data`)
					.run(
						row.sourceId,
						row.operationId,
						row.revision,
						row.kind,
						row.scope,
						row.completedAt ?? 0,
						age,
						row.attribution?.chatId ?? null,
						data,
					);
				if (!previous) this.db.exec("UPDATE usage_meta SET rows=rows+1 WHERE id=1");
				return "stored";
			});
		} catch {
			// Full disk/database must not change inference. A successful ack is only sent after COMMIT.
			return this.reject();
		}
	}

	page(query: UsageHistoryQuery, now: number): UsageHistoryPage {
		if (
			!query ||
			!safeUsageInteger(now) ||
			!["request", "checkpoint"].includes(query.kind) ||
			!safeUsageInteger(query.from) ||
			!safeUsageInteger(query.to) ||
			query.to <= query.from ||
			query.to - query.from > 366 * USAGE_DAY_MS ||
			(query.limit !== undefined && (!safeUsageInteger(query.limit) || query.limit < 1 || query.limit > 100))
		)
			throw new Error("Invalid usage query");
		const m = this.meta();
		let time = -1,
			source = "",
			operation = "";
		if (query.after !== undefined) {
			if (query.after.length > 1024) throw new Error("Invalid usage cursor");
			try {
				const c = JSON.parse(Buffer.from(query.after, "base64url").toString("utf8"));
				if (
					!Array.isArray(c) ||
					c.length !== 7 ||
					c[0] !== m.generation ||
					c[1] !== query.kind ||
					c[2] !== query.from ||
					c[3] !== query.to ||
					!safeUsageInteger(c[4]) ||
					!usageUUID(c[5]) ||
					!usageIdentifier(c[6])
				)
					throw new Error();
				[time, source, operation] = c.slice(4);
			} catch {
				throw new Error("Invalid usage cursor");
			}
		}
		const limit = query.limit ?? 100;
		// Checkpoints are undated reconciliation, deliberately independent of the chart's date window.
		const from = query.kind === "checkpoint" ? 0 : query.from;
		const to = query.kind === "checkpoint" ? Number.MAX_SAFE_INTEGER : query.to;
		const rows = this.db
			.prepare(`SELECT completed, source, operation,
		 CASE WHEN length(CAST(data AS BLOB))<=${USAGE_ROW_BYTES} THEN data ELSE NULL END AS data
		 FROM usage_rows INDEXED BY usage_time
		 WHERE kind=? AND completed>=? AND completed<? AND (completed,source,operation)>(?,?,?) AND age>=?
		 ORDER BY completed,source,operation LIMIT ?`)
			.all(query.kind, from, to, time, source, operation, Math.max(m.floor, now - USAGE_RETENTION_MS), limit + 1);
		const hasMore = rows.length > limit;
		if (hasMore) rows.pop();
		const last = rows.at(-1);
		const result = rows.map((r) => {
			if (typeof r.data !== "string") throw new Error("Usage row unavailable");
			return parseUsageObservation(JSON.parse(r.data));
		});
		return {
			rows: result,
			...(hasMore && last
				? {
						next: Buffer.from(
							JSON.stringify([
								m.generation,
								query.kind,
								query.from,
								query.to,
								last.completed,
								last.source,
								last.operation,
							]),
						).toString("base64url"),
					}
				: {}),
			status: this.status(),
		};
	}

	/** Rotation globally fences in-flight reporters, without an unbounded tombstone inventory. */
	erase(chatId: string | undefined, now: number): UsageHistoryStatus {
		if ((chatId !== undefined && !usageUUID(chatId)) || !safeUsageInteger(now))
			throw new Error("Invalid usage erasure");
		return this.transaction(() => {
			const changes =
				chatId === undefined
					? this.db.prepare("DELETE FROM usage_rows").run().changes
					: this.db.prepare("DELETE FROM usage_rows WHERE chat=?").run(chatId).changes;
			this.db
				.prepare(
					"UPDATE usage_meta SET generation=?, started=MAX(started,?), capture=MAX(capture,?), rows=rows-? WHERE id=1",
				)
				.run(randomUUID(), now, now + 1, changes);
			return this.status();
		});
	}
	close(): void {
		this.db.close();
	}
}
