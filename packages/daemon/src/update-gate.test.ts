import assert from "node:assert/strict";
import { test } from "node:test";
import { ServiceUnavailable } from "./errors.ts";
import { UpdateGate } from "./update-gate.ts";

test("prepare atomically pauses admission, then automatically expires", () => {
	let now = 100;
	const gate = new UpdateGate(30_000, () => now);
	assert.equal(gate.prepare(false), true);
	assert.throws(() => gate.begin(), ServiceUnavailable);
	assert.throws(() => gate.assertOpen(), /temporarily paused/);
	now += 29_999;
	assert.throws(() => gate.begin(), ServiceUnavailable);
	now++;
	gate.begin()();
	gate.assertOpen();
});

test("busy workers do not acquire a lease", () => {
	const gate = new UpdateGate();
	assert.equal(gate.prepare(true), false);
	gate.begin()();
});

test("in-flight admissions block preparation until every finally release", () => {
	const gate = new UpdateGate();
	const endSpawn = gate.begin();
	const endSend = gate.begin();
	assert.equal(gate.prepare(false), false);
	endSpawn();
	endSpawn(); // Releases are idempotent, not a counter underflow.
	assert.equal(gate.prepare(false), false);
	endSend();
	assert.equal(gate.prepare(false), true);
});

test("successful preparation retries renew the lease", () => {
	let now = 0;
	const gate = new UpdateGate(30_000, () => now);
	assert.equal(gate.prepare(false), true);
	now = 20_000;
	assert.equal(gate.prepare(false), true);
	now = 30_000;
	assert.throws(() => gate.begin(), ServiceUnavailable);
	now = 50_000;
	gate.begin()();
});
