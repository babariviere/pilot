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
		assert.equal(f.disk.db.prepare("PRAGMA user_version").get()!.user_version, 1);
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

test("worker fault and rejected message cloning release the shutdown drain", async () => {
	const home = await mkdtemp(join(tmpdir(), "usage-drain-"));
	const store = new UsageHistoryStore(home, () => NOW);
	try {
		const status = await store.status();
		await assert.rejects(store.page({ ...QUERY, from: (() => 0) as unknown as number }), /Invalid usage message/);
		const calls = Array.from({ length: 10 }, (_, i) =>
			store.put({ ...fixture.rows[0]!, generation: status.generation, operationId: `drain:${i}` }),
		);
		const settled = Promise.allSettled(calls);
		const worker = (store as unknown as { worker: import("node:worker_threads").Worker }).worker;
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
