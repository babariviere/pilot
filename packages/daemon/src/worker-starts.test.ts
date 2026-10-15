import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkerStarts } from "./worker-starts.ts";

function worker() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const ready = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { ready, resolve, reject };
}

test("a large recovery burst starts only two workers at a time, coalesces IDs and drains FIFO", async () => {
	const starts = new WorkerStarts<ReturnType<typeof worker>>();
	const opened: number[] = [];
	const workers = Array.from({ length: 150 }, worker);
	const promises = workers.map((value, id) =>
		starts.open(String(id), () => {
			opened.push(id);
			return value;
		}),
	);
	assert.deepEqual(opened, [0, 1]);
	assert.equal(
		starts.open("2", () => assert.fail("duplicate opening")),
		promises[2],
	);
	for (let id = 0; id < workers.length; id++) {
		assert.equal(opened.length, Math.min(id + 2, workers.length));
		workers[id]!.resolve();
		assert.equal(await promises[id], workers[id]);
	}
	assert.deepEqual(
		opened,
		workers.map((_, id) => id),
	);
});

test("constructor and readiness failures release startup slots", async () => {
	const starts = new WorkerStarts<ReturnType<typeof worker>>();
	await assert.rejects(
		starts.open("throws", () => {
			throw new Error("fork failed");
		}),
		/fork failed/,
	);
	const first = worker();
	const second = worker();
	const third = worker();
	const failed = assert.rejects(
		starts.open("first", () => first),
		/startup failed/,
	);
	const pending = starts.open("second", () => second);
	let opened = false;
	const next = starts.open("third", () => {
		opened = true;
		return third;
	});
	assert.equal(opened, false);
	first.reject(new Error("startup failed"));
	await failed;
	assert.equal(opened, true);
	second.resolve();
	third.resolve();
	await Promise.all([pending, next]);
});

test("shutdown rejects queued openings without forking, but does not revoke live owners", async () => {
	const starts = new WorkerStarts<ReturnType<typeof worker>>();
	const live = [worker(), worker()];
	const opened = live.map((value, id) => starts.open(String(id), () => value));
	const cancelled = assert.rejects(
		starts.open("queued", () => assert.fail("must not fork after shutdown")),
		/shutting down/,
	);
	starts.close();
	await cancelled;
	await assert.rejects(
		starts.open("new", () => assert.fail("closed")),
		/shutting down/,
	);
	for (const value of live) value.resolve();
	assert.deepEqual(await Promise.all(opened), live);
});
