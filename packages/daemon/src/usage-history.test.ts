import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { AIUsageAccounting, UsageHistoryPage, UsageHistoryQuery, UsageObservation } from "@pilot/protocol";
import { UsageHistoryStore } from "./usage-history.ts";
import { UsageHistoryDisk } from "./usage-history-disk.ts";
import {
	parseUsageObservation,
	readUsageObservation,
	USAGE_DAY_MS,
	USAGE_MAX_BYTES,
	USAGE_MAX_ROWS,
	USAGE_RETENTION_MS,
} from "./usage-history-validation.ts";

const fixture: UsageHistoryPage = JSON.parse(
	await readFile(new URL("../../protocol/fixtures/usage-history.json", import.meta.url), "utf8"),
);
const NOW = fixture.rows[0]!.observedAt;
const CHAT = fixture.rows[0]!.attribution!.chatId!;
const OTHER = "99999999-9999-4999-8999-999999999999";
const QUERY: UsageHistoryQuery = { kind: "request", from: NOW - USAGE_DAY_MS, to: NOW + USAGE_DAY_MS };
async function diskFixture(limits?: { maxRows?: number; maxBytes?: number }) {
	const home = await mkdtemp(join(tmpdir(), "usage-history-"));
	const file = join(home, "accounting", "usage-history.sqlite");
	const disk = new UsageHistoryDisk(file, NOW, limits);
	return {
		home,
		file,
		disk,
		close: async () => {
			disk.close();
			await rm(home, { recursive: true, force: true });
		},
	};
}
function row(disk: UsageHistoryDisk, overrides: Partial<UsageObservation> = {}): UsageObservation {
	return { ...structuredClone(fixture.rows[0]!), generation: disk.status().generation, ...overrides };
}

test("shared local accounting fixture has exact canonical TS shape and unknown legacy provenance", () => {
	assert.deepEqual(fixture.rows.map(parseUsageObservation), fixture.rows);
	assert.equal(fixture.rows[1]!.completedAt, undefined);
	assert.equal(fixture.rows[1]!.physicalModel, undefined);
});

test("unknown dispatched responses omit usage rather than inventing zero tokens/cost", async () => {
	const unknown = JSON.parse(
		await readFile(new URL("../../protocol/fixtures/usage-history-unknown.json", import.meta.url), "utf8"),
	);
	assert.deepEqual(parseUsageObservation(unknown), unknown);
	assert.equal(parseUsageObservation(unknown).tokens, undefined);
	assert.equal(parseUsageObservation(unknown).cost, undefined);
	assert.throws(() =>
		parseUsageObservation({ ...unknown, parent: { sourceId: CHAT, operationId: "https://private" } }),
	);
	assert.throws(() => parseUsageObservation({ ...unknown, kind: "request", activity: "compaction" }));
	assert.equal(
		parseUsageObservation({ ...unknown, kind: "checkpoint", activity: "compaction", requests: 0 }).activity,
		"compaction",
	);
});

test("bounded stored-row reader preserves strict validation without reserializing JSON", () => {
	const json = JSON.stringify(fixture.rows[0]);
	assert.deepEqual(readUsageObservation(json), fixture.rows[0]);
	assert.throws(() => readUsageObservation(" ".repeat(4097)), /Invalid usage value/);
	assert.throws(
		() => readUsageObservation(JSON.stringify({ ...fixture.rows[0], prompt: "private" })),
		/Invalid usage fields/,
	);
	assert.throws(
		() =>
			readUsageObservation(
				JSON.stringify({ ...fixture.rows[0], tokens: { ...fixture.rows[0]!.tokens, input: -1 } }),
			),
		/Invalid usage value/,
	);
	const stringify = JSON.stringify;
	try {
		JSON.stringify = () => {
			throw new Error("Unexpected stored-row serialization");
		};
		assert.deepEqual(readUsageObservation(json), fixture.rows[0]);
	} finally {
		JSON.stringify = stringify;
	}
});

