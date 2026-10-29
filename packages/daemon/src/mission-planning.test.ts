import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { MissionAssignmentWrite, MissionTaskWrite } from "@pilot/protocol";
import { MissionStore } from "./missions.ts";

const assignment: MissionAssignmentWrite = {
	version: 1,
	expectedRevision: 0,
	intent: "Reject unauthorized planning writes",
	scope: "Daemon and protocol only. No UI or migration.",
	criteria: ["Workers cannot rewrite criteria"],
};

function fixture(t: { after(fn: () => void): void }, planningVersion?: 1) {
	const store = new MissionStore(":memory:");
	t.after(() => store.close());
	const { id } = store.create({ projectId: "p", title: "Planning", planningVersion });
	for (const session of ["lead", "worker", "other"]) store.join(session, id);
	store.update(id, { coordinatorSessionId: "lead" });
	const task = store.addTask(id, {
		title: "Guard writes",
		body: "Original definition",
		sessionId: "worker",
		...(planningVersion ? { assignment } : {}),
	});
	return { store, id, task, worker: { sessionId: "worker" }, lead: { sessionId: "lead" } };
}

test("planning v1 rejects worker planning writes without changing state", (t) => {
	const { store, id, task, worker } = fixture(t, 1);
	const phase = store.addPhase(id, { name: "Foundation" });
	const before = store.detail(id);
	const denied = [
		() => store.writeBrief(id, "Weakened", 0, worker),
		() => store.addDecision(id, "Weakened", worker, "all"),
		() => store.update(id, { goal: "Expanded" }, worker),
		() => store.update(id, { coordinatorSessionId: "worker" }, worker),
		() => store.addTask(id, { title: "Expanded" }, worker),
		() => store.removeTask(id, task.id, worker),
		() => store.groupTasks(id, [task.id], "Expanded", worker),
		() => store.addPhase(id, { name: "Expanded" }, worker),
		() => store.updatePhase(id, phase.id, { name: "Expanded" }, worker),
		() => store.removePhase(id, phase.id, worker),
		() => store.claimTask(id, task.id, "worker", worker),
		() => store.claimTasks(id, [task.id], "worker", worker),
		() => store.releaseTask(id, task.id, worker),
		() => store.releaseTasks(id, [task.id], worker),
		() => store.completeTask(id, task.id, "worker", { commit: "a".repeat(40), checks: "Pass", issues: "" }),
	];
	const definitions: MissionTaskWrite[] = [
		{ title: "Expanded" },
		{ body: "Weakened" },
		{ decisionIds: [] },
		{ dependsOn: [] },
		{ order: 0 },
		{ phaseId: phase.id },
		{ milestone: "Expanded" },
		{ preferredModel: "x/y" },
		{ sessionId: "other" },
		{ assignment: { ...assignment, expectedRevision: 1 } },
		{ status: "done" },
		{ status: "dropped" },
		{ status: "delegated" },
		{ status: "todo" },
	];
	for (const write of definitions) denied.push(() => store.updateTask(id, task.id, write, worker));
	for (const call of denied) assert.throws(call, /[Cc]oordinator|coordinator\/user/);
	assert.deepEqual(store.detail(id), before);
});

test("planning v1 permits own execution reports and proposals, not another worker's status", (t) => {
	const { store, id, task, worker, lead } = fixture(t, 1);
	const original = task.assignment;
	for (const status of ["in_progress", "blocked", "in_review"] as const)
		assert.equal(store.updateTask(id, task.id, { status }, worker).status, status);
	store.log(id, { text: "Verified denial; one unknown remains" }, worker);
	store.addComment(id, { text: "Propose one additional criterion; please approve" }, worker);
	assert.throws(
		() => store.updateTask(id, task.id, { status: "blocked" }, { sessionId: "other" }),
		/workers may only/,
	);
	assert.deepEqual(store.task(id, task.id).assignment, original);
	assert.equal(store.detail(id).comments[0]?.authorSessionId, "worker");
	store.updateTask(id, task.id, { status: "done" }, lead);
	assert.throws(() => store.updateTask(id, task.id, { status: "in_progress" }, worker), /workers may only/);
	assert.equal(store.retiredMember("worker"), false, "no automatic retirement in this foundation");
});

test("coordinator/user author definitions; assignment and brief writes reject stale revisions atomically", (t) => {
	const { store, id, task, lead } = fixture(t, 1);
	store.writeBrief(id, "Approved intent", 0, lead);
	assert.throws(() => store.writeBrief(id, "Stale intent", 0), /Brief revision conflict/);
	const decision = store.addDecision(id, "Relevant invariant", lead, "reference");
	const changed = store.updateTask(
		id,
		task.id,
		{
			assignment: { ...assignment, expectedRevision: 1, criteria: ["Prove worker denial", "Keep legacy behavior"] },
			decisionIds: [decision.id],
			body: "Revised definition",
		},
		lead,
	);
	assert.equal(changed.assignment?.revision, 2);
	assert.deepEqual(changed.decisionIds, [decision.id]);
	assert.throws(
		() => store.updateTask(id, task.id, { assignment: { ...assignment, expectedRevision: 1 }, title: "Stale" }),
		/Assignment revision conflict/,
	);
	assert.equal(store.task(id, task.id).title, task.title);
	assert.equal(store.task(id, task.id).assignment?.revision, 2);
	store.updateTask(id, task.id, { assignment: { ...assignment, expectedRevision: 2 }, sessionId: "other" }, lead);
	assert.equal(store.task(id, task.id).sessionId, "other");
	store.updateTask(id, task.id, { assignment: { ...assignment, expectedRevision: 3 } });
	assert.equal(store.task(id, task.id).assignment?.revision, 4);
	assert.throws(
		() => store.updateTask(id, task.id, { status: "blocked" }, { sessionId: "outsider" }),
		/not in this mission/,
	);
	store.update(id, { coordinatorSessionId: "other" });
	assert.throws(() => store.writeBrief(id, "Old lead", 1, lead), /Coordinator-owned/);
	// Existing user-only decision editing is not weakened by coordinator planning ownership.
	assert.throws(() => store.updateDecision(id, decision.id, "Replacement", lead), /Only the user/);
	store.updateDecision(id, decision.id, "User replacement");
});

