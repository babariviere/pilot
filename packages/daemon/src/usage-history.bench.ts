/** Offscreen/faux only: node packages/daemon/src/usage-history.bench.ts. Never opens real Pilot data. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import type { UsageObservation } from "@pilot/protocol";
import { UsageHistoryStore } from "./usage-history.ts";
import { UsageHistoryDisk } from "./usage-history-disk.ts";
import { USAGE_DAY_MS } from "./usage-history-validation.ts";

const SOURCE = "11111111-1111-4111-8111-111111111111";
function evidence(generation: string, now: number, i: number, revision = 1): UsageObservation {
	return {
		schemaVersion: 1,
		generation,
		sourceId: SOURCE,
		operationId: `seed:${i.toString().padStart(6, "0")}`,
		revision,
		kind: "request",
		scope: "direct",
		observedAt: now,
		completedAt: now - (50000 - i) * 100,
		coverage: "committed",
		purpose: "agent",
		requests: 1,
		tokens: { input: 10, output: 5, cacheRead: 20, cacheWrite: 0, reasoningStatus: "unavailable" },
		cost: { estimateStatus: "unavailable", billedStatus: "unavailable", subscriptionCoverage: "unknown" },
	};
}

if (!isMainThread) {
	// Setup is intentionally outside measurements and off the measured event loop.
	const disk = new UsageHistoryDisk(join(workerData.home, "accounting", "usage-history.sqlite"), workerData.now);
	const generation = disk.status().generation;
	disk.db.exec("BEGIN IMMEDIATE");
	const insert = disk.db.prepare("INSERT INTO usage_rows VALUES(?,?,?,?,?,?,?,?,?)");
	for (let i = 0; i < 50000; i++) {
		const row = evidence(generation, workerData.now, i);
		insert.run(
			row.sourceId,
			row.operationId,
			row.revision,
			row.kind,
			row.scope,
			row.completedAt!,
			row.completedAt!,
			null,
			JSON.stringify(row),
		);
	}
	disk.db.exec("UPDATE usage_meta SET rows=50000 WHERE id=1; COMMIT");
	disk.close();
	parentPort!.postMessage("seeded");
} else {
	const now = Date.now();
	const home = await mkdtemp(join(tmpdir(), "usage-bench-"));
	const store = new UsageHistoryStore(home, () => now);
	try {
		await new Promise<void>((resolve, reject) => {
			const seed = new Worker(new URL(import.meta.url), { workerData: { home, now } });
			seed.on("error", reject);
			seed.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("Seed failed"))));
		});
		const histogram = monitorEventLoopDelay({ resolution: 10 });
		histogram.enable();
		await new Promise((resolve) => setTimeout(resolve, 200));
		const baseline = { rss: process.memoryUsage().rss, eventLoopP99Ms: histogram.percentile(99) / 1e6 };
		const status = await store.status();
		assert.equal(status.retainedRows, 50000);
		histogram.reset();
		const cpu = process.cpuUsage();
		const start = performance.now();
		let peakRss = process.memoryUsage().rss;
		const sample = setInterval(() => {
			peakRss = Math.max(peakRss, process.memoryUsage().rss);
		}, 10);
		const queries: number[] = [];
		let maxBytes = 0;
		for (let i = 0; i < 200; i++) {
			const before = performance.now();
			const page = await store.page({ kind: "request", from: now - USAGE_DAY_MS, to: now, limit: 100 });
			queries.push(performance.now() - before);
			assert.equal(page.rows.length, 100);
			maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(page)));
		}
		for (let i = 0; i < 500; i++) assert.equal(await store.put(evidence(status.generation, now, i, 2)), "stored");
		clearInterval(sample);
		histogram.disable();
		const used = process.cpuUsage(cpu);
		queries.sort((a, b) => a - b);
		console.log(
			JSON.stringify(
				{
					retainedRows: 50000,
					querySamples: queries.length,
					replacementWrites: 500,
					pageP95Ms: queries[Math.floor(queries.length * 0.95)],
					maxResponseBytes: maxBytes,
					baselineEventLoopP99Ms: baseline.eventLoopP99Ms,
					eventLoopP99Ms: histogram.percentile(99) / 1e6,
					peakRssDeltaMiB: (peakRss - baseline.rss) / 1024 / 1024,
					cpuMs: (used.user + used.system) / 1000,
					elapsedMs: performance.now() - start,
				},
				null,
				2,
			),
		);
	} finally {
		await store.close();
		await rm(home, { recursive: true, force: true });
	}
}
