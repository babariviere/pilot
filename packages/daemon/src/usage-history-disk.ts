/** Worker-only: bounded local accounting materialization, never opened by UI/diagnostic reads. */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
	UsageAggregate,
	UsageAnalyticsQuery,
	UsageAnalyticsResult,
	UsageHistoryPage,
	UsageHistoryQuery,
	UsageHistoryStatus,
	UsageHistoryWriteResult,
	UsageQueryFilters,
} from "@pilot/protocol";
import {
	parseUsageObservation,
	readUsageObservation,
	safeUsageInteger,
	USAGE_DAY_MS,
	USAGE_MAX_BYTES,
	USAGE_MAX_ROWS,
	USAGE_RETENTION_MS,
	USAGE_ROW_BYTES,
	usageAnalyticsQuery,
	usageFilters,
	usageIdentifier,
	usageUUID,
} from "./usage-history-validation.ts";

const METRICS = {
	input: "tokens.input",
	output: "tokens.output",
	cacheRead: "tokens.cacheRead",
	cacheWrite: "tokens.cacheWrite",
	reasoning: "tokens.reasoning",
	estimatedUsdMicros: "cost.estimatedUsdMicros",
	billedUsdMicros: "cost.billedUsdMicros",
	requests: "requests",
	providerAttempts: "providerAttempts",
	retries: "retries",
	durationMs: "durationMs",
} as const;
// Time index bounds the candidate set; the store independently caps it at 50,000 rows. SQL reduces
// numeric JSON directly inside the worker. Neither the daemon nor UI materializes the ledger.
const FILTER_SQL = `
 AND (? IS NULL OR lower(json_extract(data,'$.attribution.projectId'))=?)
 AND (? IS NULL OR lower(chat)=?)
 AND (? IS NULL OR lower(json_extract(data,'$.attribution.mission.homeId'))=?)
 AND (? IS NULL OR lower(json_extract(data,'$.attribution.mission.lineageId'))=?)
 AND (? IS NULL OR lower(json_extract(data,'$.attribution.mission.missionId'))=?)
 AND (? IS NULL OR json_extract(data,'$.purpose')=?)
 AND (? IS NULL OR json_extract(data,'$.physicalModel.provider')=?)
 AND (? IS NULL OR json_extract(data,'$.physicalModel.model')=?)
 AND (? IS NULL OR json_extract(data,'$.virtualModel.provider')=?)
 AND (? IS NULL OR json_extract(data,'$.virtualModel.model')=?)
 AND (? IS NULL OR json_extract(data,'$.virtualRevision')=?)
 AND (?=0 OR json_extract(data,'$.attribution.projectId') IS NULL)
 AND (?=0 OR json_extract(data,'$.attribution.mission.homeId') IS NULL)
 AND (?=0 OR chat IS NULL)
 AND (?=0 OR json_extract(data,'$.physicalModel.provider') IS NULL)
 AND (?=0 OR json_extract(data,'$.virtualModel.provider') IS NULL)
 AND (?=0 OR json_extract(data,'$.virtualRevision') IS NULL)`;
function filterArgs(f: UsageQueryFilters): Array<string | number | null> {
	return [
		...[
			f.projectId,
			f.chatId,
			f.mission?.homeId,
			f.mission?.lineageId,
			f.mission?.missionId,
			f.purpose,
			f.physicalModel?.provider,
			f.physicalModel?.model,
			f.virtualModel?.provider,
			f.virtualModel?.model,
			f.virtualRevision,
		].flatMap((v) => [v ?? null, v ?? null]),
		...["project", "mission", "chat", "physicalModel", "virtualPolicy", "virtualRevision"].map((k) =>
			f.missing?.includes(k as NonNullable<UsageQueryFilters["missing"]>[number]) ? 1 : 0,
		),
	];
}
const AGGREGATE_SQL = `COUNT(*) AS records,
 COALESCE(SUM(json_extract(data,'$.coverage')='committed'),0) AS committed,
 COALESCE(SUM(json_extract(data,'$.coverage')='partial'),0) AS partial,
 COALESCE(SUM(json_extract(data,'$.coverage')='legacy'),0) AS legacy,
 COALESCE(SUM(json_extract(data,'$.cost.estimatedUsdMicros') IS NULL),0) AS unpriced,
 COALESCE(SUM(json_extract(data,'$.cost.estimateStatus')='partial_catalog_estimate'),0) AS partialPriced,
 COUNT(DISTINCT json_extract(data,'$.cost.pricingRevision')) AS pricingVersions,
 MIN(json_extract(data,'$.cost.pricingRevision')) AS pricingRevision,
 ${Object.entries(METRICS)
		.map(
			([key, path]) => `COUNT(json_extract(data,'$.${path}')) AS ${key}Known,
 TOTAL(json_extract(data,'$.${path}')) AS ${key}Value,
 COALESCE(SUM(${key === "reasoning" ? "json_extract(data,'$.tokens.reasoningStatus')='partial'" : key === "estimatedUsdMicros" ? "json_extract(data,'$.cost.estimateStatus')='partial_catalog_estimate'" : "0"}),0) AS ${key}Partial`,
		)
		.join(",")}`;