test("transactional schema v0 migration, private files and restart persistence", async () => {
	const f = await diskFixture();
	try {
		assert.equal(f.disk.db.prepare("PRAGMA user_version").get()!.user_version, 2);
		assert.equal(f.disk.db.prepare("PRAGMA synchronous").get()!.synchronous, 2);
		assert.equal((await stat(f.file)).mode & 0o777, 0o600);
		assert.equal((await stat(join(f.home, "accounting"))).mode & 0o777, 0o700);
		const input = row(f.disk);
		assert.equal(f.disk.put(input, NOW), "stored");
		f.disk.close();
		const reopened = new UsageHistoryDisk(f.file, NOW);
		try {
			assert.equal(reopened.put(input, NOW), "duplicate");
			assert.deepEqual(reopened.page(QUERY, NOW).rows, [input]);
		} finally {
			reopened.close();
		}
	} finally {
		await rm(f.home, { recursive: true, force: true });
	}
});

test("binary storage reduces payload bytes without changing public records or duplicate identity", async () => {
	const f = await diskFixture();
	try {
		const input = row(f.disk);
		assert.equal(f.disk.put(input, NOW), "stored");
		const stored = f.disk.db.prepare("SELECT typeof(data) AS type, length(data) AS bytes FROM usage_rows").get()!;
		assert.equal(stored.type, "blob");
		assert.ok(Number(stored.bytes) < Buffer.byteLength(JSON.stringify(input)));
		assert.deepEqual(f.disk.page(QUERY, NOW).rows, [input]);
		assert.equal(f.disk.put(input, NOW), "duplicate");
		assert.equal(f.disk.put({ ...input, revision: input.revision + 1 }, NOW), "stored");
	} finally {
		await f.close();
	}
});

test("full legacy text store compacts and resumes writes under increased capacity without losing history", async () => {
	const f = await diskFixture({ maxBytes: 65536 });
	let disk = f.disk;
	try {
		// Recreate the old on-disk representation and cap, including a capacity rejection.
		disk.db.exec("PRAGMA user_version=1");
		const input = row(disk);
		const insert = disk.db.prepare("INSERT INTO usage_rows VALUES(?,?,?,?,?,?,?,?,?)");
		for (let i = 0; i < 200; i++) {
			const next = parseUsageObservation({ ...input, operationId: `legacy:${i}` });
			try {
				insert.run(
					next.sourceId,
					next.operationId,
					next.revision,
					next.kind,
					next.scope,
					next.completedAt!,
					next.completedAt!,
					next.attribution?.chatId ?? null,
					JSON.stringify(next),
				);
			} catch (error) {
				assert.equal((error as { errcode?: number }).errcode, 13);
				break;
			}
		}
		disk.db.exec("UPDATE usage_meta SET rows=(SELECT COUNT(*) FROM usage_rows), rejected=7, conflicts=3");
		const before = disk.status();
		const records = disk.page(QUERY, NOW).rows;
		assert.ok(records.length > 0 && records.length < 100);
		const bytesBefore = (await stat(f.file)).size;
		const totals = disk.analytics({ version: 1, view: "summary", from: QUERY.from, to: QUERY.to }, NOW);
		disk.close();
		disk = new UsageHistoryDisk(f.file, NOW);
		assert.deepEqual(disk.status(), before);
		assert.deepEqual(disk.page(QUERY, NOW).rows, records);
		assert.deepEqual(disk.analytics({ version: 1, view: "summary", from: QUERY.from, to: QUERY.to }, NOW), totals);
		assert.ok((await stat(f.file)).size < bytesBefore, "VACUUM must pack the smaller binary rows");
		assert.equal(disk.db.prepare("PRAGMA user_version").get()!.user_version, 2);
		assert.equal(Number(disk.db.prepare("PRAGMA max_page_count").get()!.max_page_count) * 4096, USAGE_MAX_BYTES);
		assert.equal(disk.put(records[0]!, NOW), "duplicate");
		assert.equal(disk.put({ ...input, operationId: "after-capacity-increase" }, NOW), "stored");
		disk.close();
		disk = new UsageHistoryDisk(f.file, NOW);
		assert.equal(disk.status().retainedRows, before.retainedRows + 1);
		assert.equal(disk.status().generation, before.generation);
	} finally {
		disk.close();
		await rm(f.home, { recursive: true, force: true });
	}
});

