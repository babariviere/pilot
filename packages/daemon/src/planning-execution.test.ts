import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { SessionPullRequest, SessionSummary } from "@pilot/protocol";
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

test("a ready task Pilot cannot start shows why on the planning page", async (t) => {
	const f = await publishedPlanningFixture(t, { twoSlices: true });
	const [first] = f.store.plans.get(f.missionId)!.publication!.tasks.map((p) => f.store.task(f.missionId, p.taskId));
	t.mock.method(f.sessions, "planningIdentity", () => ({ inputGeneration: 1, permission: { level: "build" } }));
	f.store.join("worker-1", f.missionId);
	f.store.claimTask(f.missionId, first!.id, "worker-1");
	const state = f.store.planningWorkers.get(f.missionId)!;
	f.store.planningWorkers.change(f.missionId, state.revision, (s) => {
		s.start = { operation: f.submit, sessionId: "worker-1", taskId: first!.id, admitted: true };
	});
	f.workers.startResearch();
	await f.workers.settleResearch();
	assert.doesNotMatch((await f.workers.startView(f.missionId)).reason, /could not start/, "nothing is ready yet");
	f.store.updateTask(f.missionId, first!.id, { status: "done" });
	await f.workers.settleResearch();
	assert.equal(
		(await f.workers.startView(f.missionId)).reason,
		"Work started. Pilot could not start the next ready task: Planning owner was stopped or reconfigured; Start unavailable It tries again on the next change.",
	);
});

test("a merged PR that owns a planned task finishes it, and Pilot starts what it unblocks", async (t) => {
	const f = await publishedPlanningFixture(t, { twoSlices: true });
	const [first, second] = f.store.plans
		.get(f.missionId)!
		.publication!.tasks.map((p) => f.store.task(f.missionId, p.taskId));
	t.mock.method(f.sessions, "planningIdentity", () => ({ inputGeneration: 0, permission: { level: "build" } }));
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
	f.store.join("worker-1", f.missionId);
	f.store.claimTask(f.missionId, first!.id, "worker-1");
	const state = f.store.planningWorkers.get(f.missionId)!;
	f.store.planningWorkers.change(f.missionId, state.revision, (s) => {
		s.start = { operation: f.submit, sessionId: "worker-1", taskId: first!.id, admitted: true };
	});
	const url = "https://github.com/o/r/pull/7";
	f.store.addResource(f.missionId, { taskId: first!.id, url });
	const chat = { id: "worker-1", title: "Importer", state: "idle" } as SessionSummary;
	const pr = (state: "open" | "merged"): SessionPullRequest => ({
		number: 7,
		url,
		title: "Importer",
		state,
		checkedAt: Date.now() + 1000,
		...(state === "merged" ? { mergedAt: Date.now() + 1000 } : {}),
	});
	f.workers.startResearch();
	f.store.recordMemberPullRequests(chat, [pr("open")]);
	await f.workers.settleResearch();
	assert.deepEqual(admitted, []);
	f.store.recordMemberPullRequests(chat, [pr("merged")]);
	await f.workers.settleResearch();
	assert.equal(f.store.task(f.missionId, first!.id).status, "done");
	assert.deepEqual(admitted, [second!.id]);
});

test("tasks a confirmed revision adds join the published plan and start by rule", async (t) => {
	const f = await publishedPlanningFixture(t, { twoSlices: true });
	const [first, second] = f.store.plans
		.get(f.missionId)!
		.publication!.tasks.map((p) => f.store.task(f.missionId, p.taskId));
	assert.ok(first && second);
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
	f.store.join("worker-1", f.missionId);
	f.store.claimTask(f.missionId, first.id, "worker-1");
	const state = f.store.planningWorkers.get(f.missionId)!;
	f.store.planningWorkers.change(f.missionId, state.revision, (s) => {
		s.start = { operation: f.submit, sessionId: "worker-1", taskId: first.id, admitted: true };
	});
	const proposal = await f.store.revisions.propose(
		f.missionId,
		{
			operationId: randomUUID(),
			source: f.store.revisions.source(f.missionId),
			summary: "Add an export",
			delta: {
				newTasks: [{ key: "export", title: "Export chats", body: "Outcome: export.", dependsOn: [first.id] }],
			},
		},
		{ sessionId: f.owner },
	);
	f.workers.startResearch();
	await f.workers.settleResearch();
	assert.deepEqual(admitted, [], "a proposal adds and starts nothing");
	await f.store.revisions.confirm(f.missionId, proposal.id, { digest: proposal.digest, humanSource: "user:answer" });
	const added = f.store.tasks(f.missionId).find((task) => task.title === "Export chats")!;
	const publication = f.store.plans.get(f.missionId)!.publication!;
	assert.deepEqual(
		publication.tasks.map((p) => [p.taskId, !!p.definition]),
		[
			[first.id, true],
			[second.id, true],
			[added.id, true],
		],
	);
	assert.equal(publication.tasks[2]!.sliceId, `revision:${proposal.id}:export`);
	assert.equal(publication.briefRevision, f.store.brief(f.missionId)!.revision);
	await f.workers.settleResearch();
	assert.deepEqual(admitted, [], "the new task waits for its dependency");
	f.store.updateTask(f.missionId, first.id, { status: "done" });
	await f.workers.settleResearch();
	assert.deepEqual(admitted.sort(), [second.id, added.id].sort());
	assert.equal(f.store.task(f.missionId, added.id).status, "in_progress");
});
