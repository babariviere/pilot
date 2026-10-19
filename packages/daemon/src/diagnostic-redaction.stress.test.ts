import assert from "node:assert/strict";
import { once } from "node:events";
import { Agent, createServer, get } from "node:http";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { test } from "node:test";
import { setImmediate, setTimeout } from "node:timers/promises";
import { sanitizeDiagnosticLogLine } from "./diagnostic-logs.ts";
import { EventLoopWatchdog, threadCpuMs } from "./event-loop-watchdog.ts";

test("bounded URL-like diagnostic records do not block heartbeat or unrelated HTTP requests", {
	timeout: 30_000,
}, async (t) => {
	// Same callback used by daemon log reads and failure sanitization. No user state or chat is opened.
	// Six near-limit records reproduced ~1.2 seconds of CPU blocking EACH before the URL matcher fix.
	const input = Array.from({ length: 6 }, (_, i) => `case-${i} https://${"a:".repeat(31_980)} no credentials`);
	const expected = input.flatMap((text) => [text, "[REDACTED credential-bearing record]"]);
	const records = input.flatMap((text) => [text, `${text.replace(" no credentials", "")}@example.test`]);
	assert.ok(records.every((text) => Buffer.byteLength(text) <= 64_000));
	const server = createServer((_request, response) => response.end("ready"));
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const agent = new Agent({ keepAlive: true, maxSockets: 1 });
	const probe = () =>
		new Promise<void>((resolve, reject) => {
			get({ host: "127.0.0.1", port: address.port, agent }, (response) => {
				let body = "";
				response.setEncoding("utf8");
				response.on("data", (chunk) => {
					body += chunk;
				});
				response.on("error", reject);
				response.on("end", () => {
					if (body === "ready" && response.statusCode === 200) resolve();
					else reject(new Error("Unexpected unrelated request result"));
				});
			}).on("error", reject);
		});
	const histogram = monitorEventLoopDelay({ resolution: 5 });
	const watchdog = new EventLoopWatchdog({ intervalMs: 5, thresholdMs: 200, log: () => {} });
	let timer: ReturnType<typeof globalThis.setInterval> | undefined;
	let stopped = false;
	let probing: Promise<void> | undefined;
	try {
		await probe();
		histogram.enable();
		await setTimeout(15); // Arm the histogram before the synchronous callback, not after it.
		histogram.reset();
		watchdog.start();
		let ticks = 0,
			requests = 0,
			maxHeartbeatMs = 0,
			maxRequestMs = 0;
		let last = performance.now();
		timer = globalThis.setInterval(() => {
			const now = performance.now();
			maxHeartbeatMs = Math.max(maxHeartbeatMs, now - last);
			last = now;
			ticks++;
		}, 5);
		probing = (async () => {
			while (!stopped) {
				const start = performance.now();
				await probe();
				maxRequestMs = Math.max(maxRequestMs, performance.now() - start);
				requests++;
			}
		})();
		// Attach immediately so an early HTTP error is not an unhandled rejection.
		void probing.catch(() => {});
		const results: string[] = [];
		const start = performance.now(),
			cpu = threadCpuMs();
		for (const text of records) {
			await setImmediate();
			results.push(sanitizeDiagnosticLogLine(text));
		}
		await setTimeout(15); // Let pending heartbeat/HTTP callbacks observe the last synchronous section.
		stopped = true;
		await probing;
		const { stalls } = watchdog.snapshot();
		const metrics = {
			records: records.length,
			wallMs: performance.now() - start,
			cpuMs: threadCpuMs() - cpu,
			ticks,
			requests,
			maxHeartbeatMs,
			maxRequestMs,
			maxLoopDelayMs: histogram.max / 1e6,
			busyStalls: stalls.busy,
			waitingStalls: stalls.waiting,
			sleepPauses: stalls.sleep,
		};
		t.diagnostic(JSON.stringify(metrics));
		assert.deepEqual(results, expected, "redaction results and input order are unchanged");
		if (stalls.sleep) {
			t.skip("host sleep makes the latency measurement inconclusive, not a CPU regression or repair success");
			return;
		}
		assert.ok(ticks > 0 && requests > 0, "heartbeat and unrelated requests must actually run");
		assert.equal(stalls.busy, 0);
		assert.ok(maxHeartbeatMs < 200, `heartbeat ${maxHeartbeatMs}ms exceeds 200ms budget`);
		assert.ok(maxRequestMs < 200, `unrelated request ${maxRequestMs}ms exceeds 200ms budget`);
		assert.ok(histogram.max / 1e6 < 200, "event-loop delay exceeds 200ms budget");
	} finally {
		stopped = true;
		clearInterval(timer);
		watchdog.stop();
		histogram.disable();
		await probing?.catch(() => {});
		agent.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
