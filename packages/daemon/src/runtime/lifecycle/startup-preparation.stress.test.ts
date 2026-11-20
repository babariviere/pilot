import assert from "node:assert/strict";
import { test } from "node:test";
import { startupResponsiveness } from "./testing/startup-responsiveness.ts";

for (const [count, bytes] of [
	[8, 8_000],
	[150, 256_000],
] as const) {
	test(`startup and update remain responsive with ${count} synthetic preparations of ${bytes} bytes`, {
		timeout: 60_000,
	}, async (t) => {
		const metrics = await startupResponsiveness(count, bytes);
		t.diagnostic(JSON.stringify(metrics));
		if (metrics.sleepPauses) {
			t.skip("host sleep makes latency inconclusive, not repair success");
			return;
		}
		assert.ok(metrics.ticks > 0 && metrics.controls > 0, "heartbeat and actual daemon HTTP reads must run");
		assert.equal(metrics.busyStalls, 0);
		assert.ok(metrics.maxHeartbeatMs < 250, `heartbeat ${metrics.maxHeartbeatMs}ms exceeds 250ms`);
		assert.ok(metrics.maxControlMs < 250, `control request ${metrics.maxControlMs}ms exceeds 250ms`);
		assert.ok(metrics.maxLoopDelayMs < 250, `event loop ${metrics.maxLoopDelayMs}ms exceeds 250ms`);
	});
}
