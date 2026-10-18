/**
 * Offline Node telemetry microfixture.
 *
 * Run with: node --expose-gc scripts/bench/telemetry.ts [samples]
 * It opens no network connection and compares the real disabled, healthy-export and failing-export paths.
 */
import { performance } from "node:perf_hooks";
import {
	ExportResultCode,
	NodeTelemetry,
	type ReadableSpan,
	type SpanExporter,
} from "../../packages/telemetry/src/index.ts";

type Mode = "disabled" | "healthy" | "failing";

class BenchExporter implements SpanExporter {
	exports = 0;
	private readonly failure: boolean;
	constructor(failure: boolean) {
		this.failure = failure;
	}
	export(spans: ReadableSpan[], done: (result: { code: ExportResultCode }) => void): void {
		this.exports += spans.length;
		done({ code: this.failure ? ExportResultCode.FAILED : ExportResultCode.SUCCESS });
	}
	async shutdown(): Promise<void> {}
}

function percentile(values: number[], fraction: number): number {
	const sorted = values.toSorted((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

async function sample(mode: Mode) {
	const exporter = new BenchExporter(mode === "failing");
	const telemetry = new NodeTelemetry({
		enabled: mode !== "disabled",
		serviceName: "pilot.kernel",
		serviceVersion: "1.45.1",
		environment: "test",
		hostKind: "local",
		exporter,
	});
	globalThis.gc?.();
	const rssBefore = process.memoryUsage().rss;
	const cpuBefore = process.cpuUsage();
	const chunks: number[] = [];
	const started = performance.now();
	for (let chunk = 0; chunk < 100; chunk++) {
		const chunkStarted = performance.now();
		for (let index = 0; index < 100; index++) {
			telemetry
				.startSpan("pilot.kernel.request", {
					"pilot.operation": "kernel.request",
					"pilot.outcome": "success",
				})
				.end();
		}
		chunks.push((performance.now() - chunkStarted) / 100);
		if (chunk % 5 === 4) await telemetry.forceFlush(250);
	}
	await telemetry.forceFlush(250);
	const elapsedMs = performance.now() - started;
	const cpu = process.cpuUsage(cpuBefore);
	globalThis.gc?.();
	const result = {
		mode,
		spans: 10_000,
		elapsedMs: Number(elapsedMs.toFixed(1)),
		cpuMs: Number(((cpu.user + cpu.system) / 1_000).toFixed(1)),
		medianUsPerSpan: Number((percentile(chunks, 0.5) * 1_000).toFixed(2)),
		p95UsPerSpan: Number((percentile(chunks, 0.95) * 1_000).toFixed(2)),
		rssDeltaMiB: Number(((process.memoryUsage().rss - rssBefore) / 1_048_576).toFixed(1)),
		exported: exporter.exports,
		stats: telemetry.stats,
	};
	await telemetry.shutdown();
	return result;
}

const samples = Math.max(1, Math.min(15, Number.parseInt(process.argv[2] ?? "5", 10) || 5));
const order: Mode[] = ["disabled", "healthy", "failing", "failing", "healthy", "disabled"];
const results: Array<Awaited<ReturnType<typeof sample>>> = [];
for (let round = 0; round < samples; round++) {
	for (const mode of round % 2 === 0 ? order : order.toReversed()) {
		const result = await sample(mode);
		results.push(result);
		console.log(JSON.stringify(result));
	}
}
console.log(
	JSON.stringify({
		kind: "summary",
		runtime: `${process.version} ${process.platform} ${process.arch}`,
		samplesPerMode: samples * 2,
		modes: Object.fromEntries(
			(["disabled", "healthy", "failing"] as const).map((mode) => {
				const values = results.filter((result) => result.mode === mode);
				return [
					mode,
					{
						medianElapsedMs: percentile(
							values.map((value) => value.elapsedMs),
							0.5,
						),
						medianCpuMs: percentile(
							values.map((value) => value.cpuMs),
							0.5,
						),
						medianP95UsPerSpan: percentile(
							values.map((value) => value.p95UsPerSpan),
							0.5,
						),
						medianRssDeltaMiB: percentile(
							values.map((value) => value.rssDeltaMiB),
							0.5,
						),
					},
				];
			}),
		),
	}),
);
