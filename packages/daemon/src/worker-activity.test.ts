import assert from "node:assert/strict";
import { test } from "node:test";
import type { SnapshotEvent } from "@pilot/protocol";
import { UpdateGate } from "./update-gate.ts";
import { WorkerActivity } from "./worker-activity.ts";

const snapshot = (overrides: Partial<SnapshotEvent> = {}): SnapshotEvent => ({
	type: "snapshot",
	entries: [],
	inbox: [],
	tools: [],
	compactions: [],
	agent: {},
	usage: { models: {}, tools: {} },
	...overrides,
});

test("ready idle is not safe before the initial activity snapshot", () => {
	const activity = new WorkerActivity();
	assert.equal(activity.busy, true);
	activity.observe([snapshot()]);
	assert.equal(activity.busy, false);
});

test("accepted before working cannot open a preparation gap", () => {
	const activity = new WorkerActivity();
	const gate = new UpdateGate();
	activity.observe([snapshot()]);
	const endSend = gate.begin();
	activity.reset(); // Accepted reply starts a fresh observation before releasing the operation.
	endSend();
	assert.equal(gate.prepare(activity.busy), false);
	activity.observe([snapshot({ run: { inputs: [] } })]);
	assert.equal(gate.prepare(activity.busy), false);
	activity.observe([{ type: "run_end", inputs: [] }]);
	assert.equal(gate.prepare(activity.busy), true);
});

test("queued follow-ups stay busy between runs, and steering/abort can drain the queue", () => {
	const activity = new WorkerActivity();
	const id = 1 as SnapshotEvent["inbox"][number]["id"];
	activity.observe([snapshot({ run: { inputs: [] }, inbox: [{ id, mode: "followUp" }] })]);
	activity.observe([{ type: "run_end", inputs: [] }]);
	assert.equal(activity.busy, true);
	activity.observe([
		{ type: "inbox_update", items: [] },
		{ type: "run_start", inputs: [] },
	]);
	assert.equal(activity.busy, true);
	activity.observe([{ type: "run_end", inputs: [] }]);
	assert.equal(activity.busy, false);
	activity.observe([{ type: "inbox_update", items: [{ id, mode: "steer" }] }]);
	assert.equal(activity.busy, true);
	activity.observe([{ type: "inbox_update", items: [] }]);
	assert.equal(activity.busy, false);
});

test("an idle snapshot after idempotent acceptance does not leave a stuck pending input", () => {
	const activity = new WorkerActivity();
	activity.observe([snapshot()]);
	activity.reset();
	assert.equal(activity.busy, true);
	activity.observe([snapshot()]);
	assert.equal(activity.busy, false);
});
