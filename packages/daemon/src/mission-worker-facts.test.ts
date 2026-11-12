import assert from "node:assert/strict";
import { test } from "node:test";
import { MissionReports } from "./mission-reports.ts";
import { MissionStore } from "./missions.ts";
import { verificationKey } from "./user-verification.ts";

for (const planningVersion of [undefined, 1] as const) {
	test(`coordinator completes worker-owned tasks, planning ${planningVersion ?? "legacy"}`, (t) => {
		const store = new MissionStore(":memory:");
		t.after(() => store.close());
		const { id } = store.create({ projectId: "p", title: "Ownership", planningVersion });
		store.join("lead", id);
		store.join("worker", id);
		store.update(id, { coordinatorSessionId: "lead" });
		const task = store.addTask(id, { title: "Slice", sessionId: "worker" });
		const delivery = { commit: "a".repeat(40), checks: "Focused checks passed", issues: "" };
		assert.deepEqual(store.completeTask(id, task.id, "lead", delivery), delivery);
		assert.equal(store.task(id, task.id).status, "done");
		assert.equal(store.task(id, task.id).sessionId, "worker");
		const events = store.events(id).length;
		assert.deepEqual(store.completeTask(id, task.id, "lead", delivery), delivery);
		assert.equal(store.events(id).length, events);
		store.updateTask(id, task.id, { status: "in_progress" });
		assert.deepEqual(store.completeTask(id, task.id, "lead", delivery), delivery);
		assert.equal(store.task(id, task.id).status, "in_progress", "retry is a receipt, never repeats closure");
	});

	test(`worker facts cannot change canonical status, planning ${planningVersion ?? "legacy"}`, (t) => {
		const store = new MissionStore(":memory:");
		t.after(() => store.close());
		const { id } = store.create({ projectId: "p", title: "Ownership", planningVersion });
		store.join("lead", id);
		store.join("worker", id);
		store.update(id, { coordinatorSessionId: "lead" });
		const task = store.addTask(id, { title: "Slice", sessionId: "worker" });
		for (const status of ["todo", "in_progress", "blocked", "in_review", "delegated", "done", "dropped"] as const)
			assert.throws(() => store.updateTask(id, task.id, { status }, { sessionId: "worker" }), /[Cc]oordinator/);
		assert.throws(
			() => store.completeTask(id, task.id, "worker", { commit: "a".repeat(40), checks: "Pass", issues: "" }),
			/[Cc]oordinator/,
		);
		assert.equal(store.task(id, task.id).status, "todo");
		assert.equal(store.completion(id, task.id), undefined);
	});
}

test("coordinator reconciles partial reports and dependencies without user acceptance", async (t) => {
	const store = new MissionStore(":memory:");
	t.after(() => store.close());
	const { id } = store.create({ projectId: "p", title: "Reconcile", planningVersion: 1 });
	for (const member of ["lead", "worker", "replacement"]) store.join(member, id);
	store.update(id, { coordinatorSessionId: "lead" });
	const prerequisite = store.addTask(id, { title: "Prerequisite" });
	const task = store.addTask(id, { title: "Broader task", sessionId: "worker", dependsOn: [prerequisite.id] });
	const reports = new MissionReports(store);
	const source = reports.source(id, "worker", task.id);
	const write = {
		version: 1 as const,
		reportId: "partial-delivery",
		taskId: task.id,
		source: source.source,
		expectedPreviousId: null,
		movement: "not_moving" as const,
		summary: "One increment shipped; prerequisite unresolved",
		nextStep: "Resolve prerequisite and remaining criteria",
		evidence: ["Focused checks"],
		delivery: { commit: "c".repeat(40), checks: "Focused parser test", issues: "Incomplete broader task" },
	};
	await reports.write(id, "worker", write);
	assert.equal(store.task(id, task.id).status, "todo");
	assert.equal(store.task(id, prerequisite.id).status, "todo");
	store.updateTask(id, task.id, { status: "blocked" }, { sessionId: "lead" });
	assert.equal((await reports.views(id))[0]!.currentness, "stale");
	await assert.rejects(reports.write(id, "worker", { ...write, reportId: "stale" }), /changed/);
	store.updateTask(id, prerequisite.id, { status: "done" }, { sessionId: "lead" });
	store.updateTask(id, task.id, { status: "in_progress" }, { sessionId: "lead" });
	store.update(id, { coordinatorSessionId: "replacement" });
	assert.throws(() => store.updateTask(id, task.id, { status: "done" }, { sessionId: "lead" }), /[Cc]oordinator/);
	assert.throws(() => store.completeTask(id, task.id, "lead", write.delivery), /[Cc]oordinator/);
	store.completeTask(id, task.id, "replacement", write.delivery);
	assert.equal(store.task(id, task.id).status, "done");
	// The verification service owns acceptance; task closure adds no verification record.
	assert.equal(store.taskOutputs(id, task.id).completion?.commit, write.delivery.commit);
	assert.equal(
		store.userVerifications.current(
			verificationKey({ kind: "task", projectId: "p", missionId: id, taskId: task.id }),
		),
		null,
	);
});
