/** Offline pair qualification, not a live latency/RSS guarantee. No model or filesystem source. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { RetainedCallInput, RetainedCallProvider } from "./retained-call-contract.ts";
import { compareRetainedCalls } from "./retained-call-runner.ts";

function fixture(files: number): RetainedCallProvider {
	const bytes = {
		before: Buffer.from("export function leaf() { return 1; }\nexport function caller() { return leaf(); }\n"),
		after: Buffer.from("export function leaf() { return 2; }\nexport function caller() { return leaf(); }\n"),
	};
	const entries = (side: "before" | "after") =>
		Array.from({ length: files }, (_, i) => ({
			path: `package-${String(i).padStart(4, "0")}/source.ts`,
			mode: "100644",
			gitOid: "a".repeat(40),
			state: "text" as const,
			bytes: bytes[side].length,
			sha256: createHash("sha256").update(bytes[side]).digest("hex"),
		}));
	const input: RetainedCallInput = {
		storeId: "a".repeat(64),
		snapshotId: "b".repeat(64),
		status: "complete",
		request: {
			requestId: "offline",
			repositoryId: "c".repeat(64),
			changeId: "k".repeat(32),
			operationId: "d".repeat(128),
			base: { changeId: "l".repeat(32), commitId: "e".repeat(40) },
			head: { changeId: "k".repeat(32), commitId: "f".repeat(40) },
			scope: { kind: "layer" },
			source: "committed",
		},
		before: entries("before"),
		after: entries("after"),
	};
	return { input, authorize: async () => {}, read: async (ref) => bytes[ref.side] };
}

for (let sample = 0; sample < 5; sample++)
	for (const files of sample % 2 ? [396, 132] : [132, 396]) {
		const provider = fixture(files);
		let reads = 0;
		const seen = new Set<string>();
		const read = provider.read;
		provider.read = async (ref, signal) => {
			const id = `${ref.side}/${ref.path}`;
			assert.ok(!seen.has(id));
			seen.add(id);
			reads++;
			return read(ref, signal);
		};
		const controller = new AbortController();
		const cpu = process.cpuUsage(),
			rss = process.memoryUsage.rss(),
			start = performance.now();
		let maxRss = rss,
			gap = 0,
			last = start;
		const timer = setInterval(() => {
			const now = performance.now();
			gap = Math.max(gap, now - last);
			last = now;
			maxRss = Math.max(maxRss, process.memoryUsage.rss());
			const used = process.cpuUsage(cpu);
			if (used.user + used.system > 5_000_000 || maxRss - rss > 256 * 1024 * 1024)
				controller.abort(new Error("Offline qualification CPU/RSS stop rule"));
		}, 5);
		try {
			const result = await compareRetainedCalls(provider, {}, controller.signal);
			assert.equal(reads, 2 * files);
			assert.equal(result.coverage.before.parsed + result.coverage.after.parsed, reads);
			assert.equal(result.page.retained, 2 * files);
			assert.equal(result.partial, false);
			assert.equal(result.results.find((r) => r.before[0]?.name === "leaf")?.bodyChanged, true);
			assert.equal(result.results.find((r) => r.before[0]?.name === "caller")?.bodyChanged, false);
			assert.ok(result.results.every((r) => r.outgoingRelationshipChanged === false));
			const used = process.cpuUsage(cpu);
			assert.ok(used.user + used.system <= 5_000_000 && maxRss - rss <= 256 * 1024 * 1024);
			console.log(
				JSON.stringify({
					files,
					sample,
					wallMs: performance.now() - start,
					cpuMs: (used.user + used.system) / 1000,
					rssIncreaseMiB: (maxRss - rss) / 1024 / 1024,
					heartbeatGapMs: gap,
					reads,
					parses: reads,
					scannedBytes: result.budget.bytes,
					outputBytes: Buffer.byteLength(JSON.stringify(result)),
					rows: result.results.length,
				}),
			);
		} finally {
			clearInterval(timer);
		}
	}
