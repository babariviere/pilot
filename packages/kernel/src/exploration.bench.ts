/** Offline fixture observation, not a speed/token-savings claim. node packages/kernel/src/exploration.bench.ts */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { runExploration } from "./exploration-runner.ts";

const source = await mkdtemp(join(tmpdir(), "pilot-exploration-bench-"));
const impact = process.argv.includes("--impact");
const large = process.argv.includes("--large");
const calls = impact || process.argv.includes("--calls");
const packages = large ? 36 : 12;
try {
	let bytes = 0;
	for (let packageIndex = 0; packageIndex < packages; packageIndex++) {
		const dir = join(source, "packages", `package-${packageIndex}`, "src");
		await mkdir(dir, { recursive: true });
		for (let file = 0; file < 10; file++) {
			const symbols = impact && (file !== 0 || packageIndex !== 0) ? 4 : calls ? 12 : 40;
			const text = Array.from(
				{ length: symbols },
				(_, symbol) =>
					`export function operation${file}_${symbol}(value: string): string { return ${calls && symbol + 1 < symbols ? `operation${file}_${symbol + 1}(value)` : 'value + " fixture "'}; }\n`,
			).join("");
			bytes += Buffer.byteLength(text);
			await writeFile(join(dir, `service-${file}.ts`), text);
		}
		await writeFile(join(dir, "view.tsx"), "export const View = () => <button>fixture</button>;\n");
	}
	const samples = [];
	for (let run = 0; run < (impact ? 10 : 5); run++) {
		// Alternate which investigation runs first in each pair; every invocation uses a fresh worker.
		const batched = impact && (Math.floor(run / 2) % 2 === 0 ? run % 2 === 0 : run % 2 !== 0);
		const baselineRss = process.memoryUsage().rss;
		let peakRss = baselineRss;
		let gap = 0;
		let last = performance.now();
		const heartbeat = setInterval(() => {
			const now = performance.now();
			gap = Math.max(gap, now - last);
			last = now;
			peakRss = Math.max(peakRss, process.memoryUsage().rss);
		}, 5);
		const cpu = process.cpuUsage();
		const start = performance.now();
		try {
			if (impact) {
				const symbols = [8, 10, 11].map((index) => ({
					path: "packages/package-0/src/service-0.ts",
					line: index + 1,
					column: 17,
				}));
				let invocations = 0,
					scannedBytes = 0,
					outputBytes = 0,
					resultRows = 0;
				const observed = new Set<string>();
				const rootIds = new Set<string>();
				if (batched) {
					let cursor: string | undefined;
					do {
						const page = await runExploration(
							{ source },
							{ tool: "code_impact", symbols, depth: 3, limit: 50, cursor },
						);
						assert.equal(page.traversal.resultLimited, false);
						assert.equal(page.failureCount, 0);
						assert.equal(page.coverage.unsupported, 0);
						assert.equal(page.scan.files, packages * 11);
						assert.ok(!page.partialReasons.some((reason) => reason.includes("graph-record-limit")));
						for (const hit of page.results) {
							assert.equal(hit.witness.length, hit.distance);
							assert.equal(hit.witness.at(-1)!.to!.id, hit.rootId);
							observed.add(hit.frame.name);
						}
						invocations++;
						scannedBytes += page.scan.bytes;
						outputBytes += Buffer.byteLength(JSON.stringify(page));
						resultRows += page.results.length;
						cursor = page.page.nextCursor;
					} while (cursor);
				} else {
					for (const symbol of symbols) {
						let cursor: string | undefined;
						do {
							const page = await runExploration(
								{ source },
								{ tool: "code_call_paths", symbol, direction: "callers", depth: 3, limit: 50, cursor },
							);
							assert.equal(page.traversal.resultLimited, false);
							assert.equal(page.failureCount, 0);
							assert.equal(page.coverage.unsupported, 0);
							assert.equal(page.scan.files, packages * 11);
							assert.ok(!page.partialReasons.some((reason) => reason.includes("graph-record-limit")));
							rootIds.add(page.root.name);
							for (const edge of page.results) observed.add(edge.from.name);
							invocations++;
							scannedBytes += page.scan.bytes;
							outputBytes += Buffer.byteLength(JSON.stringify(page));
							resultRows += page.results.length;
							cursor = page.page.nextCursor;
						} while (cursor);
					}
					for (const name of rootIds) observed.delete(name);
				}
				assert.deepEqual([...observed].sort(), ["operation0_5", "operation0_6", "operation0_7", "operation0_9"]);
				const used = process.cpuUsage(cpu);
				samples.push({
					run,
					variant: batched ? "batched-impact" : "three-callers",
					invocations,
					wallMs: Math.round(performance.now() - start),
					cpuMs: Math.round((used.user + used.system) / 1000),
					sampledRssIncreaseMiB: +((peakRss - baselineRss) / 1024 / 1024).toFixed(1),
					heartbeatMaxGapMs: +gap.toFixed(1),
					scannedBytes,
					outputBytes,
					resultRows,
					uniqueNonRootCallers: observed.size,
				});
				continue;
			}
			const page = calls
				? await runExploration(
						{ source },
						{
							tool: "code_call_paths",
							symbol: { path: "packages/package-0/src/service-0.ts", line: 1, column: 17 },
							direction: "callees",
							depth: 6,
						},
					)
				: await runExploration({ source }, { tool: "code_search", query: "operation5_20", limit: 25 });
			const used = process.cpuUsage(cpu);
			samples.push({
				run,
				wallMs: Math.round(performance.now() - start),
				cpuMs: Math.round((used.user + used.system) / 1000),
				sampledRssIncreaseMiB: +((peakRss - baselineRss) / 1024 / 1024).toFixed(1),
				heartbeatMaxGapMs: +gap.toFixed(1),
				scannedBytes: page.scan.bytes,
				files: page.scan.files,
				matches: page.page.matchesObserved,
				outputBytes: Buffer.byteLength(JSON.stringify(page)),
			});
		} finally {
			clearInterval(heartbeat);
		}
	}
	console.log(
		JSON.stringify(
			{
				node: process.version,
				platform: `${process.platform}/${process.arch}`,
				sourceFiles: packages * 11,
				mode: impact ? "impact-vs-three-callers" : calls ? "call-paths" : "search",
				tsBytes: bytes,
				notes: "Five samples/variant, fresh disposable workers, warm filesystem; impact alternates pair order and reads all pages. RSS sampled every 5ms is process-wide and can miss peaks. No model/network calls or GUI measurements. No persistent cache, general speedup or token-savings claim.",
				samples,
			},
			null,
			2,
		),
	);
} finally {
	await rm(source, { recursive: true, force: true });
}
