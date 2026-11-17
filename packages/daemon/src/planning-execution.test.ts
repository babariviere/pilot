import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { SessionPullRequest, SessionSummary } from "@pilot/protocol";
import { PublishedStartRefused } from "./errors.ts";
import { MissionService } from "./mission-service.ts";
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
		throw new PublishedStartRefused("Waiting for a worker slot (2 occupied, reviewers included)");
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
	// The end of a sleep pause is such a change, even when no chat changes with it.
	const admitted: string[] = [];
	t.mock.method(f.sessions, "planningIdentity", () => ({ inputGeneration: 0, permission: { level: "build" } }));
	t.mock.method(f.sessions, "admitPublishedTask", async (_r: unknown, identity: { taskId: string }) => {
		admitted.push(identity.taskId);
		throw new Error("Waiting for a worker slot");
	});
	await f.sessions.pauseForSleep("100:1", true);
	await f.sessions.resumeAfterSleep();
	await f.workers.settleResearch();
	assert.equal(admitted.length, 1);
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

test("an uncertain automatic start keeps its identity when receipt and metadata are absent", async (t) => {
	const f = await publishedPlanningFixture(t, { twoSlices: true });
	const [first, second] = f.store.tasks(f.missionId);
	assert.ok(first && second);
	t.mock.method(f.sessions, "planningIdentity", () => ({ inputGeneration: 0, permission: { level: "build" } }));
	t.mock.method(f.sessions, "lookupPublishedTask", async () => false);
	const starts: string[] = [];
	t.mock.method(f.sessions, "admitPublishedTask", async (_request: unknown, identity: { operationId: string }) => {
		starts.push(identity.operationId);
		throw new Error("transport disconnected after admission may have entered");
	});
	f.store.join("worker-1", f.missionId);
	f.store.claimTask(f.missionId, first.id, "worker-1");
	const state = f.store.planningWorkers.get(f.missionId)!;
	f.store.planningWorkers.change(f.missionId, state.revision, (s) => {
		s.start = { operation: f.submit, sessionId: "worker-1", taskId: first.id, admitted: true };
	});
	f.workers.startResearch();
	f.store.updateTask(f.missionId, first.id, { status: "done" });
	await f.workers.settleResearch();
	const original = f.store.planningWorkers.get(f.missionId)!.autoStarts?.[0];
	assert.ok(original, "an ambiguous failure must keep the original attempt");
	assert.equal(original.taskId, second.id);
	assert.equal(original.state, "starting");
	f.store.updateTask(f.missionId, first.id, { body: first.body });
	await f.workers.settleResearch();
	assert.equal(f.store.planningWorkers.get(f.missionId)!.autoStarts?.[0]?.operationId, original.operationId);
	assert.deepEqual(starts, [original.operationId]);
	assert.match((await f.workers.startView(f.missionId)).reason, /unknown|not confirmed/i);
});

test("published file ownership serializes shared paths until the user checks the combined result", async (t) => {
	const f = await publishedPlanningFixture(t, { twoSlices: true, files: [["src/Search/"], ["tests/export.ts"]] });
	f.project.sourceCopy = "jj";
	delete f.project.workspace;
	const service = new MissionService(f.store, f.sessions, f.projects);
	t.after(() => service.dispose());
	const [first] = f.store.tasks(f.missionId);
	assert.ok(first);
	f.store.join("writer", f.missionId);
	f.store.claimTask(f.missionId, first.id, "writer");
	assert.match(f.sessions.codingCapacityReason(f.project.id, undefined, ["src/search/index.ts"]) ?? "", /shared-file/);
	assert.match(f.sessions.codingCapacityReason(f.project.id) ?? "", /shared-file/, "undeclared scope takes turns");
	assert.equal(f.sessions.codingCapacityReason(f.project.id, undefined, ["tests/export.ts"]), undefined);
	delete f.project.sourceCopy;
	assert.match(
		f.sessions.codingCapacityReason(f.project.id, undefined, ["src/search/index.ts"]) ?? "",
		/shared-file/,
		"ordinary Git projects also serialize overlapping published scopes",
	);
	assert.equal(f.sessions.codingCapacityReason(f.project.id, undefined, ["tests/export.ts"]), undefined);
	assert.match(f.store.task(f.missionId, first.id).body ?? "", /combined changes/);
	f.store.updateTask(f.missionId, first.id, { status: "done" });
	assert.equal(f.sessions.codingCapacityReason(f.project.id, undefined, ["src/search/index.ts"]), undefined);
});

test("one passive queue read shares one current capacity check across ready rows", async (t) => {
	const f = await publishedPlanningFixture(t, { twoSlices: true, independentSlices: true });
	const service = new MissionService(f.store, f.sessions, f.projects);
	t.after(() => service.dispose());
	const state = f.store.planningWorkers.get(f.missionId)!;
	f.store.planningWorkers.change(f.missionId, state.revision, (s) => {
		s.start = {
			operation: f.submit,
			sessionId: "original",
			taskId: f.store.tasks(f.missionId)[0]!.id,
			admitted: true,
		};
	});
	const capacity = t.mock.method(f.sessions, "codingCapacityReason", () => "Waiting for a coding slot");
	const before = capacity.mock.calls.length;
	assert.equal(service.executionView(f.missionId)?.total, 2);
	assert.equal(capacity.mock.calls.length - before, 1);
});

test("an uncertain first Start reserves only its task and independent ready work can proceed", async (t) => {
	const f = await publishedPlanningFixture(t, {
		twoSlices: true,
		independentSlices: true,
		files: [["src/import.ts"], ["src/export.ts"]],
	});
	f.project.sourceCopy = "jj";
	delete f.project.workspace;
	const service = new MissionService(f.store, f.sessions, f.projects);
	t.after(() => service.dispose());
	const [first, second] = f.store.tasks(f.missionId);
	assert.ok(first && second);
	t.mock.method(f.sessions, "planningIdentity", () => ({ inputGeneration: 0, permission: { level: "build" } }));
	t.mock.method(f.sessions, "lookupPublishedTask", async () => false);
	const admitted: string[] = [];
	t.mock.method(
		f.sessions,
		"admitPublishedTask",
		async (
			_request: unknown,
			identity: { sessionId: string; taskId: string; operationId: string },
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
	const state = f.store.planningWorkers.get(f.missionId)!;
	f.store.planningWorkers.change(f.missionId, state.revision, (s) => {
		s.start = { operation: f.submit, sessionId: "uncertain-first", taskId: first.id, admitted: false };
	});
	f.workers.startResearch();
	await f.workers.settleResearch();
	assert.deepEqual(admitted, [second.id]);
	assert.equal(f.store.task(f.missionId, first.id).sessionId, undefined);
	assert.equal(f.store.planningWorkers.get(f.missionId)!.start!.sessionId, "uncertain-first");
	assert.match(service.executionView(f.missionId)!.queue[0]!.reason, /unknown/);
});
