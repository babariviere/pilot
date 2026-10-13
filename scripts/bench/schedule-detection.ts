/** Isolated incremental detector cost, not whole-daemon or hardware wakeups.
 * node scripts/bench/schedule-detection.ts [seconds=65] [idle|online|offline|all]
 * online uses the real public 204 probe; offline injects a failed probe without changing host networking.
 */
import assert from "node:assert/strict";
import {
	ScheduleDetection,
	probeReachability,
	sampleSystemWake,
} from "../../packages/daemon/src/schedule-detection.ts";
import { SubprocessPool } from "../../packages/daemon/src/subprocess.ts";

const seconds = Number(process.argv[2] ?? 65);
const mode = process.argv[3] ?? "all";
if (!(seconds >= 1 && seconds <= 600) || !["idle", "online", "offline", "all"].includes(mode))
	throw new Error("usage: schedule-detection.ts [seconds=65] [idle|online|offline|all]");

for (const phase of mode === "all" ? ["idle", "online", "offline"] : [mode]) {
	let callbacks = 0,
		samples = 0,
		probes = 0;
	const timers = new Set<NodeJS.Timeout>();
	const pool = new SubprocessPool({ maxThreads: 1, idleMs: 60_000 });
	const detector = new ScheduleDetection({
		clock: {
			now: Date.now,
			setTimeout(callback, ms) {
				const timer = setTimeout(() => {
					timers.delete(timer);
					callbacks++;
					callback();
				}, ms);
				timer.unref();
				timers.add(timer);
				return () => {
					clearTimeout(timer);
					timers.delete(timer);
				};
			},
		},
		sampleWake: (signal) => {
			samples++;
			return sampleSystemWake(signal, pool);
		},
		probe: (signal) => {
			probes++;
			return phase === "offline" ? Promise.resolve(false) : probeReachability(signal);
		},
	});
	const started = performance.now();
	const before = process.cpuUsage();
	detector.setActive(phase !== "idle");
	await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
	detector.setActive(false);
	await pool.close();
	const cpu = process.cpuUsage(before);
	const elapsedMs = performance.now() - started;
	assert.equal(timers.size, 0);
	console.log(
		JSON.stringify({
			phase,
			elapsedMs: Math.round(elapsedMs),
			cpuMs: (cpu.user + cpu.system) / 1000,
			cpuPercent: ((cpu.user + cpu.system) / (elapsedMs * 10)).toFixed(3),
			detectorTimerCallbacks: callbacks,
			wakeSamples: samples,
			probes,
			remainingTimers: timers.size,
		}),
	);
}