test("increased default row capacity accepts records beyond the former 50,000-row limit", async () => {
	const f = await diskFixture();
	try {
		const input = row(f.disk);
		f.disk.db
			.prepare(`WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<49999)
		 INSERT INTO usage_rows SELECT ?, 'limit:'||i, ?, ?, ?, ?, ?, ?,
		 jsonb(json_set(?, '$.operationId', 'limit:'||i)) FROM n`)
			.run(
				input.sourceId,
				input.revision,
				input.kind,
				input.scope,
				input.completedAt!,
				input.completedAt!,
				input.attribution?.chatId ?? null,
				JSON.stringify(input),
			);
		f.disk.db.exec("UPDATE usage_meta SET rows=50000");
		assert.equal(f.disk.maxRows, USAGE_MAX_ROWS);
		assert.equal(USAGE_MAX_ROWS, 250_000);
		assert.equal(f.disk.put({ ...input, operationId: "beyond-old-limit" }, NOW), "stored");
		assert.equal(f.disk.status().retainedRows, 50_001);
		assert.equal(f.disk.status().expired, 0);
	} finally {
		await f.close();
	}
});

test("failed page packing leaves committed binary migration usable and does not retry on every open", async () => {
	const f = await diskFixture();
	const input = row(f.disk);
	assert.equal(f.disk.put(input, NOW), "stored");
	f.disk.db.exec("UPDATE usage_rows SET data=json(data); PRAGMA user_version=1");
	const before = f.disk.status();
	f.disk.close();
	const exec = DatabaseSync.prototype.exec;
	let attempts = 0;
	DatabaseSync.prototype.exec = function (sql) {
		if (sql === "VACUUM") {
			attempts++;
			throw new Error("Synthetic temporary disk exhaustion");
		}
		return exec.call(this, sql);
	};
	try {
		for (let i = 0; i < 2; i++) {
			const disk = new UsageHistoryDisk(f.file, NOW);
			try {
				assert.deepEqual(disk.status(), before);
				assert.deepEqual(disk.page(QUERY, NOW).rows, [parseUsageObservation(input)]);
				assert.equal(disk.put(input, NOW), "duplicate");
				assert.equal(disk.db.prepare("SELECT typeof(data) AS type FROM usage_rows").get()!.type, "blob");
			} finally {
				disk.close();
			}
		}
		assert.equal(attempts, 1);
	} finally {
		DatabaseSync.prototype.exec = exec;
		await rm(f.home, { recursive: true, force: true });
	}
});

test("failed legacy compaction rolls back data and schema version without erasure", async () => {
	const f = await diskFixture();
	const input = row(f.disk);
	assert.equal(f.disk.put(input, NOW), "stored");
	f.disk.db.exec("DROP INDEX usage_query_v1; UPDATE usage_rows SET data='invalid'; PRAGMA user_version=1");
	f.disk.close();
	try {
		assert.throws(() => new UsageHistoryDisk(f.file, NOW), /unavailable/);
		const db = new DatabaseSync(f.file);
		try {
			assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 1);
			assert.equal(db.prepare("SELECT data FROM usage_rows").get()!.data, "invalid");
			assert.equal(db.prepare("SELECT generation FROM usage_meta").get()!.generation, input.generation);
		} finally {
			db.close();
		}
	} finally {
		await rm(f.home, { recursive: true, force: true });
	}
});

test("duplicate/out-of-order revisions replace instead of incrementing and conflict visibly", async () => {
	const f = await diskFixture();
	try {
		const a = row(f.disk);
		assert.equal(f.disk.put(a, NOW), "stored");
		assert.equal(f.disk.put(a, NOW), "duplicate");
		assert.equal(f.disk.put({ ...a, revision: 1 }, NOW), "stale");
		assert.equal(f.disk.put({ ...a, requests: 5 }, NOW), "conflict");
		const corrected = { ...a, revision: 3, tokens: { ...a.tokens, input: 3 } };
		assert.equal(f.disk.put(corrected, NOW), "stored");
		assert.equal(f.disk.put({ ...corrected, revision: 4, kind: "checkpoint" }, NOW), "conflict");
		assert.equal(f.disk.status().retainedRows, 1);
		assert.equal(f.disk.status().conflicts, 2);
		assert.deepEqual(f.disk.page(QUERY, NOW).rows, [corrected]);
	} finally {
		await f.close();
	}
});

