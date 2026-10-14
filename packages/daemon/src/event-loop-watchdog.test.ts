import assert from "node:assert/strict";
import { test } from "node:test";
import { DaemonOperations, EventLoopWatchdog } from "./event-loop-watchdog.ts";

test("watchdog reports stalls above the threshold with context", () => {
	let now = 0;
	const logs: string[] = [];
	const watchdog = new EventLoopWatchdog({
		intervalMs: 500,
		thresholdMs: 1_000,
		now: () => now,
		log: (message) => logs.push(message),
		describe: (blocked) => [`context ${blocked}`],
	});
	watchdog.start();
	watchdog.stop();
	now = 600;
	assert.equal(watchdog.tick(), 0, "normal timer jitter is not a stall");
	now = 600 + 500 + 2_500;
	assert.equal(watchdog.tick(), 2_500);
	assert.deepEqual(logs, ["pilotd: event loop delayed for 2500ms (may include system sleep); context 2500"]);
});

test("a sleep-sized timer gap is not reported as proven event-loop blocking", () => {
	let now = 0;
	const logs: string[] = [];
	const watchdog = new EventLoopWatchdog({ now: () => now, log: (message) => logs.push(message), describe: () => [] });
	watchdog.start();
	watchdog.stop();
	now = 600_500;
	assert.equal(watchdog.tick(), 600_000);
	assert.equal(logs[0], "pilotd: event loop delayed for 600000ms (may include system sleep)");
});

test("operations describe slow sections and the oldest in-flight work", () => {
	let now = 0;
	const operations = new DaemonOperations(() => now);
	const done = operations.begin("GET /api/sessions");
	now = 10;
	operations.begin("POST /api/sessions/a/messages");
	const value = operations.time("kernel events for a", () => {
		now += 3_000;
		return 42;
	});
	assert.equal(value, 42);
	operations.time("fast", () => undefined);
	assert.deepEqual(operations.describe(3_000), [
		"slow kernel events for a (3000ms)",
		"in flight GET /api/sessions (3010ms)",
		"in flight POST /api/sessions/a/messages (3000ms)",
	]);
	done();
	done();
	now += 120_000;
	assert.deepEqual(operations.describe(1_000), ["in flight POST /api/sessions/a/messages (123000ms)"]);
});
