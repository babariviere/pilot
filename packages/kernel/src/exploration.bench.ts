/** Offline fixture observation, not a speed/token-savings claim. node packages/kernel/src/exploration.bench.ts */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { runExploration } from "./exploration-runner.ts";

const source = await mkdtemp(join(tmpdir(), "pilot-exploration-bench-"));
const calls = process.argv.includes("--calls");
try {
	let bytes = 0;
	for (let packageIndex = 0; packageIndex < 12; packageIndex++) {
		const dir = join(source, "packages", `package-${packageIndex}`, "src");
		await mkdir(dir, { recursive: true });
		for (let file = 0; file < 10; file++) {
			const symbols = calls ? 12 : 40;
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
	for (let run = 0; run < 5; run++) {
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
				sourceFiles: 132,
				mode: calls ? "call-paths" : "search",
				tsBytes: bytes,
				notes: "Five fresh disposable workers, warm filesystem; RSS sampled every 5ms is process-wide and can miss peaks. No model/network calls or GUI measurements. No persistent cache, baseline speedup or token-savings claim.",
				samples,
			},
			null,
			2,
		),
	);
} finally {
	await rm(source, { recursive: true, force: true });
}
