// Offscreen faux retained-history probe. Seed and measure in separate credential-free processes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const [mode, source = "packages/daemon/src", home] = process.argv.slice(2);
const now = 1792530001000;
const day = 86400000;
const sourceId = "22222222-2222-4222-8222-222222222222";
const mission = { homeId: sourceId, lineageId: sourceId, missionId: sourceId };
function row(generation, i) {
	const checkpoint = i % 10 === 0;
	return {
		schemaVersion: 1,
		generation,
		sourceId,
		operationId: `r:${String(i).padStart(5, "0")}`,
		revision: 1,
		kind: checkpoint ? "checkpoint" : "request",
		scope: "direct",
		observedAt: now,
		...(checkpoint ? {} : { completedAt: now - (i % 29) * day }),
		coverage: i % 7 === 0 ? "partial" : "committed",
		purpose: i % 2 === 0 ? "title" : "agent",
		attribution: { mission },
		physicalModel: { provider: "faux", model: `m${i % 4}` },
		...(i % 7 === 0
			? {}
			: {
					tokens: { input: 100, output: 20, cacheRead: 80, cacheWrite: 0, reasoningStatus: "unavailable" },
					cost: {
						estimateStatus: "catalog_estimate",
						estimatedUsdMicros: 12,
						pricingRevision: "faux-v1",
						billedStatus: "unavailable",
						subscriptionCoverage: "unknown",
					},
				}),
	};
}
if (!mode) {
	const sources = process.argv.slice(2);
	assert.equal(sources.length, 0);
	for (const [label, directory] of [
		["baseline", process.env.USAGE_QUERY_BASELINE],
		["candidate", process.env.USAGE_QUERY_CANDIDATE ?? "packages/daemon/src"],
	]) {
		if (!directory) continue;
		const home = await mkdtemp(join(tmpdir(), "usage-query-probe-"));
		try {
			const env = { PATH: process.env.PATH, HOME: home, PI_OFFLINE: "1" };
			for (const phase of ["seed", "run"]) {
				const result = spawnSync(process.execPath, [process.argv[1], phase, directory, home], {
					env,
					encoding: "utf8",
					timeout: 120000,
					maxBuffer: 1024 * 1024,
				});
				assert.equal(result.status, 0, result.stderr);
				if (phase === "run") console.log(JSON.stringify({ label, ...JSON.parse(result.stdout) }));
			}
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	}
} else if (mode === "seed") {
	const { UsageHistoryDisk } = await import(pathToFileURL(resolve(source, "usage-history-disk.ts")));
	const disk = new UsageHistoryDisk(join(home, "accounting", "usage-history.sqlite"), now);
	try {
		const generation = disk.status().generation;
		const insert = disk.db.prepare("INSERT INTO usage_rows VALUES(?,?,?,?,?,?,?,?,?)");
		disk.db.exec("BEGIN");
		for (let i = 0; i < 50000; i++) {
			const r = row(generation, i);
			insert.run(
				sourceId,
				r.operationId,
				1,
				r.kind,
				r.scope,
				r.completedAt ?? 0,
				Math.min(now, r.completedAt ?? now),
				null,
				JSON.stringify(r),
			);
		}
		disk.db.exec("UPDATE usage_meta SET rows=50000; COMMIT");
	} finally {
		disk.close();
	}
} else if (mode === "run") {
	const { UsageHistoryStore } = await import(pathToFileURL(resolve(source, "usage-history.ts")));
	const store = new UsageHistoryStore(home, () => now);
	try {
		const status = await store.status(); // cold worker startup excluded, same in each variant
		const histogram = monitorEventLoopDelay({ resolution: 1 });
		histogram.enable();
		const cpu = process.cpuUsage();
		const timings = {};
		const bytes = {};
		const base = { version: 1, from: now - 30 * day, to: now + 1, view: "summary" };
		const cases = { page: { kind: "request", from: base.from, to: base.to, limit: 100 } };
		if (store.analytics)
			Object.assign(cases, {
				summary: base,
				breakdown: { ...base, view: "breakdown", dimension: "physicalModel" },
				buckets: { ...base, view: "buckets", bucketMs: day },
			});
		let writes = 0;
		for (const [name, q] of Object.entries(cases)) {
			const samples = [];
			for (let i = 0; i < 12; i++) {
				const start = performance.now();
				// One replacement write is queued alongside each query, like incoming streamed evidence.
				const write = store.put({ ...row(status.generation, 1), revision: ++writes + 1 });
				const result = await (name === "page" ? store.page(q) : store.analytics(q));
				samples.push(performance.now() - start);
				bytes[name] = Math.max(bytes[name] ?? 0, Buffer.byteLength(JSON.stringify(result)));
				await write;
			}
			samples.sort((a, b) => a - b);
			timings[name] = { medianMs: samples[6], p95Ms: samples[11] };
		}
		histogram.disable();
		console.log(
			JSON.stringify({
				rows: status.retainedRows,
				samples: 12,
				timings,
				bytes,
				eventLoopP99Ms: histogram.percentile(99) / 1e6,
				processCpuMs: Object.values(process.cpuUsage(cpu)).reduce((a, b) => a + b, 0) / 1000,
				processPeakRssKiB: process.resourceUsage().maxRSS,
				environmentKeys: Object.keys(process.env).sort(),
				note: "worker-startup excluded from timings; process CPU/RSS include the worker thread, not an installed daemon or D6 gate pass",
			}),
		);
	} finally {
		await store.close();
	}
} else throw new Error("Invalid probe mode");
