import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { UsageAnalyticsQuery, UsageAnalyticsResult, UsageObservation } from "@pilot/protocol";
import { UsageHistoryStore } from "./usage-history.ts";
import { UsageHistoryDisk } from "./usage-history-disk.ts";
import { USAGE_DAY_MS as DAY, usageAnalyticsQuery } from "./usage-history-validation.ts";

const fixture = JSON.parse(
	await readFile(new URL("../../protocol/fixtures/usage-history.json", import.meta.url), "utf8"),
);
const original = fixture.rows[0] as UsageObservation;
const NOW = original.observedAt;
const FROM = Math.floor(NOW / DAY) * DAY;
const base: UsageAnalyticsQuery = { version: 1, from: FROM, to: FROM + DAY, view: "summary" };
const OTHER = "99999999-9999-4999-8999-999999999999";

async function setup() {
	const home = await mkdtemp(join(tmpdir(), "usage-queries-"));
	const disk = new UsageHistoryDisk(join(home, "accounting", "usage-history.sqlite"), NOW);
	const row = (operationId: string, changes: Partial<UsageObservation> = {}): UsageObservation => ({
		...structuredClone(original),
		generation: disk.status().generation,
		operationId,
		...changes,
	});
	return {
		home,
		disk,
		row,
		close: async () => {
			disk.close();
			await rm(home, { recursive: true, force: true });
		},
	};
}

test("SQL totals, every drill-down and UTC buckets reconcile without checkpoint overlap", async () => {
	const f = await setup();
	try {
		for (let i = 0; i < 6; i++)
			assert.equal(
				f.disk.put(f.row(`req:${i}`, { completedAt: FROM + i, purpose: i % 2 ? "title" : "agent" }), NOW),
				"stored",
			);
		assert.equal(f.disk.put(f.row("lower", { completedAt: FROM - 1 }), NOW), "stored");
		assert.equal(
			f.disk.put(f.row("upper", { completedAt: FROM + DAY, observedAt: FROM + DAY }), FROM + DAY),
			"stored",
		);
		f.disk.put(
			f.row("parent", { kind: "checkpoint", scope: "child", completedAt: undefined, coverage: "legacy" }),
			NOW,
		);
		f.disk.put(
			f.row("lost", {
				kind: "checkpoint",
				completedAt: undefined,
				coverage: "partial",
				tokens: undefined,
				cost: undefined,
				requests: undefined,
			}),
			NOW,
		);
		const summary = f.disk.analytics(base, NOW);
		assert.equal(summary.total.records, 6);
		assert.equal(summary.total.metrics.input.value, 600);
		assert.equal(summary.reconciliation.records, 2);
		assert.equal(summary.reconciliation.metrics.input.known, 1);
		assert.equal(summary.reconciliation.metrics.input.unknown, 1);
		assert.equal(summary.reconciliation.metrics.input.value, undefined);
		assert.equal(summary.reconciliation.metrics.estimatedUsdMicros.value, undefined);
		for (const dimension of [
			"project",
			"mission",
			"chat",
			"purpose",
			"physicalModel",
			"virtualPolicy",
			"scope",
		] as const) {
			const result = f.disk.analytics({ ...base, view: "breakdown", dimension }, NOW);
			assert.equal(
				result.groups.reduce((n, g) => n + g.aggregate.records, 0),
				6,
				dimension,
			);
			assert.equal(
				result.groups.reduce((n, g) => n + g.aggregate.metrics.input.value!, 0),
				600,
				dimension,
			);
			assert.deepEqual(result.total, summary.total);
		}
		const buckets = f.disk.analytics({ ...base, view: "buckets", bucketMs: DAY }, NOW);
		assert.deepEqual(
			buckets.groups.map((g) => Number(g.key)),
			[FROM],
		);
		assert.deepEqual(buckets.groups[0]!.aggregate, summary.total);
		// No undated operation gets a fabricated date, zero amount or additive request.
		assert.equal(
			f.disk.put(f.row("bad-undated", { completedAt: undefined, tokens: undefined, cost: undefined }), NOW),
			"rejected",
		);
		const empty = f.disk.analytics(
			{ ...base, from: FROM + DAY * 2, to: FROM + DAY * 3, view: "buckets", bucketMs: DAY },
			NOW,
		);
		assert.equal(empty.groups.length, 0);
		assert.equal(empty.total.metrics.input.value, undefined);
		assert.equal(empty.reconciliation.records, 2);
	} finally {
		await f.close();
	}
});

