/** Isolated synchronous mission-change fan-out. Run before/after on identical fixtures, one process at a time. */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { threadCpuMs } from "./event-loop-watchdog.ts";
import { missionContextFixture } from "./testing/mission-context.ts";

const f = missionContextFixture();
const narrow = f.store.memberContext.bind(f.store);
// Recreate the previous context() reads exactly, using the unchanged full-detail API.
const legacy: typeof narrow = (sessionId) => {
	const id = f.store.missionOf(sessionId);
	const mission = id ? f.store.get(id) : undefined;
	return mission ? f.store.detail(mission.id, false) : undefined;
};
try {
	let expected: string | undefined;
	for (let i = 0; i < 6; i++)
		for (const variant of i % 2 ? ["narrow", "legacy"] : ["legacy", "narrow"]) {
			f.store.memberContext = variant === "legacy" ? legacy : narrow;
			const cpu = threadCpuMs();
			const start = performance.now();
			f.store.log(f.id, { text: "Synthetic activity" });
			const wallMs = performance.now() - start;
			const cpuMs = threadCpuMs() - cpu;
			const result = JSON.stringify([...f.delivered]);
			expected ??= result;
			assert.equal(result, expected, "both projections publish identical contexts in the same order");
			console.log(
				JSON.stringify({
					iteration: i,
					variant,
					warmup: i === 0,
					tasks: 480,
					members: 400,
					decisions: 60,
					artifacts: 400,
					bodyBytes: 480 * 4000,
					wallMs,
					cpuMs,
					delivered: f.delivered.size,
				}),
			);
		}
} finally {
	f.store.memberContext = narrow;
	f.store.close();
}
