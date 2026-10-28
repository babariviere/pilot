/** Offline admission cost only, not provider latency or large-history preparation. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { SubscriptionGate } from "@babariviere/pi-extensions/subscription-gate";

const directory = await mkdtemp(join(tmpdir(), "pilot-quota-bench-"));
try {
	const path = join(directory, "policy.json");
	await writeFile(path, JSON.stringify({ version: 1, windows: [] }));
	const samples: Record<string, Array<{ wallMs: number; cpuMs: number }>> = { before: [], after: [] };
	for (let sample = 0; sample < 5; sample++) {
		for (const label of sample % 2 ? ["after", "before"] : ["before", "after"]) {
			const gate = new SubscriptionGate(label === "before" ? "" : path);
			const started = performance.now(),
				cpu = process.cpuUsage();
			for (let index = 0; index < 1_000; index++) await gate.wait("openai-codex");
			const used = process.cpuUsage(cpu);
			samples[label]!.push({ wallMs: performance.now() - started, cpuMs: (used.user + used.system) / 1_000 });
		}
	}
	const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
	for (const [label, values] of Object.entries(samples))
		console.log(
			JSON.stringify({
				label,
				admissions: 1_000,
				wallMs: median(values.map((v) => v.wallMs)),
				cpuMs: median(values.map((v) => v.cpuMs)),
			}),
		);
} finally {
	await rm(directory, { recursive: true, force: true });
}