const FACT_EXPRESSIONS = [...new Set([...AGGREGATE_SQL.matchAll(/json_extract\(data,'[^']+'\)/g)].map((m) => m[0]))];
const FACTS_SQL = FACT_EXPRESSIONS.map((expression, i) => `${expression} AS v${i}`).join(",");
const REDUCE_FACTS_SQL = AGGREGATE_SQL.replace(
	/json_extract\(data,'[^']+'\)/g,
	(expression) => `v${FACT_EXPRESSIONS.indexOf(expression)}`,
);
const GROUP_SQL = `CASE ?
 WHEN 'project' THEN json_quote(lower(json_extract(data,'$.attribution.projectId')))
 WHEN 'chat' THEN json_quote(lower(chat))
 WHEN 'mission' THEN CASE WHEN json_extract(data,'$.attribution.mission.homeId') IS NULL THEN 'null' ELSE json_array(
 lower(json_extract(data,'$.attribution.mission.homeId')), lower(json_extract(data,'$.attribution.mission.lineageId')), lower(json_extract(data,'$.attribution.mission.missionId'))) END
 WHEN 'purpose' THEN json_quote(json_extract(data,'$.purpose'))
 WHEN 'physicalModel' THEN CASE WHEN json_extract(data,'$.physicalModel.provider') IS NULL THEN 'null' ELSE json_array(json_extract(data,'$.physicalModel.provider'),json_extract(data,'$.physicalModel.model')) END
 WHEN 'virtualPolicy' THEN CASE WHEN json_extract(data,'$.virtualModel.provider') IS NULL THEN 'null' ELSE json_array(json_extract(data,'$.virtualModel.provider'),json_extract(data,'$.virtualModel.model'),json_extract(data,'$.virtualRevision')) END
 WHEN 'scope' THEN json_quote(scope)
 ELSE printf('%016d',CAST(completed / ? AS INTEGER) * ?) END`;
// A covering expression index avoids reparsing ledger JSON for every aggregate. The expressions
// come exclusively from the three fixed SQL constants above, never client input. This is an
// optional, backwards-compatible v1 index, not a new ledger or runtime/storage ownership change.
const QUERY_INDEX_SQL = `CREATE INDEX IF NOT EXISTS usage_query_v1 ON usage_rows(kind,completed,age,chat,scope,
 ${[...new Set([...`${AGGREGATE_SQL} ${FILTER_SQL} ${GROUP_SQL}`.matchAll(/json_extract\(data,'[^']+'\)/g)].map((m) => m[0]))].join(",")})`;
function aggregate(r: Record<string, unknown>, checkpoint = false): UsageAggregate {
	const result = Object.fromEntries(
		["records", "committed", "partial", "legacy", "unpriced", "partialPriced", "pricingVersions"].map((k) => [
			k,
			Number(r[k]),
		]),
	) as unknown as UsageAggregate;
	if (result.pricingVersions === 1) result.pricingRevision = String(r.pricingRevision);
	result.metrics = {} as UsageAggregate["metrics"];
	for (const key of Object.keys(METRICS) as Array<keyof typeof METRICS>) {
		const known = Number(r[`${key}Known`]);
		const value = Number(r[`${key}Value`]);
		const overflow = !checkpoint && known > 0 && !safeUsageInteger(value);
		result.metrics[key] = {
			...(known && !checkpoint && !overflow ? { value } : {}),
			known,
			unknown: result.records - known,
			partial: Number(r[`${key}Partial`]),
			overflow,
		};
	}
	return result;
}
function queryKey(query: unknown): string {
	return createHash("sha256").update(JSON.stringify(query)).digest("hex");
}

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
	private readonly statements = new Map<string, StatementSync>();
	private readonly queryIndex: "usage_time" | "usage_query_v1";
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
			try {
				db.exec(QUERY_INDEX_SQL);
			} catch (error) {
				// An older store near its byte cap must remain readable/writable under the original
				// bounds. A full optional index rolls back atomically; never evict data or raise the cap.
				if ((error as { errcode?: number }).errcode !== 13) throw error; // SQLITE_FULL
			}
			this.queryIndex = db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='usage_query_v1'").get()
				? "usage_query_v1"
				: "usage_time";
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
	/** Fixed SQL only. Repeated prepare() retains native SQLite allocations until a later V8 GC. */
	private prepare(sql: string): StatementSync {
		let statement = this.statements.get(sql);
		if (!statement) {
			if (this.statements.size >= 20) throw new Error("Usage statement capacity exceeded");
			statement = this.db.prepare(sql);
			this.statements.set(sql, statement);
		}
		return statement;
	}
	private meta(): Meta {
		const value = this.prepare("SELECT * FROM usage_meta WHERE id=1").get() as unknown as Meta;
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
		const result = this.prepare(
			"DELETE FROM usage_rows WHERE rowid IN (SELECT rowid FROM usage_rows WHERE age < ? LIMIT 500)",
		).run(floor);
		this.prepare(
			"UPDATE usage_meta SET floor=?, rows=rows-?, expired=MIN(9007199254740991,expired+?) WHERE id=1",
		).run(floor, result.changes, result.changes);
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
				const previous = this.prepare(
					"SELECT revision, kind, scope, data FROM usage_rows WHERE source=? AND operation=?",
				).get(row.sourceId, row.operationId);
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
				this.prepare(`INSERT INTO usage_rows VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(source,operation)
				 DO UPDATE SET revision=excluded.revision, completed=excluded.completed, age=excluded.age, chat=excluded.chat, data=excluded.data`).run(
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
		const filters = usageFilters(query.filters);
		const filterKey = queryKey(filters);
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
					c.length !== 8 ||
					c[0] !== m.generation ||
					c[1] !== query.kind ||
					c[2] !== query.from ||
					c[3] !== query.to ||
					c[7] !== filterKey ||
					!safeUsageInteger(c[4]) ||
					!usageUUID(c[5]) ||
					!usageIdentifier(c[6])
				)
					throw new Error();
				[time, source, operation] = c.slice(4, 7);
			} catch {
				throw new Error("Invalid usage cursor");
			}
		}
		const limit = query.limit ?? 100;
		// Checkpoints are undated reconciliation, deliberately independent of the chart's date window.
		const from = query.kind === "checkpoint" ? 0 : query.from;
		const to = query.kind === "checkpoint" ? Number.MAX_SAFE_INTEGER : query.to;
		const rows = this.prepare(`SELECT completed, source, operation,
		 CASE WHEN length(CAST(data AS BLOB))<=${USAGE_ROW_BYTES} THEN data ELSE NULL END AS data
		 FROM usage_rows INDEXED BY usage_time
			 WHERE kind=? AND completed>=? AND completed<? AND (completed,source,operation)>(?,?,?) AND age>=? ${FILTER_SQL}
		 ORDER BY completed,source,operation LIMIT ?`).all(
			query.kind,
			from,
			to,
			time,
			source,
			operation,
			Math.max(m.floor, now - USAGE_RETENTION_MS),
			...filterArgs(filters),
			limit + 1,
		);
		const hasMore = rows.length > limit;
		if (hasMore) rows.pop();
		const last = rows.at(-1);
		const result = rows.map((r) => {
			if (typeof r.data !== "string") throw new Error("Usage row unavailable");
			return readUsageObservation(r.data);
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
								filterKey,
							]),
						).toString("base64url"),
					}
				: {}),
			status: { ...this.status(), retentionFloor: Math.max(m.floor, now - USAGE_RETENTION_MS) },
		};
	}

	analytics(value: UsageAnalyticsQuery, now: number): UsageAnalyticsResult {
		const q = usageAnalyticsQuery(value);
		if (!safeUsageInteger(now)) throw new Error("Invalid usage clock");
		const m = this.meta();
		const signature = queryKey([q.version, q.from, q.to, q.filters, q.view, q.dimension ?? null, q.bucketMs ?? null]);
		let after = "";
		if (q.after !== undefined) {
			try {
				const c = JSON.parse(Buffer.from(q.after, "base64url").toString("utf8"));
				if (
					!Array.isArray(c) ||
					c.length !== 3 ||
					c[0] !== m.generation ||
					c[1] !== signature ||
					typeof c[2] !== "string" ||
					c[2].length > 512
				)
					throw new Error();
				after = c[2];
			} catch {
				throw new Error("Invalid usage cursor");
			}
		}
		const floor = Math.max(m.floor, now - USAGE_RETENTION_MS);
		const args = filterArgs(q.filters!);
		const where = `FROM usage_rows INDEXED BY ${this.queryIndex} WHERE kind=? AND completed>=? AND completed<? AND age>=? ${FILTER_SQL}`;
		const readTotal = (kind: string, from: number, to: number) =>
			aggregate(
				this.prepare(`SELECT ${AGGREGATE_SQL} ${where}`).get(kind, from, to, floor, ...args)!,
				kind === "checkpoint",
			);
		const total = readTotal("request", q.from, q.to);
		const reconciliation = readTotal("checkpoint", 0, Number.MAX_SAFE_INTEGER);
		const limit = q.limit ?? 100;
		const rows =
			q.view === "summary"
				? []
				: // LIMIT prevents flattening: SQLite streams scalar index facts into the grouping
					// sorter instead of carrying/reparsing raw ledger JSON for every aggregate field.
					this.prepare(`SELECT key, ${REDUCE_FACTS_SQL} FROM (SELECT ${GROUP_SQL} AS key, ${FACTS_SQL} ${where} LIMIT ${USAGE_MAX_ROWS})
		 GROUP BY key HAVING key>? ORDER BY key LIMIT ?`).all(
						q.dimension ?? "buckets",
						q.bucketMs ?? 1,
						q.bucketMs ?? 1,
						"request",
						q.from,
						q.to,
						floor,
						...args,
						after,
						limit + 1,
					);
		const truncated = rows.length > limit;
		if (truncated) rows.pop();
		const last = rows.at(-1);
		const result: UsageAnalyticsResult = {
			version: 1,
			queriedAt: now,
			status: { ...this.status(), retentionFloor: floor },
			total,
			reconciliation,
			groups: rows.map((r) => ({ key: String(r.key), aggregate: aggregate(r) })),
			coverage: "partial",
			truncated,
			...(truncated && last
				? { next: Buffer.from(JSON.stringify([m.generation, signature, last.key])).toString("base64url") }
				: {}),
		};
		if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024) throw new Error("Usage response limit exceeded");
		return result;
	}

	/** Rotation globally fences in-flight reporters, without an unbounded tombstone inventory. */
	erase(chatId: string | undefined, now: number): UsageHistoryStatus {
		if ((chatId !== undefined && !usageUUID(chatId)) || !safeUsageInteger(now))
			throw new Error("Invalid usage erasure");
		return this.transaction(() => {
			const changes =
				chatId === undefined
					? this.prepare("DELETE FROM usage_rows").run().changes
					: this.prepare("DELETE FROM usage_rows WHERE chat=?").run(chatId).changes;
			this.prepare(
				"UPDATE usage_meta SET generation=?, started=MAX(started,?), capture=MAX(capture,?), rows=rows-? WHERE id=1",
			).run(randomUUID(), now, now + 1, changes);
			return this.status();
		});
	}
	close(): void {
		this.db.close();
		this.statements.clear();
	}
}
