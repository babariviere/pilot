import assert from "node:assert/strict";
import { once } from "node:events";
import { Agent, createServer, get } from "node:http";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { EventLoopWatchdog, threadCpuMs } from "./event-loop-watchdog.ts";
import { missionContextFixture } from "./testing/mission-context.ts";

test("mission activity burst leaves heartbeat and unrelated HTTP responsive", { timeout: 30_000 }, async (t) => {
	const f = missionContextFixture();
	const server = createServer((_req, res) => res.end("ready"));
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const agent = new Agent({ keepAlive: true, maxSockets: 1 });
	const probe = () =>
		new Promise<void>((resolve, reject) => {
			get({ host: "127.0.0.1", port: address.port, agent }, (res) => {
				let text = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => {
					text += chunk;
				});
				res.on("error", reject);
				res.on("end", () => {
					if (res.statusCode === 200 && text === "ready") resolve();
					else reject(new Error("Unexpected synthetic response"));
				});
			}).on("error", reject);
		});
	const watchdog = new EventLoopWatchdog({ intervalMs: 5, thresholdMs: 500, log: () => {} });
	let heartbeat: ReturnType<typeof globalThis.setInterval> | undefined;
	try {
		await probe();
		watchdog.start();
		let last = performance.now(),
			maxHeartbeatMs = 0,
			ticks = 0;
		heartbeat = globalThis.setInterval(() => {
			const now = performance.now();
			maxHeartbeatMs = Math.max(maxHeartbeatMs, now - last);
			last = now;
			ticks++;
		}, 5);
		const started = performance.now(),
			cpu = threadCpuMs();
		const pending = probe();
		void pending.catch(() => {});
		// Two ordinary synchronous activity writes previously took ~1.8 seconds on this fixture.
		f.store.log(f.id, { text: "First synthetic activity" });
		f.store.log(f.id, { text: "Second synthetic activity" });
		const sectionWallMs = performance.now() - started;
		const sectionCpuMs = threadCpuMs() - cpu;
		await pending;
		const httpMs = performance.now() - started;
		await setTimeout(15);
		const { stalls } = watchdog.snapshot();
		t.diagnostic(
			JSON.stringify({
				sectionWallMs,
				sectionCpuMs,
				httpMs,
				maxHeartbeatMs,
				ticks,
				busy: stalls.busy,
				waiting: stalls.waiting,
				sleep: stalls.sleep,
			}),
		);
		assert.equal(f.delivered.size, f.members.length);
		assert.ok(ticks > 0, "heartbeat must actually run");
		assert.ok(sectionCpuMs < 500, `context burst used ${sectionCpuMs}ms main-thread CPU`);
		assert.equal(stalls.busy, 0);
		if (stalls.waiting === 0 && stalls.sleep === 0) {
			assert.ok(maxHeartbeatMs < 500, `heartbeat delayed ${maxHeartbeatMs}ms`);
			assert.ok(httpMs < 500, `unrelated HTTP delayed ${httpMs}ms`);
		}
		// Waiting and sleep are reported separately, not evidence of a CPU regression or native/provider latency.
	} finally {
		clearInterval(heartbeat);
		watchdog.stop();
		agent.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		f.store.close();
	}
});