test("hot-path SQL statements are reused across parameters and released at close", async () => {
	const f = await diskFixture();
	try {
		const original = f.disk.db.prepare.bind(f.disk.db);
		let prepares = 0;
		f.disk.db.prepare = (...args) => {
			prepares++;
			return original(...args);
		};
		f.disk.put(row(f.disk), NOW);
		f.disk.page(QUERY, NOW);
		const warm = prepares;
		for (let i = 0; i < 100; i++) {
			f.disk.status();
			f.disk.put(row(f.disk, { operationId: `reuse:${i}` }), NOW);
			f.disk.page({ ...QUERY, limit: (i % 100) + 1 }, NOW);
		}
		assert.equal(prepares, warm, "parameter values must not allocate new native statements");
		const cache = (f.disk as unknown as { statements: Map<string, unknown> }).statements;
		assert.ok(cache.size > 0 && cache.size <= 16);
	} finally {
		await f.close();
	}
});

test("checkpoint, parent child total and actual child requests are separate nonadditive views", async () => {
	const f = await diskFixture();
	try {
		const direct = row(f.disk);
		const checkpoint = row(f.disk, { ...fixture.rows[1], generation: direct.generation });
		assert.equal(f.disk.put(direct, NOW), "stored");
		assert.equal(f.disk.put(checkpoint, NOW), "stored");
		const child = row(f.disk, { sourceId: OTHER, operationId: "child:request" });
		assert.equal(f.disk.put(child, NOW), "stored");
		assert.equal(f.disk.put(child, NOW), "duplicate"); // forwarded child evidence retains identity
		assert.equal(f.disk.put({ ...child, operationId: "bad-parent", scope: "child" }, NOW), "rejected");
		assert.equal(f.disk.page(QUERY, NOW).rows.length, 2);
		assert.equal(f.disk.page({ ...QUERY, kind: "checkpoint" }, NOW).rows.length, 1);
	} finally {
		await f.close();
	}
});

test("UTC half-open windows, stable keyset pages and bounded query validation", async () => {
	const f = await diskFixture();
	try {
		const day = Math.floor(NOW / USAGE_DAY_MS) * USAGE_DAY_MS;
		for (const [i, t] of [day - 1, day, day + 1, day + USAGE_DAY_MS].entries())
			assert.equal(
				f.disk.put(row(f.disk, { operationId: `op:${i}`, completedAt: t, observedAt: t }), day + USAGE_DAY_MS),
				"stored",
			);
		const q: UsageHistoryQuery = { kind: "request", from: day, to: day + USAGE_DAY_MS, limit: 1 };
		const first = f.disk.page(q, day + USAGE_DAY_MS);
		assert.equal(first.rows[0]!.completedAt, day);
		assert.ok(first.next);
		const second = f.disk.page({ ...q, after: first.next }, day + USAGE_DAY_MS);
		assert.equal(second.rows[0]!.completedAt, day + 1);
		assert.equal(second.next, undefined);
		assert.throws(() => f.disk.page({ ...q, limit: 101 }, NOW));
		assert.throws(() => f.disk.page({ ...q, to: day + 367 * USAGE_DAY_MS }, NOW));
		assert.throws(() => f.disk.page({ ...q, after: "broken" }, NOW));
		assert.throws(() => f.disk.page({ ...q, to: q.to + 1, after: first.next }, NOW));
		const plan = JSON.stringify(
			f.disk.db
				.prepare(
					"EXPLAIN QUERY PLAN SELECT data FROM usage_rows WHERE kind=? AND completed>=? AND completed<? ORDER BY completed,source,operation LIMIT 100",
				)
				.all("request", day, day + USAGE_DAY_MS),
		);
		assert.match(plan, /usage_time/);
		assert.doesNotMatch(plan, /SCAN usage_rows/);
	} finally {
		await f.close();
	}
});

