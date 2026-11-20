/** Offscreen/faux only. Each sample is a fresh process; seeding never contaminates its allocator. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { UsageObservation } from "@pilot/protocol";
import { UsageHistoryStore } from "./usage-history.ts";
import { UsageHistoryDisk } from "./usage-history-disk.ts";
import { USAGE_DAY_MS } from "./usage-history-validation.ts";

const SOURCE = "11111111-1111-4111-8111-111111111111";
const CASES = ["none", "bare", "empty", "populated", "queries", "serialized_queries", "writes"] as const;
type Case = (typeof CASES)[number];
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
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const dbFile = (home: string) => join(home, "accounting", "usage-history.sqlite");

async function sample(kind: Case, home: string, now: number, batches: number, batchSize: number) {
	assert.ok(
		CASES.includes(kind) &&
			Number.isInteger(batches) &&
			batches > 0 &&
			batches <= 10 &&
			Number.isInteger(batchSize) &&
			batchSize > 0 &&
			batchSize <= 2000 &&
			batches * batchSize <= 10000,
	);
	const store = new UsageHistoryStore(home, () => now);
	let worker: Worker | undefined;
	const histogram = monitorEventLoopDelay({ resolution: 10 });
	histogram.enable();
	await wait(100);
	const baseline = process.memoryUsage();
	let peakRss = baseline.rss;
	const timer = setInterval(() => {
		peakRss = Math.max(peakRss, process.memoryUsage().rss);
	}, 5);
	const stages: unknown[] = [];
	async function snapshot(stage: string) {
		const memory = process.memoryUsage();
		peakRss = Math.max(peakRss, memory.rss);
		const heap = await worker?.getHeapStatistics();
		stages.push({
			stage,
			rssDeltaMiB: (memory.rss - baseline.rss) / 1024 / 1024,
			peakRssDeltaMiB: (peakRss - baseline.rss) / 1024 / 1024,
			mainHeapUsedMiB: memory.heapUsed / 1024 / 1024,
			workerHeapUsedMiB: heap ? heap.used_heap_size / 1024 / 1024 : undefined,
			workerHeapPhysicalMiB: heap ? heap.total_physical_size / 1024 / 1024 : undefined,
			workerExternalMiB: heap ? heap.external_memory / 1024 / 1024 : undefined,
		});
	}
	try {
		const baselineP99 = histogram.percentile(99) / 1e6;
		const started = performance.now();
		let generation = "";
		if (kind === "bare") {
			worker = new Worker(
				`const {parentPort}=require('node:worker_threads'); parentPort.on('message',()=>{}); parentPort.postMessage('ready');`,
				{ eval: true },
			);
			await once(worker, "message");
		} else if (kind !== "none") {
			generation = (await store.status()).generation;
			// Benchmark-only introspection; no production profiling RPC or diagnostic payload.
			worker = (store as unknown as { worker: Worker }).worker;
		}
		const startupMs = performance.now() - started;
		await snapshot("ready");
		histogram.reset();
		const cpu = process.cpuUsage();
		const queries: number[] = [];
		let maxResponseBytes = 0;
		for (let batch = 0; batch < batches; batch++) {
			if (kind === "queries" || kind === "serialized_queries") {
				for (let i = 0; i < batchSize; i++) {
					const start = performance.now();
					const page = await store.page({ kind: "request", from: now - USAGE_DAY_MS, to: now, limit: 100 });
					queries.push(performance.now() - start);
					assert.equal(page.rows.length, 100);
					if (kind === "serialized_queries")
						maxResponseBytes = Math.max(maxResponseBytes, Buffer.byteLength(JSON.stringify(page)));
				}
			} else if (kind === "writes") {
				for (let i = 0; i < batchSize; i++)
					assert.equal(await store.put(evidence(generation, now, i, batch + 2)), "stored");
			} else await wait(200);
			await snapshot(`batch:${batch + 1}`);
		}
		await wait(200);
		await snapshot("settled");
		const used = process.cpuUsage(cpu);
		const eventLoopP99Ms = histogram.percentile(99) / 1e6;
		queries.sort((a, b) => a - b);
		const activePeakRssDeltaMiB = (peakRss - baseline.rss) / 1024 / 1024;
		// A diagnostic retained-heap view, never substituted for the natural peak gate.
		globalThis.gc?.();
		await snapshot("main_gc_only");
		await store.close();
		if (kind === "bare") await worker!.terminate();
		worker = undefined;
		await wait(200);
		await snapshot("closed");
		return {
			kind,
			batches,
			batchSize,
			startupMs,
			baselineRssMiB: baseline.rss / 1024 / 1024,
			baselineP99,
			eventLoopP99Ms,
			activePeakRssDeltaMiB,
			queryP95Ms: queries.length ? queries[Math.floor(queries.length * 0.95)] : undefined,
			maxResponseBytes,
			cpuMs: (used.user + used.system) / 1000,
			stages,
		};
	} finally {
		clearInterval(timer);
		histogram.disable();
		await store.close();
		if (kind === "bare") await worker?.terminate();
	}
}

async function child(args: string[], home: string): Promise<string> {
	// Fixture isolation only: no agent-injected preload, broker handles, real HOME or provider keys.
	// This does not modify any daemon/kernel environment or credential enforcement.
	const env = Object.fromEntries(
		["PATH", "TMPDIR", "SYSTEMROOT"].flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])),
	);
	const spawned = spawn(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), ...args], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...env, HOME: home, PI_OFFLINE: "1" },
	});
	let stdout = "",
		stderr = "";
	spawned.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	spawned.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const [code] = await once(spawned, "exit");
	if (code !== 0) throw new Error(`Synthetic child failed (${code}): ${stderr}`);
	return stdout;
}

if (process.argv[2] === "--seed") {
	const home = process.argv[3]!;
	const now = Number(process.argv[4]);
	const disk = new UsageHistoryDisk(dbFile(home), now);
	const generation = disk.status().generation;
	disk.db.exec("BEGIN IMMEDIATE");
	const insert = disk.db.prepare("INSERT INTO usage_rows VALUES(?,?,?,?,?,?,?,?,?)");
	for (let i = 0; i < 50000; i++) {
		const row = evidence(generation, now, i);
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
} else if (process.argv[2] === "--sample") {
	console.log(
		JSON.stringify(
			await sample(
				process.argv[3] as Case,
				process.argv[4]!,
				Number(process.argv[5]),
				Number(process.argv[6] ?? 3),
				Number(process.argv[7] ?? 500),
			),
		),
	);
} else {
	const now = Date.now();
	const home = await mkdtemp(join(tmpdir(), "usage-memory-"));
	try {
		const seed = join(home, "seed");
		await child(["--seed", seed, String(now)], home);
		const results: unknown[] = [];
		const trials = Number(process.env.USAGE_BENCH_TRIALS ?? 3);
		const batches = Number(process.env.USAGE_BENCH_BATCHES ?? 3);
		const batchSize = Number(process.env.USAGE_BENCH_BATCH_SIZE ?? 500);
		const cases = (process.env.USAGE_BENCH_CASES?.split(",") ?? CASES) as readonly Case[];
		assert.ok(Number.isInteger(trials) && trials > 0 && trials <= 5 && cases.every((c) => CASES.includes(c)));
		for (let trial = 0; trial < trials; trial++)
			for (const kind of cases) {
				const dir = join(home, `${trial}-${kind}`);
				if (["populated", "queries", "serialized_queries", "writes"].includes(kind)) {
					await mkdir(join(dir, "accounting"), { recursive: true });
					await copyFile(dbFile(seed), dbFile(dir));
				}
				const result = JSON.parse(
					await child(["--sample", kind, dir, String(now), String(batches), String(batchSize)], home),
				);
				results.push({ trial, ...result });
				console.log(JSON.stringify({ trial, ...result }));
				await rm(dir, { recursive: true, force: true });
			}
		console.log(JSON.stringify({ summary: results }, null, 2));
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}
