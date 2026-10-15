import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MissionStore } from "./missions.ts";

test("legacy milestones migrate in first appearance order to stable scoped phases", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pilot-phase-migration-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "missions.sqlite");
	let store = new MissionStore(file);
	const { id } = store.create({
		projectId: "p",
		title: "M",
		tasks: [{ title: "A" }, { title: "B" }, { title: "C" }, { title: "D" }],
	});
	const other = store.create({ projectId: "p", title: "Other", tasks: [{ title: "A" }] });
	store.close();
	const legacy = new DatabaseSync(file);
	legacy.exec(
		"DROP INDEX tasks_by_phase; DROP INDEX unfinished_tasks_by_phase; ALTER TABLE tasks DROP COLUMN phase_id; DROP TABLE phases; ALTER TABLE missions DROP COLUMN phase_gating;",
	);
	legacy
		.prepare(
			"UPDATE tasks SET milestone = CASE number WHEN 1 THEN 'Release' WHEN 2 THEN 'Build' WHEN 3 THEN 'Release' ELSE '  ' END",
		)
		.run();
	legacy.prepare("UPDATE tasks SET sort = 0 WHERE mission_id = ? AND number = 2").run(id);
	legacy.prepare("UPDATE tasks SET status = 'done' WHERE mission_id = ? AND number = 2").run(id);
	legacy.close();
	store = new MissionStore(file);
	const phases = store.phases(id);
	assert.deepEqual(
		phases.map((phase) => phase.name),
		["Build", "Release"],
	);
	assert.ok(phases[0]!.completedAt);
	assert.equal(store.require(id).phaseGating, false);
	assert.equal(store.resolveTask(id, "1").phaseId, phases[1]!.id);
	assert.equal(store.resolveTask(id, "3").phaseId, phases[1]!.id);
	assert.equal(store.resolveTask(id, "4").phaseId, undefined);
	assert.notEqual(store.phases(other.id)[0]!.id, phases[1]!.id);
	store.updatePhase(id, phases[1]!.id, { name: "Ship", goal: "Delivery" });
	assert.equal(store.resolveTask(id, "1").milestone, "Ship");
	store.close();
	store = new MissionStore(file);
	t.after(() => store.close());
	assert.deepEqual(
		store.phases(id).map((phase) => phase.id),
		phases.map((phase) => phase.id),
	);
	assert.equal(store.phases(id)[1]!.goal, "Delivery");
});

test("equal-key phase ordering, completion and gating survive durable replica restart", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pilot-phase-replica-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "missions.sqlite");
	let store = new MissionStore(file);
	const { id } = store.create({ projectId: "p", title: "M" });
	for (const name of ["A", "B", "C", "D"]) store.addPhase(id, { name, order: 1 });
	const phases = store.phases(id);
	const a = store.addTask(id, { title: "Earlier", phaseId: phases[0]!.id });
	const b = store.addTask(id, {
		title: "Later",
		phaseId: phases[3]!.id,
		preferredModel: "test/preferred",
		preferredThinking: "high",
	});
	store.update(id, { phaseGating: true });
	await store.durable();
	store.close();
	store = new MissionStore(file);
	t.after(() => store.close());
	assert.deepEqual(
		store.phases(id).map((phase) => phase.id),
		phases.map((phase) => phase.id),
	);
	assert.deepEqual(store.task(id, b.id).blockedByPhases, [phases[0]!.id]);
	assert.deepEqual(
		[store.task(id, b.id).preferredModel, store.task(id, b.id).preferredThinking],
		["test/preferred", "high"],
	);
	store.updateTask(id, a.id, { status: "done" });
	assert.equal(store.task(id, b.id).status, "todo");
	await store.durable();
	store.close();
	store = new MissionStore(file);
	assert.ok(store.phases(id)[0]!.completedAt);
	assert.equal(store.task(id, b.id).status, "todo");
	assert.equal(store.task(id, b.id).preferredModelSetBy, "user");
});

test("phases complete and reopen on status, assignment and deletion with activity", (t) => {
	const store = new MissionStore(":memory:");
	t.after(() => store.close());
	const { id } = store.create({ projectId: "p", title: "M" });
	const phase = store.addPhase(id, { name: "Build" });
	assert.ok(phase.completedAt, "empty phases do not hold the gate closed");
	const a = store.addTask(id, { title: "A", phaseId: phase.id });
	const b = store.addTask(id, { title: "B", phaseId: phase.id, status: "dropped" });
	assert.equal(store.phases(id)[0]!.completedAt, undefined);
	store.updateTask(id, a.id, { status: "done" });
	const completed = store.phases(id)[0]!.completedAt;
	assert.ok(completed);
	store.updateTask(id, a.id, { body: "Still done" });
	assert.equal(store.phases(id)[0]!.completedAt, completed);
	store.updateTask(id, b.id, { status: "delegated" });
	assert.equal(store.phases(id)[0]!.completedAt, undefined, "delegated is unfinished");
	store.removeTask(id, b.id);
	assert.ok(store.phases(id)[0]!.completedAt);
	store.updateTask(id, a.id, { status: "todo" });
	assert.equal(store.phases(id)[0]!.completedAt, undefined);
	store.updateTask(id, a.id, { phaseId: null });
	assert.ok(store.phases(id)[0]!.completedAt);
	store.updateTask(id, a.id, { phaseId: phase.id });
	assert.equal(store.phases(id)[0]!.completedAt, undefined);
	const events = store.events(id, undefined, 100).filter((event) => /^Phase (completed|reopened):/.test(event.text));
	assert.deepEqual(
		events.reverse().map((event) => event.text.split(":")[0]),
		[
			"Phase completed",
			"Phase reopened",
			"Phase completed",
			"Phase reopened",
			"Phase completed",
			"Phase reopened",
			"Phase completed",
			"Phase reopened",
		],
	);
	store.removePhase(id, phase.id);
	assert.equal(store.resolveTask(id, a.id).phaseId, undefined);
	assert.equal(store.resolveTask(id, a.id).milestone, undefined);
});

