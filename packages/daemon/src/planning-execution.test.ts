import assert from "node:assert/strict";
import { test } from "node:test";
import { publishedPlanningFixture } from "./published-planning.fixture.ts";

test("after the user's Start, marking a task done starts the next ready task by rule", async (t) => {
	const f = await publishedPlanningFixture(t, { twoSlices: true });
	const [first, second] = f.store.plans
		.get(f.missionId)!
		.publication!.tasks.map((p) => f.store.task(f.missionId, p.taskId));
	assert.ok(first && second);
	assert.equal(f.store.plannedWithoutCoordinator(f.missionId), true);
	t.mock.method(f.sessions, "planningIdentity", () => ({ inputGeneration: 0, permission: { level: "build" } }));
	t.mock.method(f.sessions, "lookupPublishedTask", async () => false);
	const admitted: string[] = [];
	t.mock.method(
		f.sessions,
		"admitPublishedTask",
		async (
			_request: unknown,
			identity: { sessionId: string; operationId: string; taskId: string },
			guard: (claimed: boolean) => void,
		) => {
			guard(false);
			f.store.join(identity.sessionId, f.missionId);
			f.store.claimTask(f.missionId, identity.taskId, identity.sessionId);
			guard(true);
			admitted.push(identity.taskId);
			return { admissionId: identity.operationId, sessionId: identity.sessionId };
		},
	);
	// Nothing starts by rule before the user's own Start.
	f.workers.startResearch();
	await f.workers.settleResearch();
	assert.deepEqual(admitted, []);
	// The user's Start of the first task.
	f.store.join("worker-1", f.missionId);
	f.store.claimTask(f.missionId, first.id, "worker-1");
	const state = f.store.planningWorkers.get(f.missionId)!;
	f.store.planningWorkers.change(f.missionId, state.revision, (s) => {
		s.start = { operation: f.submit, sessionId: "worker-1", taskId: first.id, admitted: true };
	});
	await f.workers.settleResearch();
	assert.deepEqual(admitted, [], "the second task waits for the first");
	// The user marks the first result done; Pilot starts the second task once.
	f.store.updateTask(f.missionId, first.id, { status: "done" });
	await f.workers.settleResearch();
	assert.deepEqual(admitted, [second.id]);
	assert.equal(f.store.task(f.missionId, second.id).status, "in_progress");
	assert.deepEqual(
		f.store.planningWorkers.get(f.missionId)!.autoStarts?.map((a) => [a.taskId, a.state]),
		[[second.id, "admitted"]],
	);
	f.store.updateTask(f.missionId, first.id, { body: first.body });
	await f.workers.settleResearch();
	assert.deepEqual(admitted, [second.id], "a later change starts nothing again");
});

test("a refused start by rule is forgotten and waits before the next try", async (t) => {
	const f = await publishedPlanningFixture(t, { twoSlices: true });
	const [first] = f.store.plans.get(f.missionId)!.publication!.tasks.map((p) => f.store.task(f.missionId, p.taskId));
	t.mock.method(f.sessions, "planningIdentity", () => ({ inputGeneration: 0, permission: { level: "build" } }));
	let calls = 0;
	t.mock.method(f.sessions, "admitPublishedTask", async () => {
		calls++;
		throw new Error("Waiting for a worker slot (2 occupied, reviewers included)");
	});
	f.store.join("worker-1", f.missionId);
	f.store.claimTask(f.missionId, first!.id, "worker-1");
	const state = f.store.planningWorkers.get(f.missionId)!;
	f.store.planningWorkers.change(f.missionId, state.revision, (s) => {
		s.start = { operation: f.submit, sessionId: "worker-1", taskId: first!.id, admitted: true };
	});
	f.workers.startResearch();
	f.store.updateTask(f.missionId, first!.id, { status: "done" });
	await f.workers.settleResearch();
	assert.equal(calls, 1);
	assert.deepEqual(f.store.planningWorkers.get(f.missionId)!.autoStarts ?? [], [], "nothing was created");
	f.store.updateTask(f.missionId, first!.id, { body: first!.body });
	await f.workers.settleResearch();
	assert.equal(calls, 1, "no tight loop: the next try waits");
});