test("retention floor persists, stale replay cannot resurrect expired evidence and reads do not write", async () => {
	const f = await diskFixture();
	try {
		const input = row(f.disk);
		f.disk.put(input, NOW);
		const later = NOW + USAGE_RETENTION_MS + 1;
		assert.equal(f.disk.page(QUERY, later).rows.length, 0);
		assert.equal(f.disk.status().retainedRows, 1, "read did not perform erasure");
		f.disk.expire(later);
		assert.equal(f.disk.status().expired, 1);
		assert.equal(f.disk.put(input, NOW), "rejected", "backward clock cannot lower floor");
		assert.equal(
			f.disk.put({ ...input, revision: 3, observedAt: later }, later),
			"rejected",
			"old completion stays old",
		);
		assert.equal(f.disk.status().retainedRows, 0);
	} finally {
		await f.close();
	}
});

test("capacity rejects rather than evicts replay identities, but allows replacements", async () => {
	const f = await diskFixture({ maxRows: 1 });
	try {
		const input = row(f.disk);
		assert.equal(f.disk.put(input, NOW), "stored");
		assert.equal(f.disk.put({ ...input, operationId: "second" }, NOW), "rejected");
		assert.equal(f.disk.put({ ...input, revision: 3 }, NOW), "stored");
		assert.equal(f.disk.status().rejected, 1);
		assert.equal(f.disk.status().retainedRows, 1);
	} finally {
		await f.close();
	}
});

test("database byte cap rolls back failed inserts without losing committed rows", async () => {
	const f = await diskFixture({ maxBytes: 65536 });
	try {
		const input = row(f.disk);
		let stored = 0;
		for (let i = 0; i < 200; i++) {
			const result = f.disk.put({ ...input, operationId: `bytes:${i}` }, NOW);
			if (result === "rejected") break;
			assert.equal(result, "stored");
			stored++;
		}
		assert.ok(stored > 0 && stored < 200);
		assert.equal(f.disk.status().retainedRows, stored);
		assert.equal(Number(f.disk.db.prepare("SELECT COUNT(*) AS count FROM usage_rows").get()!.count), stored);
		assert.ok((await stat(f.file)).size <= 65536);
		assert.equal(f.disk.put({ ...input, operationId: "bytes:0" }, NOW), "duplicate");
	} finally {
		await f.close();
	}
});

test("corrupt oversized row payload is rejected before materializing JSON on read", async () => {
	const f = await diskFixture();
	try {
		const input = row(f.disk);
		f.disk.put(input, NOW);
		// The covering index rejects malformed JSON. Drop it only to simulate externally
		// corrupted/pre-index storage and exercise the bounded page reader.
		assert.throws(() => f.disk.db.prepare("UPDATE usage_rows SET data=?").run("x".repeat(100000)));
		f.disk.db.exec("DROP INDEX usage_query_v1");
		f.disk.db.prepare("UPDATE usage_rows SET data=?").run("x".repeat(100000));
		assert.throws(() => f.disk.page(QUERY, NOW), /row unavailable/);
	} finally {
		await f.close();
	}
});

test("reject content, unsafe numbers, unknown fields, malformed provenance and invented bills", async () => {
	const f = await diskFixture();
	try {
		const input = row(f.disk);
		for (const bad of [
			{ ...input, prompt: "private" },
			{ ...input, physicalModel: { provider: "https://secret.example?q=token", model: "x" } },
			{ ...input, tokens: { ...input.tokens, input: Number.MAX_SAFE_INTEGER + 1 } },
			{ ...input, tokens: { ...input.tokens, input: 0.1 } },
			{ ...input, tokens: { ...input.tokens, input: NaN } },
			{ ...input, tokens: { ...input.tokens, reasoning: 10000 } },
			{ ...input, cost: { ...input.cost, billedStatus: "known", billedUsdMicros: 1 } },
			{ ...input, attribution: { chatId: "title-not-id" } },
			{ ...input, revision: 0 },
			{ ...input, physicalModel: { provider: "example", model: "x".repeat(100000) } },
			{ ...input, completedAt: undefined },
			{ ...input, observedAt: NOW + 1 },
		])
			assert.equal(f.disk.put(bad, NOW), "rejected");
		assert.equal(f.disk.status().retainedRows, 0);
		assert.ok(f.disk.status().rejected >= 12);
	} finally {
		await f.close();
	}
});