test("per-class unknown/partial/unpriced coverage survives all aggregates and raw drill-down", async () => {
	const f = await setup();
	try {
		f.disk.put(f.row("known"), NOW);
		f.disk.put(
			f.row("unknown", {
				coverage: "partial",
				tokens: undefined,
				cost: undefined,
				requests: undefined,
				providerAttempts: undefined,
				retries: undefined,
				durationMs: undefined,
			}),
			NOW,
		);
		f.disk.put(
			f.row("partial", {
				tokens: { ...original.tokens!, reasoningStatus: "partial" },
				cost: { ...original.cost!, estimateStatus: "partial_catalog_estimate", pricingRevision: "older" },
			}),
			NOW,
		);
		for (const query of [
			base,
			{ ...base, view: "breakdown" as const, dimension: "purpose" as const },
			{ ...base, view: "buckets" as const, bucketMs: DAY as 86400000 },
		]) {
			const result = f.disk.analytics(query, NOW);
			for (const a of [result.total, ...result.groups.map((g) => g.aggregate)]) {
				assert.equal(a.records, 3);
				assert.equal(a.unpriced, 1);
				assert.equal(a.partialPriced, 1);
				assert.equal(a.pricingVersions, 2);
				for (const key of [
					"input",
					"output",
					"cacheRead",
					"cacheWrite",
					"reasoning",
					"estimatedUsdMicros",
					"requests",
					"providerAttempts",
					"retries",
					"durationMs",
				] as const) {
					assert.equal(a.metrics[key].known, 2, key);
					assert.equal(a.metrics[key].unknown, 1, key);
				}
				assert.equal(a.metrics.reasoning.partial, 1);
				assert.equal(a.metrics.estimatedUsdMicros.partial, 1);
				assert.equal(a.metrics.billedUsdMicros.unknown, 3);
				assert.equal(a.metrics.billedUsdMicros.value, undefined);
			}
		}
		const rows = f.disk.page({ kind: "request", from: base.from, to: base.to }, NOW).rows;
		assert.equal(rows.find((r) => r.operationId === "unknown")!.tokens, undefined);
	} finally {
		await f.close();
	}
});

test("exact filters, canonical mission tuple and explicit unattributed drill-down never use host aliases", async () => {
	const f = await setup();
	try {
		f.disk.put(f.row("one"), NOW);
		f.disk.put(
			f.row("unknown", {
				attribution: undefined,
				physicalModel: undefined,
				virtualModel: undefined,
				virtualRevision: undefined,
			}),
			NOW,
		);
		f.disk.put(
			f.row("different-home", {
				attribution: { ...original.attribution, mission: { ...original.attribution!.mission!, homeId: OTHER } },
			}),
			NOW,
		);
		for (const filters of [
			{ projectId: original.attribution!.projectId!.toUpperCase() },
			{ chatId: original.attribution!.chatId },
			{ purpose: "agent" as const },
			{ physicalModel: original.physicalModel },
			{ virtualModel: original.virtualModel, virtualRevision: original.virtualRevision },
		]) {
			const result = f.disk.analytics({ ...base, filters }, NOW);
			const page = f.disk.page({ kind: "request", from: base.from, to: base.to, filters }, NOW);
			assert.equal(result.total.records, page.rows.length);
		}
		const filters = {
			mission: { ...original.attribution!.mission!, homeId: original.attribution!.mission!.homeId.toUpperCase() },
		};
		assert.equal(f.disk.analytics({ ...base, filters }, NOW).total.records, 1);
		assert.equal(
			f.disk.page({ kind: "request", from: base.from, to: base.to, filters }, NOW).rows[0]!.operationId,
			"one",
		);
		const missing = {
			missing: ["project", "mission", "chat", "physicalModel", "virtualPolicy", "virtualRevision"] as const,
		};
		assert.equal(f.disk.analytics({ ...base, filters: { missing: [...missing.missing] } }, NOW).total.records, 1);
		assert.equal(
			f.disk.page({ kind: "request", from: base.from, to: base.to, filters: { missing: [...missing.missing] } }, NOW)
				.rows[0]!.operationId,
			"unknown",
		);
		const groups = f.disk.analytics({ ...base, view: "breakdown", dimension: "mission" }, NOW).groups;
		assert.equal(groups.length, 3);
		assert.ok(groups.some((g) => g.key === "null"));
	} finally {
		await f.close();
	}
});

