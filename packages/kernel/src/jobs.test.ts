import assert from "node:assert/strict";
import { test } from "node:test";
import { runningJobs } from "./jobs.ts";

const job = { id: "job-1", name: "Tests", state: "running", startedAt: 1000, outputPath: "/tmp/tests/output.log" };

test("jobs snapshots contain only running jobs and client fields", () => {
	assert.deepEqual(
		runningJobs([
			{ ...job, command: "private command", pid: 123 },
			{ state: "done" },
			{ state: "failed" },
			{ state: "cancelled" },
		]),
		[job],
	);
	assert.deepEqual(runningJobs([]), []);
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