test("assignment writes are strict; missing opt-in and unknown versions never adopt implicitly", (t) => {
	const { store, id, task } = fixture(t, 1);
	for (const invalid of [
		null,
		[],
		{},
		{ ...assignment, expectedRevision: 1, version: 2 },
		{ ...assignment, expectedRevision: -1 },
		{ ...assignment, expectedRevision: 1.5 },
		{ ...assignment, expectedRevision: 1, revision: 1 },
		{ ...assignment, expectedRevision: 1, intent: " " },
		{ ...assignment, expectedRevision: 1, scope: "x".repeat(4001) },
		{ ...assignment, expectedRevision: 1, criteria: [] },
		{ ...assignment, expectedRevision: 1, criteria: [null] },
		{ ...assignment, expectedRevision: 1, criteria: Array(21).fill("criterion") },
		{ ...assignment, expectedRevision: 1, criteria: ["😀".repeat(1001)] },
	]) {
		assert.throws(
			() => store.updateTask(id, task.id, { assignment: invalid } as MissionTaskWrite),
			/assignment|Assignment/,
		);
		assert.equal(store.task(id, task.id).assignment?.revision, 1);
	}
	assert.throws(
		() => store.updateTask(id, task.id, { surprise: true } as MissionTaskWrite),
		/Unknown planning write field/,
	);
	assert.throws(
		() => store.create({ projectId: "p", title: "Bad", planningVersion: 2 as 1 }),
		/Unsupported planningVersion/,
	);
	assert.throws(() => store.update(id, { planningVersion: undefined } as never), /creation-only/);
	const legacy = store.create({ projectId: "p", title: "Legacy" });
	assert.equal(legacy.planningVersion, undefined);
	assert.throws(() => store.addTask(legacy.id, { title: "No adoption", assignment }), /requires planningVersion 1/);
	assert.throws(() => store.update(legacy.id, { planningVersion: 1 } as never), /creation-only/);
	// Future stored contracts stay inspectable; this binary cannot write them as v1.
	store["run"]("UPDATE missions SET planning_version = 2 WHERE id = ?", id);
	assert.equal(store.detail(id).mission.planningVersion, 2);
	assert.throws(() => store.writeBrief(id, "Unsupported", 0), /Unsupported mission planning version/);
	assert.throws(() => store.updateTask(id, task.id, { body: "Unsupported" }), /Unsupported mission planning version/);
	store["run"]("UPDATE missions SET planning_version = 1 WHERE id = ?", id);
	const future = {
		version: 2,
		revision: 9,
		intent: "Future intent",
		scope: "Future scope",
		criteria: ["x".repeat(1001)],
	};
	store["run"]("UPDATE tasks SET assignment = ? WHERE id = ?", JSON.stringify(future), task.id);
	assert.deepEqual(store.task(id, task.id).assignment, future, "reads do not revalidate or truncate stored contracts");
	assert.throws(
		() => store.updateTask(id, task.id, { assignment: { ...assignment, expectedRevision: 9 } }),
		/Unsupported assignment version/,
	);
});

test("PR observations remain evidence, not opted-in coordinator completion", (t) => {
	const { store, id, task, worker, lead } = fixture(t, 1);
	const url = "https://github.com/octo/repo/pull/1";
	store.updateTask(id, task.id, { status: "in_progress" }, worker);
	store.addResource(id, { url, taskId: task.id }, worker);
	store.updatePullRequest({ number: 1, state: "merged", url, title: "Work", checkedAt: Date.now() });
	assert.equal(store.task(id, task.id).status, "in_progress");
	assert.equal(store.detail(id).resources[0]?.pullRequest?.state, "merged");
	store.updateTask(id, task.id, { status: "done" }, lead);
	assert.equal(store.task(id, task.id).status, "done");
});

test("legacy workers retain existing planning and completion; additive fields survive durable reopen", async (t) => {
	const legacy = fixture(t);
	legacy.store.writeBrief(legacy.id, "Legacy worker brief", 0, legacy.worker);
	legacy.store.addDecision(legacy.id, "Legacy worker decision", legacy.worker);
	legacy.store.addTask(legacy.id, { title: "Legacy follow-up" }, legacy.worker);
	legacy.store.updateTask(legacy.id, legacy.task.id, { body: "Legacy worker definition" }, legacy.worker);
	legacy.store.completeTask(legacy.id, legacy.task.id, "worker", {
		commit: "a".repeat(40),
		checks: "Legacy checks",
		issues: "",
	});
	assert.equal(legacy.store.task(legacy.id, legacy.task.id).status, "done");
	const home = mkdtempSync(join(tmpdir(), "pilot-planning-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const path = join(home, "missions.sqlite");
	const store = new MissionStore(path);
	const { id } = store.create({ projectId: "p", title: "Durable", planningVersion: 1 });
	const task = store.addTask(id, { title: "Durable assignment", assignment });
	await store.durable();
	store.close();
	const reopened = new MissionStore(path);
	t.after(() => reopened.close());
	assert.equal(reopened.require(id).planningVersion, 1);
	assert.deepEqual(reopened.task(id, task.id).assignment, task.assignment);
});