test("keyset pages bind filters/view/erasure, stay bounded and preserve non-incremental corrections", async () => {
	const f = await setup();
	try {
		for (let i = 0; i < 105; i++)
			f.disk.put(
				f.row(`r:${String(i).padStart(3, "0")}`, {
					physicalModel: { provider: "faux", model: `m${String(i).padStart(3, "0")}` },
				}),
				NOW,
			);
		const query: UsageAnalyticsQuery = { ...base, view: "breakdown", dimension: "physicalModel", limit: 10 };
		let next: string | undefined;
		const keys = new Set<string>();
		do {
			const result = f.disk.analytics({ ...query, ...(next ? { after: next } : {}) }, NOW);
			assert.ok(Buffer.byteLength(JSON.stringify(result)) < 512 * 1024);
			assert.ok(result.groups.length <= 10);
			assert.equal(result.total.records, 105);
			for (const g of result.groups) {
				assert.ok(!keys.has(g.key));
				keys.add(g.key);
			}
			next = result.next;
			assert.equal(result.truncated, Boolean(next));
		} while (next);
		assert.equal(keys.size, 105);
		const cursor = f.disk.analytics(query, NOW).next!;
		assert.throws(() => f.disk.analytics({ ...query, after: cursor, filters: { purpose: "title" } }, NOW));
		assert.throws(() => f.disk.analytics({ ...query, after: cursor, dimension: "purpose" }, NOW));
		const raw = f.disk.page({ kind: "request", from: base.from, to: base.to, limit: 100 }, NOW);
		assert.equal(raw.rows.length, 100);
		assert.equal(f.disk.page({ kind: "request", from: base.from, to: base.to, after: raw.next }, NOW).rows.length, 5);
		assert.throws(() =>
			f.disk.page(
				{ kind: "request", from: base.from, to: base.to, after: raw.next, filters: { purpose: "title" } },
				NOW,
			),
		);
		const correction = f.row("r:000", {
			revision: 3,
			tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoningStatus: "unavailable" },
		});
		assert.equal(f.disk.put(correction, NOW), "stored");
		assert.equal(f.disk.put(correction, NOW), "duplicate");
		assert.equal(f.disk.put({ ...correction, revision: 2 }, NOW), "stale");
		assert.equal(f.disk.analytics(base, NOW).total.metrics.input.value, 10401);
		f.disk.erase(undefined, NOW);
		assert.throws(() => f.disk.analytics({ ...query, after: cursor }, NOW));
		assert.equal(f.disk.analytics(base, NOW).total.records, 0);
	} finally {
		await f.close();
	}
});

test("safe sums expose overflow, and strict resource budgets reject invalid queries", async () => {
	const f = await setup();
	try {
		for (let i = 0; i < 2; i++)
			f.disk.put(
				f.row(`overflow:${i}`, {
					tokens: {
						input: Number.MAX_SAFE_INTEGER,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						reasoningStatus: "unavailable",
					},
				}),
				NOW,
			);
		const m = f.disk.analytics(base, NOW).total.metrics.input;
		assert.equal(m.overflow, true);
		assert.equal(m.value, undefined);
		assert.equal(m.known, 2);
		for (const change of [
			{ version: 2 },
			{ from: -1 },
			{ from: 1.5 },
			{ to: base.from },
			{ to: base.from + 367 * DAY },
			{ limit: 101 },
			{ limit: 0 },
			{ view: "buckets", bucketMs: 1 },
			{ view: "buckets", bucketMs: 3600000, to: base.from + 20 * DAY },
			{ view: "breakdown", dimension: "sql" },
			{ dimension: "project" },
			{ after: "x".repeat(2049) },
			{ filters: { mission: { missionId: OTHER } } },
			{ filters: { physicalModel: { provider: "https://secret", model: "x" } } },
			{ filters: { hostId: OTHER } },
			{ filters: { missing: ["source"] } },
			{ prompt: "forbidden" },
		])
			assert.throws(() => usageAnalyticsQuery({ ...base, ...change }), JSON.stringify(change));
		const before = f.disk.db.prepare("SELECT total_changes() AS n").get();
		f.disk.analytics({ ...base, view: "breakdown", dimension: "project" }, NOW);
		assert.deepEqual(f.disk.db.prepare("SELECT total_changes() AS n").get(), before);
		const plan = f.disk.db
			.prepare(
				"EXPLAIN QUERY PLAN SELECT data FROM usage_rows INDEXED BY usage_time WHERE kind=? AND completed>=? AND completed<?",
			)
			.all("request", base.from, base.to);
		assert.match(JSON.stringify(plan), /SEARCH.*usage_time/);
	} finally {
		await f.close();
	}
});