test("delete and clear fence stale writers, preserve unrelated rows and invalidate cursors", async () => {
	const f = await diskFixture();
	try {
		const a = row(f.disk);
		const b = { ...a, sourceId: OTHER, attribution: { chatId: OTHER } };
		f.disk.put(a, NOW);
		f.disk.put(b, NOW);
		const page = f.disk.page({ ...QUERY, limit: 1 }, NOW);
		assert.ok(page.next);
		const erased = f.disk.erase(CHAT, NOW);
		assert.notEqual(erased.generation, a.generation);
		assert.equal(f.disk.put(a, NOW), "rejected");
		assert.equal(f.disk.put({ ...a, generation: erased.generation }, NOW), "rejected");
		assert.deepEqual(f.disk.page(QUERY, NOW).rows, [b]);
		assert.throws(() => f.disk.page({ ...QUERY, limit: 1, after: page.next }, NOW));
		const cleared = f.disk.erase(undefined, NOW + 1);
		assert.equal(cleared.retainedRows, 0);
		assert.equal(f.disk.put({ ...b, generation: cleared.generation }, NOW + 1), "rejected");
		assert.equal(
			f.disk.put({ ...b, generation: cleared.generation, observedAt: NOW + 2, completedAt: NOW + 2 }, NOW + 2),
			"stored",
		);
	} finally {
		await f.close();
	}
});

test("corrupt, oversize, unknown schema and symlinked databases fail closed unchanged", async () => {
	const home = await mkdtemp(join(tmpdir(), "usage-corrupt-"));
	try {
		const file = join(home, "accounting.sqlite");
		await writeFile(file, "not a database");
		assert.throws(() => new UsageHistoryDisk(file, NOW));
		assert.equal(await readFile(file, "utf8"), "not a database");
		await rm(file);
		const db = new DatabaseSync(file);
		db.exec("PRAGMA user_version=99");
		db.close();
		assert.throws(() => new UsageHistoryDisk(file, NOW));
		const check = new DatabaseSync(file);
		assert.equal(check.prepare("PRAGMA user_version").get()!.user_version, 99);
		check.close();
		await rm(file);
		await writeFile(file, Buffer.alloc(65537));
		assert.throws(() => new UsageHistoryDisk(file, NOW, { maxBytes: 65536 }));
		await rm(file);
		const target = join(home, "target");
		await writeFile(target, "untouched");
		await symlink(target, file);
		assert.throws(() => new UsageHistoryDisk(file, NOW));
		assert.equal(await readFile(target, "utf8"), "untouched");
	} finally {
		await chmod(home, 0o700).catch(() => {});
		await rm(home, { recursive: true, force: true });
	}
});

test("worker queue is bounded, maintenance coalesces and close drains while refusing new writes", async () => {
	const home = await mkdtemp(join(tmpdir(), "usage-worker-"));
	const store = new UsageHistoryStore(home, () => NOW);
	try {
		const results = await Promise.allSettled(Array.from({ length: 40 }, () => store.status()));
		assert.equal(results.filter((r) => r.status === "rejected").length, 8);
		const status = await store.status();
		assert.equal(status.queueOverflows, 8);
		const input = { ...fixture.rows[0]!, generation: status.generation };
		assert.equal(await store.put({ ...input, prompt: "x".repeat(1_000_000) } as UsageObservation), "rejected");
		const writing = store.put(input);
		const closing = store.close();
		await assert.rejects(store.put(input), /unavailable/);
		assert.equal(await writing, "stored");
		await closing;
		const reopened = new UsageHistoryStore(home, () => NOW);
		try {
			assert.equal(await reopened.put(input), "duplicate");
			const a = reopened.expire();
			const b = reopened.expire();
			assert.equal(a, b);
			await a;
		} finally {
			await reopened.close();
		}
	} finally {
		await store.close();
		await rm(home, { recursive: true, force: true });
	}
});

