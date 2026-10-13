/** Run with node scripts/bench/project-memory.ts [entry-count]. Uses an isolated disposable data dir. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { ProjectMemoryService } from "../../packages/daemon/src/project-memory.ts";

const count = Number(process.argv[2] ?? 100_000);
if (!Number.isSafeInteger(count) || count < 100 || count > 1_000_000)
	throw new Error("Expected 100 to 1000000 entries");
const home = await mkdtemp(join(tmpdir(), "pilot-memory-bench-"));
const service = new ProjectMemoryService(home);
try {
	const dir = join(home, "memory", "bench");
	await mkdir(dir, { recursive: true });
	const fd = await open(join(dir, "log"), "w");
	const deviceId = randomUUID(),
		batch = Buffer.alloc(2048 * 1024, 32);
	try {
		for (let base = 0; base < count; base += 1024) {
			const n = Math.min(1024, count - base);
			batch.fill(32);
			for (let i = 0; i < n; i++) {
				const json = JSON.stringify({
					index: base + i,
					id: randomUUID(),
					deviceId,
					at: Date.now(),
					sessionId: "origin",
					text: `Lasting decision ${base + i}: ${"é".repeat(100)}`,
				});
				batch.write(`${createHash("sha256").update(json).digest("hex")} ${json}`, i * 2048);
				batch[(i + 1) * 2048 - 1] = 10;
			}
			await fd.write(batch, 0, n * 2048); // benchmark seeding, not production append semantics
		}
		await fd.sync();
	} finally {
		await fd.close();
	}
	await service.load("bench");
	await service.wake("bench");
	const measure = async () => {
		const start = performance.now();
		await service.wake("bench");
		return performance.now() - start;
	};
	const baseline = [];
	for (let i = 0; i < 20; i++) baseline.push(await measure());
	const histogram = monitorEventLoopDelay({ resolution: 10 });
	histogram.enable();
	await delay(30);
	const start = performance.now(),
		search = service.recall("bench", "decision", 96),
		loaded = [];
	for (let i = 0; i < 50; i++) {
		await service.note("bench", `Streaming new fact ${i}`, "origin");
		loaded.push(await measure());
	}
	const recall = await search,
		elapsed = performance.now() - start;
	await delay(30);
	histogram.disable();
	const p95 = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length * 0.95)];
	console.log(
		JSON.stringify(
			{
				count,
				logMB: (count * 2048) / 1e6,
				scanAnd50AppendsMs: Math.round(elapsed),
				baselineWakeP95Ms: p95(baseline),
				loadedWakeP95Ms: p95(loaded),
				eventLoopP99Ms: histogram.percentile(99) / 1e6,
				recallMatches: recall.matches,
				retained: recall.entries.length,
				rssMB: process.memoryUsage().rss / 1e6,
			},
			null,
			2,
		),
	);
} finally {
	await service.stop();
	await rm(home, { recursive: true, force: true });
}
