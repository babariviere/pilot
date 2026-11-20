import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { MissionStore } from "./missions.ts";
import { replacedMissionView } from "./replaced-mission.ts";

test("planner reads the old mission it re-plans, read-only", () => {
	const store = new MissionStore(":memory:");
	const old = store.create({ projectId: "p", title: "Old mission", goal: "Ship the importer", brief: "Old brief" });
	const task = store.addTask(old.id, { title: "Build importer", body: "Full task body" });
	store.addDecision(old.id, "Keep native storage");
	const next = store.create({ projectId: "p", title: "New mission", planningVersion: 1 });
	store.linkSuccessor(old.id, next.id, "p", randomUUID());

	const view = replacedMissionView(store, next.id);
	assert.equal(view.missionId, old.id);
	assert.equal(view.title, "Old mission");
	assert.equal(view.brief, "Old brief");
	assert.deepEqual(view.decisions, [{ number: 1, text: "Keep native storage" }]);
	assert.deepEqual(view.tasks, [{ number: task.number, title: "Build importer", status: "todo" }]);

	const one = replacedMissionView(store, next.id, task.number);
	assert.equal((one.task as { body: string }).body, "Full task body");
	assert.equal(one.latestReport, null);
	assert.throws(() => replacedMissionView(store, next.id, 99), /Unknown task #99/);
	assert.throws(() => replacedMissionView(store, old.id), /does not re-plan/);
	assert.equal(store.tasks(old.id).length, 1);
});