test("gating derives blocked state, follows ordering and requires user override for admission", (t) => {
	const store = new MissionStore(":memory:");
	t.after(() => store.close());
	const { id } = store.create({ projectId: "p", title: "M" });
	const first = store.addPhase(id, { name: "Build", order: 1 });
	const later = store.addPhase(id, { name: "Ship", order: 2 });
	const a = store.addTask(id, { title: "A", phaseId: first.id });
	const b = store.addTask(id, { title: "B", phaseId: later.id });
	const unphased = store.addTask(id, { title: "Unphased" });
	store.join("chat", id);
	assert.equal(store.task(id, b.id).status, "todo");
	store.update(id, { phaseGating: true });
	assert.equal(store.task(id, b.id).status, "blocked");
	assert.deepEqual(store.task(id, b.id).blockedByPhases, [first.id]);
	assert.equal(store.task(id, unphased.id).status, "todo");
	assert.throws(() => store.claimTask(id, b.id, "chat"), /earlier phases/);
	assert.throws(() => store.prepareTaskStart(id, [a.id, b.id]), /earlier phases/);
	assert.equal(store.claimTasks(id, [b.id], "chat").skipped.length, 1);
	store.updateTask(id, b.id, { body: "Edit while gated" });
	assert.equal(store["db"].prepare("SELECT status FROM tasks WHERE id = ?").get(b.id)!.status, "todo");
	assert.throws(() => store.updateTask(id, b.id, { sessionId: "chat" }), /earlier phases/);
	store.updateTask(id, b.id, { sessionId: "chat", overridePhaseGating: true });
	store.releaseTask(id, b.id);
	store.updatePhase(id, later.id, { order: 0 });
	assert.equal(store.task(id, b.id).status, "todo");
	assert.equal(store.task(id, a.id).status, "blocked");
	store.updatePhase(id, first.id, { order: -1 });
	store.updateTask(id, a.id, { status: "dropped" });
	assert.equal(store.task(id, b.id).status, "todo");
	store.updateTask(id, a.id, { status: "todo" });
	store.claimStartTasks(id, [b.id], "chat", true);
	assert.equal(store.task(id, b.id).storedStatus, "in_progress");
	store.update(id, { phaseGating: false });
	assert.equal(store.task(id, b.id).status, "in_progress");
	const other = store.create({ projectId: "p", title: "Other" });
	assert.throws(() => store.addTask(other.id, { title: "Wrong scope", phaseId: first.id }), /Unknown phase/);
	assert.throws(() => store.addPhase(id, { name: "Build" }), /already exists/);
	assert.throws(() => store.updatePhase(id, later.id, { order: Number.NaN }), /order/);
	assert.deepEqual(
		store.phases(id).map((phase) => phase.id),
		[first.id, later.id],
	);
});

test("summaries carry the first unfinished phase and its progress", (t) => {
	const store = new MissionStore(":memory:");
	t.after(() => store.close());
	const { id } = store.create({ projectId: "p", title: "M" });
	assert.equal(store.get(id)!.currentPhase, undefined, "no phases");
	const build = store.addPhase(id, { name: "Build" });
	const ship = store.addPhase(id, { name: "Ship" });
	assert.equal(store.get(id)!.currentPhase, undefined, "empty phases are complete");
	const a = store.addTask(id, { title: "A", phaseId: build.id, status: "done" });
	store.addTask(id, { title: "B", phaseId: build.id, status: "dropped" });
	store.addTask(id, { title: "C", phaseId: ship.id });
	store.addTask(id, { title: "D", phaseId: ship.id, status: "done" });
	store.addTask(id, { title: "Unphased" });
	assert.deepEqual(store.get(id)!.currentPhase, { id: ship.id, name: "Ship", done: 1, total: 2 });
	store.updateTask(id, a.id, { status: "todo" });
	assert.deepEqual(store.list("p")[0]!.currentPhase, { id: build.id, name: "Build", done: 0, total: 1 });
	store.updatePhase(id, build.id, { name: "Foundations" });
	assert.equal(store.get(id)!.currentPhase?.name, "Foundations");
});
