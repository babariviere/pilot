import assert from "node:assert/strict";
import { test } from "node:test";
import { JobsMonitor, runningJobs } from "./jobs.ts";

const job = { id: "job-1", name: "Tests", state: "running", startedAt: 1000, outputPath: "/tmp/tests/output.log" };

test("monitoring probes only live jobs, coalesces, detects exits and stops on close", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let registry: (typeof job)[] = [];
	let reads = 0;
	const changes: unknown[] = [];
	const monitor = new JobsMonitor(
		async () => {
			reads++;
			return runningJobs(registry);
		},
		(jobs) => changes.push(jobs),
	);
	await monitor.refresh();
	t.mock.timers.tick(10_000);
	assert.equal(reads, 1, "empty sessions have no probe timer");
	registry = [job];
	const first = monitor.refresh();
	assert.equal(monitor.refresh(), first);
	await first;
	assert.deepEqual(changes, [[job]]);
	t.mock.timers.tick(1_000);
	await monitor.refresh();
	assert.deepEqual(changes, [[job]], "unchanged probes do not emit IPC or daemon updates");
	registry = [];
	t.mock.timers.tick(1_000);
	await monitor.refresh();
	assert.deepEqual(changes, [[job], []]);
	const idleReads = reads;
	t.mock.timers.tick(10_000);
	assert.equal(reads, idleReads);
	registry = [job];
	await monitor.refresh();
	await monitor.close();
	assert.deepEqual(changes, [[job], [], [job], []]);
	const closedReads = reads;
	t.mock.timers.tick(10_000);
	await monitor.refresh();
	assert.equal(reads, closedReads);
});

test("inspection failures retain known jobs, and close discards an in-flight read", async () => {
	let fail = false;
	let release!: (jobs: ReturnType<typeof runningJobs>) => void;
	let delayed = false;
	const changes: unknown[] = [];
	const monitor = new JobsMonitor(
		async () => {
			if (fail) throw new Error("unavailable");
			if (delayed)
				return new Promise((resolve) => {
					release = resolve;
				});
			return runningJobs([job]);
		},
		(jobs) => changes.push(jobs),
	);
	await monitor.refresh();
	fail = true;
	await monitor.refresh();
	assert.deepEqual(changes, [[job]]);
	fail = false;
	delayed = true;
	const reading = monitor.refresh();
	const closing = monitor.close();
	release(runningJobs([{ ...job, id: "late" }]));
	await Promise.all([reading, closing]);
	assert.deepEqual(changes, [[job], []]);
});

test("a start racing an older empty snapshot forces a fresh read before releasing callers", async () => {
	let release!: (jobs: ReturnType<typeof runningJobs>) => void;
	let first = true;
	const changes: unknown[] = [];
	const monitor = new JobsMonitor(
		() => {
			if (first) {
				first = false;
				return new Promise((resolve) => {
					release = resolve;
				});
			}
			return Promise.resolve(runningJobs([job]));
		},
		(jobs) => changes.push(jobs),
	);
	const stale = monitor.refresh();
	const afterStart = monitor.refresh();
	release([]);
	await Promise.all([stale, afterStart]);
	assert.deepEqual(changes, [[job]]);
	await monitor.close();
});

test("jobs snapshots contain only running jobs and client fields", () => {
	assert.deepEqual(
		runningJobs([
			{ ...job, command: "private command", pid: 123 },
			{ state: "done" },
			{ state: "failed" },
			{ state: "cancelled" },
			{ state: "interrupted" },
		]),
		[job],
	);
	assert.deepEqual(runningJobs([]), []);
});

test("crash-recovered jobs do not hide live jobs or keep the monitor probing", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const interrupted = { ...job, id: "recovered", state: "interrupted", endedAt: 2000, exitCode: null };
	let registry = [interrupted, job];
	let reads = 0;
	const changes: unknown[] = [];
	const monitor = new JobsMonitor(
		async () => {
			reads++;
			return runningJobs(registry);
		},
		(jobs) => changes.push(jobs),
	);
	t.after(() => monitor.close());
	await monitor.refresh();
	assert.deepEqual(changes, [[job]]);
	registry = [interrupted];
	t.mock.timers.tick(1000);
	await monitor.refresh();
	assert.deepEqual(changes, [[job], []]);
	const idleReads = reads;
	t.mock.timers.tick(10_000);
	assert.equal(reads, idleReads, "retained interrupted handles are not live jobs");
});

test("jobs snapshots reject malformed, duplicate and oversized results", () => {
	for (const value of [
		null,
		{},
		[null],
		[{ state: "unknown" }],
		Array(257).fill(job),
		[job, job],
		[{ ...job, id: "" }],
		[{ ...job, name: "x".repeat(1025) }],
		[{ ...job, outputPath: "relative.log" }],
		[{ ...job, outputPath: "/tmp/\0log" }],
		[{ ...job, startedAt: NaN }],
		[{ ...job, startedAt: Infinity }],
		[{ ...job, startedAt: -1 }],
		[{ ...job, startedAt: 9e15 }],
		[{ ...job, startedAt: "1000" }],
	]) {
		assert.throws(() => runningJobs(value), /Invalid/);
	}
});
