import assert from "node:assert/strict";
import { test } from "node:test";
import { DaemonOperations, EventLoopWatchdog } from "./event-loop-watchdog.ts";

test("watchdog reports stalls above the threshold with context and main-thread CPU", () => {
	let now = 0;
	let cpu = 0;
	const logs: string[] = [];
	const watchdog = new EventLoopWatchdog({
		intervalMs: 500,
		thresholdMs: 1_000,
		now: () => now,
		cpu: () => cpu,
		log: (message) => logs.push(message),
		describe: (blocked) => [`context ${blocked}`],
	});
	watchdog.start();
	watchdog.stop();
	now = 600;
	assert.equal(watchdog.tick(), 0, "normal timer jitter is not a stall");
	now = 600 + 500 + 2_500;
	cpu = 2_400;
	assert.equal(watchdog.tick(), 2_500);
	assert.deepEqual(logs, [
		"pilotd: event loop delayed for 2500ms (main thread cpu 2400ms: synchronous work); context 2500",
	]);
	const snapshot = watchdog.snapshot();
	assert.equal(snapshot.stalls.count, 1);
	assert.equal(snapshot.stalls.busy, 1);
	assert.equal(snapshot.stalls.totalMs, 2_500);
	assert.deepEqual(snapshot.stalls.recent[0]?.context, ["context 2500"]);
});

test("a stall without main-thread CPU is waiting, not proven event-loop blocking", () => {
	let now = 0;
	let cpu = 0;
	const logs: string[] = [];
	const watchdog = new EventLoopWatchdog({
		now: () => now,
		cpu: () => cpu,
		log: (message) => logs.push(message),
		describe: () => [],
	});
	watchdog.start();
	watchdog.stop();
	now = 500 + 3_000;
	cpu = 40;
	assert.equal(watchdog.tick(), 3_000);
	now += 500 + 600_000;
	cpu += 5;
	assert.equal(watchdog.tick(), 600_000);
	assert.deepEqual(logs, [
		"pilotd: event loop delayed for 3000ms (main thread cpu 40ms: waiting for disk, CPU or system sleep)",
		"pilotd: event loop delayed for 600000ms (main thread cpu 5ms: likely system sleep)",
	]);
	const { stalls } = watchdog.snapshot();
	assert.equal(stalls.waiting, 1);
	assert.equal(stalls.sleep, 1);
	assert.equal(stalls.totalMs, 3_000, "likely sleep is excluded from stalled time");
});

test("equally long sleep and CPU pauses remain distinct in regression measurements", () => {
	let now = 0,
		cpu = 0;
	const watchdog = new EventLoopWatchdog({
		intervalMs: 5,
		thresholdMs: 200,
		now: () => now,
		cpu: () => cpu,
		log: () => {},
	});
	watchdog.start();
	watchdog.stop();
	now += 65_005;
	cpu += 64_000;
	watchdog.tick();
	now += 65_005;
	cpu += 5;
	watchdog.tick();
	const { stalls } = watchdog.snapshot();
	assert.equal(stalls.busy, 1, "a long CPU stall is not sleep");
	assert.equal(stalls.sleep, 1, "the same elapsed pause with negligible CPU is tracked separately");
	assert.equal(stalls.waiting, 0);
	assert.equal(stalls.totalMs, 65_000, "sleep cannot inflate the CPU-stall regression total");
});

test("operations describe slow sections and the oldest in-flight work", () => {
	let now = 0;
	let cpu = 0;
	const operations = new DaemonOperations(
		() => now,
		() => cpu,
	);
	const done = operations.begin("GET /api/sessions");
	now = 10;
	operations.begin("POST /api/sessions/a/messages");
	const value = operations.time("kernel events for a", () => {
		now += 3_000;
		cpu += 20;
		return 42;
	});
	assert.equal(value, 42);
	operations.time("fast", () => undefined);
	assert.deepEqual(operations.describe(3_000), [
		"slow kernel events for a (3000ms, cpu 20ms)",
		"in flight GET /api/sessions (3010ms)",
		"in flight POST /api/sessions/a/messages (3000ms)",
	]);
	done();
	done();
	now += 120_000;
	assert.deepEqual(operations.describe(1_000), ["in flight POST /api/sessions/a/messages (123000ms)"]);
});

test("slow-section totals group session IDs into one bounded kind", () => {
	const operations = new DaemonOperations(
		() => 0,
		() => 0,
	);
	operations.recordSlow("kernel working packet for 972a4fd1-4537-4ef8-aacb-a07d84887317", 900, 10);
	operations.recordSlow("kernel working packet for 07cad929-47f5-4d35-9b4e-4cc4d224e85e", 1_100, 30);
	const { slowByKind, recentSlow } = operations.snapshot();
	assert.deepEqual(slowByKind, [
		{ label: "kernel working packet for :id", count: 2, ms: 2_000, cpuMs: 40, maxMs: 1_100 },
	]);
	assert.equal(recentSlow.length, 2);
});

test("slow timing preserves thrown errors and bounded content-free bookkeeping", () => {
	let now = 0;
	const tracker = new DaemonOperations(
		() => now,
		() => now,
	);
	const failure = new Error("synthetic failure");
	for (let i = 0; i < 100; i++) {
		assert.throws(
			() =>
				tracker.time("diagnostics.redact", () => {
					now += 150;
					throw failure;
				}),
			(error) => error === failure,
		);
	}
	const snapshot = tracker.snapshot();
	assert.equal(snapshot.recentSlow.length, 16);
	assert.deepEqual(snapshot.slowByKind, [
		{ label: "diagnostics.redact", count: 100, ms: 15_000, cpuMs: 15_000, maxMs: 150 },
	]);
});