test("real worker query RPC uses bounded ingress, erasure and shutdown without agent work", async () => {
	const home = await mkdtemp(join(tmpdir(), "usage-query-worker-"));
	const store = new UsageHistoryStore(home, () => NOW);
	try {
		const status = await store.status();
		await store.put({ ...original, generation: status.generation });
		const [one, two, rejected] = await Promise.allSettled([
			store.analytics(base),
			store.analytics(base),
			store.analytics(base),
		]);
		assert.equal(one.status, "fulfilled");
		assert.equal(two.status, "fulfilled");
		assert.equal(rejected.status, "rejected");
		assert.equal((await store.analytics(base)).total.records, 1);
		await store.clear();
		assert.equal((await store.analytics(base)).total.records, 0);
	} finally {
		await store.close();
		await rm(home, { recursive: true, force: true });
	}
	await assert.rejects(store.analytics(base), /unavailable/);
});

test("read-time retention excludes expired dated and undated evidence without maintenance writes", async () => {
	const f = await setup();
	try {
		f.disk.put(f.row("dated"), NOW);
		f.disk.put(
			f.row("undated", { kind: "checkpoint", completedAt: undefined, tokens: undefined, cost: undefined }),
			NOW,
		);
		const later = NOW + 30 * DAY + 1;
		const before = f.disk.db.prepare("SELECT total_changes() AS n").get();
		const result = f.disk.analytics(base, later);
		assert.equal(result.total.records, 0);
		assert.equal(result.reconciliation.records, 0);
		assert.equal(result.status.retentionFloor, later - 30 * DAY);
		assert.equal(result.total.metrics.input.value, undefined);
		assert.deepEqual(f.disk.db.prepare("SELECT total_changes() AS n").get(), before);
	} finally {
		await f.close();
	}
});

test("shared analytics DTO fixture keeps checkpoint values absent and unknown coverage explicit", async () => {
	const value: UsageAnalyticsResult = JSON.parse(
		await readFile(new URL("../../protocol/fixtures/usage-analytics.json", import.meta.url), "utf8"),
	);
	assert.equal(value.version, 1);
	assert.equal(value.total.metrics.input.unknown, 1);
	assert.equal(value.total.metrics.input.value, 100);
	assert.equal(value.reconciliation.metrics.input.value, undefined);
	assert.equal(value.reconciliation.metrics.input.unknown, 1);
});

test("covering index accelerates fixed SQL and full pre-index stores fall back without erasure or budget growth", async () => {
	const home = await mkdtemp(join(tmpdir(), "usage-index-capacity-"));
	const file = join(home, "accounting", "usage-history.sqlite");
	let disk = new UsageHistoryDisk(file, NOW, { maxBytes: 65536 });
	try {
		assert.ok(disk.db.prepare("SELECT 1 FROM sqlite_master WHERE name='usage_query_v1'").get());
		// Simulate a v1 store written by an older runtime before the optional covering index existed.
		disk.db.exec("DROP INDEX usage_query_v1");
		const generation = disk.status().generation;
		for (let i = 0; i < 1000; i++) {
			const result = disk.put({ ...original, generation, operationId: `capacity:${i}` }, NOW);
			if (result === "rejected") break;
		}
		const before = disk.status();
		assert.ok(before.retainedRows > 0 && before.rejected > 0);
		disk.close();
		disk = new UsageHistoryDisk(file, NOW, { maxBytes: 65536 });
		assert.equal(disk.status().generation, before.generation);
		assert.equal(disk.status().retainedRows, before.retainedRows);
		assert.equal(disk.db.prepare("SELECT 1 FROM sqlite_master WHERE name='usage_query_v1'").get(), undefined);
		assert.equal(disk.analytics(base, NOW).total.records, before.retainedRows);
		assert.equal(disk.analytics(base, NOW).total.metrics.input.value, before.retainedRows * 100);
		assert.equal(disk.db.prepare("PRAGMA max_page_count").get()!.max_page_count, 16);
	} finally {
		disk.close();
		await rm(home, { recursive: true, force: true });
	}
});