test("worker fault and rejected message cloning release the shutdown drain", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "usage-drain-"));
	const store = new UsageHistoryStore(home, () => NOW);
	try {
		const status = await store.status();
		await assert.rejects(store.page({ ...QUERY, from: (() => 0) as unknown as number }), /Invalid usage value/);
		const worker = (store as unknown as { worker: import("node:worker_threads").Worker }).worker;
		const failedClone = t.mock.method(worker, "postMessage", () => {
			throw new Error("synthetic clone failure");
		});
		await assert.rejects(store.status(), /Invalid usage message/);
		failedClone.mock.restore();
		const calls = Array.from({ length: 10 }, (_, i) =>
			store.put({ ...fixture.rows[0]!, generation: status.generation, operationId: `drain:${i}` }),
		);
		const settled = Promise.allSettled(calls);
		const closing = store.close();
		await worker.terminate();
		await settled;
		await closing;
		assert.equal((store as unknown as { pending: Map<number, unknown> }).pending.size, 0);
		await assert.rejects(store.status(), /unavailable/);
	} finally {
		await store.close();
		await rm(home, { recursive: true, force: true });
	}
});

test("compatibility migration is undated, idempotent and cannot resurrect cleared history", async () => {
	const home = await mkdtemp(join(tmpdir(), "usage-legacy-"));
	const store = new UsageHistoryStore(home, () => NOW);
	const scope = {
		tokens: fixture.rows[0]!.tokens!,
		cost: fixture.rows[0]!.cost!,
		activity: {
			kind: "model_requests" as const,
			count: 1,
			success: 1,
			failure: 0,
			cancelled: 0,
			usageReports: 1,
			providerAttemptsObserved: 1,
			requestRetriesObserved: 0,
			elapsedMsObserved: 1,
			activeMsObserved: 1,
			outcomeCoverage: "partial" as const,
			timingCoverage: "partial" as const,
		},
	};
	const summary: AIUsageAccounting = {
		observedAt: NOW,
		direct: scope,
		child: { ...scope, activity: { ...scope.activity, kind: "child_operations" } },
		time: { elapsedMs: 1, activeMs: 1, pausedMs: 0, idleMs: 0, coverage: "daemon_observed_partial" },
	};
	try {
		await store.importLegacy(CHAT, summary);
		await store.importLegacy(CHAT, summary);
		const p = await store.page({ ...QUERY, kind: "checkpoint" });
		assert.equal(p.rows.length, 2);
		assert.ok(p.rows.every((r) => r.completedAt === undefined && r.physicalModel === undefined));
		assert.equal((await store.page(QUERY)).rows.length, 0);
		await store.clear();
		await store.importLegacy(CHAT, summary);
		assert.equal((await store.status()).retainedRows, 0);
		await store.importLegacy(CHAT, { ...summary, observedAt: NOW + 100 });
		assert.equal(
			(await store.status()).retainedRows,
			0,
			"advancing a cumulative summary cannot resurrect erased totals",
		);
	} finally {
		await store.close();
		await rm(home, { recursive: true, force: true });
	}
});

test("crash before commit rolls back, crash after commit/lost acknowledgement replays once", async () => {
	for (const committed of [false, true]) {
		const f = await diskFixture();
		const input = row(f.disk);
		f.disk.close();
		try {
			const child = spawn(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					`
const { UsageHistoryDisk } = await import(${JSON.stringify(new URL("./usage-history-disk.ts", import.meta.url).href)});
const disk = new UsageHistoryDisk(${JSON.stringify(f.file)}, ${NOW});
const row = ${JSON.stringify(input)};
if (${committed}) disk.put(row,${NOW});
else { disk.db.exec('BEGIN IMMEDIATE'); disk.db.prepare('UPDATE usage_meta SET rows=99 WHERE id=1').run(); }
process.send('boundary');
setInterval(()=>{},1000);
`,
				],
				{ stdio: ["ignore", "ignore", "pipe", "ipc"] },
			);
			let errors = "";
			child.stderr!.on("data", (chunk) => {
				errors += chunk;
			});
			try {
				await Promise.race([
					once(child, "message"),
					once(child, "exit").then(() => {
						throw new Error(errors);
					}),
				]);
			} finally {
				child.kill("SIGKILL");
				await once(child, "exit");
			}
			const recovered = new UsageHistoryDisk(f.file, NOW);
			try {
				assert.equal(recovered.status().retainedRows, committed ? 1 : 0);
				assert.equal(recovered.put(input, NOW), committed ? "duplicate" : "stored");
				assert.equal(recovered.page(QUERY, NOW).rows.length, 1);
			} finally {
				recovered.close();
			}
		} finally {
			await rm(f.home, { recursive: true, force: true });
		}
	}
});
