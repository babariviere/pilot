import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { SessionPullRequest, SessionSummary } from "@pilot/protocol";
import { PublishedStartRefused } from "./errors.ts";
import { MissionReports } from "./mission-reports.ts";
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
	f.workers.startReconciling();
	await f.workers.settleReconciling();
	assert.deepEqual(admitted, []);
	// The user's Start of the first task.
	f.store.join("worker-1", f.missionId);
	f.store.claimTask(f.missionId, first.id, "worker-1");
	const state = f.store.planningWorkers.get(f.missionId)!;
	f.store.planningWorkers.change(f.missionId, state.revision, (s) => {
		s.start = { operation: f.submit, sessionId: "worker-1", taskId: first.id, admitted: true };
	});
	await f.workers.settleReconciling();
	assert.deepEqual(admitted, [], "the second task waits for the first");
	// The user marks the first result done; Pilot starts the second task once.
	f.store.updateTask(f.missionId, first.id, { status: "done" });
	await f.workers.settleReconciling();
	assert.deepEqual(admitted, [second.id]);
	assert.equal(f.store.task(f.missionId, second.id).status, "in_progress");
	assert.deepEqual(
		f.store.planningWorkers.get(f.missionId)!.autoStarts?.map((a) => [a.taskId, a.state]),
		[[second.id, "admitted"]],
	);
	f.store.updateTask(f.missionId, first.id, { body: first.body });
	await f.workers.settleReconciling();
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
	f.workers.startReconciling();
	f.store.updateTask(f.missionId, first!.id, { status: "done" });
	await f.workers.settleReconciling();
	assert.equal(calls, 1);
	assert.deepEqual(f.store.planningWorkers.get(f.missionId)!.autoStarts ?? [], [], "nothing was created");
	f.store.updateTask(f.missionId, first!.id, { body: first!.body });
	await f.workers.settleReconciling();
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
	f.workers.startReconciling();
	await f.workers.settleReconciling();
	assert.doesNotMatch((await f.workers.startView(f.missionId)).reason, /could not start/, "nothing is ready yet");
	f.store.updateTask(f.missionId, first!.id, { status: "done" });
	await f.workers.settleReconciling();
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
	await f.workers.settleReconciling();
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
	// The worker uses the project folder, so it has no saved upstream: the project folder's origin names the repository.
	execFileSync("git", ["init", "-q", f.project.path]);
	execFileSync("git", ["-C", f.project.path, "remote", "add", "origin", "git@github.com:o/r.git"]);
	const service = new MissionService(f.store, f.sessions, f.projects);
	t.after(() => service.dispose());
	await service.readProjectRepositories();
	const chat = { id: "worker-1", title: "Importer", state: "idle" } as SessionSummary;
	const pr = (state: "open" | "merged"): SessionPullRequest => ({
		number: 7,
		url,
		title: "Importer",
		state,
		checkedAt: Date.now() + 1000,
		...(state === "merged" ? { mergedAt: Date.now() + 1000 } : {}),
	});
	f.workers.startReconciling();
	f.store.recordMemberPullRequests(chat, [pr("open")]);
	await f.workers.settleReconciling();
	assert.deepEqual(admitted, []);
	f.store.recordMemberPullRequests(chat, [pr("merged")]);
	await f.workers.settleReconciling();
	assert.equal(f.store.task(f.missionId, first!.id).status, "done");
	assert.deepEqual(admitted, [second!.id]);
});

test("a merged PR in another repository, or on a task that is not moving, leaves the task unfinished", async (t) => {
	const f = await publishedPlanningFixture(t, { twoSlices: true });
	const [first] = f.store.plans.get(f.missionId)!.publication!.tasks.map((p) => f.store.task(f.missionId, p.taskId));
	t.mock.method(f.sessions, "planningIdentity", () => ({ inputGeneration: 0, permission: { level: "build" } }));
	const admitted: string[] = [];
	t.mock.method(f.sessions, "admitPublishedTask", async (_request: unknown, identity: { taskId: string }) => {
		admitted.push(identity.taskId);
		throw new Error("No task should start");
	});
	f.store.join("worker-1", f.missionId);
	f.store.claimTask(f.missionId, first!.id, "worker-1");
	const state = f.store.planningWorkers.get(f.missionId)!;
	f.store.planningWorkers.change(f.missionId, state.revision, (s) => {
		s.start = { operation: f.submit, sessionId: "worker-1", taskId: first!.id, admitted: true };
	});
	f.store.projectRepository = () => "github.com/o/r";
	const chat = { id: "worker-1", title: "Importer", state: "idle" } as SessionSummary;
	const merge = async (url: string, number: number) => {
		f.store.addResource(f.missionId, { taskId: first!.id, url });
		const pr = (state: "open" | "merged"): SessionPullRequest => ({
			number,
			url,
			title: "Schema",
			state,
			checkedAt: Date.now() + 1000,
			...(state === "merged" ? { mergedAt: Date.now() + 1000 } : {}),
		});
		f.store.recordMemberPullRequests(chat, [pr("open")]);
		f.store.recordMemberPullRequests(chat, [pr("merged")]);
		await f.workers.settleReconciling();
		return f.store
			.activity(f.missionId, { kind: "update", limit: 100 })
			.find((e) => e.text.includes(`PR #${number} `))?.text;
	};
	f.workers.startReconciling();
	// A prerequisite PR in another repository does not finish the task.
	const other = await merge("https://github.com/stoikio/eventbus-schema/pull/239", 239);
	assert.equal(f.store.task(f.missionId, first!.id).status, "in_progress");
	assert.match(
		other ?? "",
		new RegExp(
			`PR #239 merged; task #${first!.number} stays in progress: the PR is in github.com/stoikio/eventbus-schema, not this project's repository github.com/o/r`,
		),
	);
	// An own-repository PR does not finish a task whose worker says it is not moving.
	const reports = new MissionReports(f.store);
	const source = reports.source(f.missionId, "worker-1", first!.id);
	await reports.write(f.missionId, "worker-1", {
		version: 1,
		reportId: "waiting",
		taskId: first!.id,
		source: source.source,
		expectedPreviousId: source.expectedPreviousId,
		movement: "not_moving",
		summary: "Consumer half is ready.",
		nextStep: "wait for a published shared-schema release",
		evidence: ["local build"],
		delivery: { commit: "c".repeat(40), checks: "Local build", issues: "Needs the schema release" },
	});
	const own = await merge("https://github.com/o/r/pull/8", 8);
	assert.equal(f.store.task(f.missionId, first!.id).status, "in_progress");
	assert.match(own ?? "", /PR #8 merged; task #\d+ stays in progress: its latest report says it is not moving/);
	assert.deepEqual(admitted, [], "nothing it blocks starts");
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
	f.workers.startReconciling();
	await f.workers.settleReconciling();
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
	await f.workers.settleReconciling();
	assert.deepEqual(admitted, [], "the new task waits for its dependency");
	f.store.updateTask(f.missionId, first.id, { status: "done" });
	await f.workers.settleReconciling();
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
	f.workers.startReconciling();
	f.store.updateTask(f.missionId, first.id, { status: "done" });
	await f.workers.settleReconciling();
	const original = f.store.planningWorkers.get(f.missionId)!.autoStarts?.[0];
	assert.ok(original, "an ambiguous failure must keep the original attempt");
	assert.equal(original.taskId, second.id);
	assert.equal(original.state, "starting");
	f.store.updateTask(f.missionId, first.id, { body: first.body });
	await f.workers.settleReconciling();
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
	assert.equal(f.sessions.codingCapacityReason(f.project.id), undefined, "undeclared scope runs alongside");
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
	f.workers.startReconciling();
	await f.workers.settleReconciling();
	assert.deepEqual(admitted, [second.id]);
	assert.equal(f.store.task(f.missionId, first.id).sessionId, undefined);
	assert.equal(f.store.planningWorkers.get(f.missionId)!.start!.sessionId, "uncertain-first");
	assert.match(service.executionView(f.missionId)!.queue[0]!.reason, /unknown/);
});

test("more stopped open tasks than coding slots take the slots in order instead of waiting on each other", async (t) => {
	const f = await publishedPlanningFixture(t, { twoSlices: true, independentSlices: true });
	delete f.project.sourceCopy;
	delete f.project.workspace;
	const service = new MissionService(f.store, f.sessions, f.projects);
	t.after(() => service.dispose());
	const [first, second] = f.store.tasks(f.missionId);
	assert.ok(first && second);
	const third = f.store.addTask(f.missionId, { title: "Third slice", body: "Independent." });
	for (const [writer, task] of [
		["writer-1", first],
		["writer-2", second],
		["writer-3", third],
	] as const) {
		f.store.join(writer, f.missionId);
		f.store.claimTask(f.missionId, task.id, writer);
	}
	// None of them runs: they were stopped with their tasks still open, and the limit is two. The earliest two take
	// the slots, so the third waits for them rather than all waiting on each other.
	assert.equal(f.sessions.codingCapacityReason(f.project.id, "writer-1"), undefined);
	assert.equal(f.sessions.codingCapacityReason(f.project.id, "writer-2"), undefined);
	assert.match(f.sessions.codingCapacityReason(f.project.id, "writer-3") ?? "", /2 of 2 occupied/);
	assert.match(f.sessions.codingCapacityReason(f.project.id) ?? "", /2 of 2 occupied/, "other chats still wait");
	f.store.updateTask(f.missionId, first.id, { status: "done" });
	assert.equal(f.sessions.codingCapacityReason(f.project.id, "writer-3"), undefined);
});

test("a queued chat's place in line and slot holders follow the order the slots go", async (t) => {
	const f = await publishedPlanningFixture(t, {
		twoSlices: true,
		independentSlices: true,
		files: [["src/search/"], ["src/search/index.ts"]],
	});
	delete f.project.sourceCopy;
	delete f.project.workspace;
	const service = new MissionService(f.store, f.sessions, f.projects);
	t.after(() => service.dispose());
	const [first, second] = f.store.tasks(f.missionId);
	assert.ok(first && second);
	const third = f.store.addTask(f.missionId, { title: "Third slice", body: "Independent." });
	const metas = f.sessions["metas"];
	const chat = (id: string, title: string) =>
		metas.set(id, { id, title, projectId: f.project.id, cwd: "/", createdAt: 1, updatedAt: 1 } as never);
	for (const [writer, task, title] of [
		["writer-1", first, "Search index"],
		["writer-2", second, "Export tests"],
		["writer-3", third, "Third slice"],
	] as const) {
		f.store.join(writer, f.missionId);
		f.store.claimTask(f.missionId, task.id, writer);
		chat(writer, title);
	}
	chat("solo", "Standalone fix");
	const emitted: string[] = [];
	t.mock.method(f.sessions as unknown as { emit(meta: { id: string }): void }, "emit", (meta: { id: string }) => {
		emitted.push(meta.id);
	});
	// Queued first, the standalone chat still goes after every open task; the tasks go in reservation order.
	const queue = f.sessions["codingQueue"];
	queue.set("solo", "Waiting for a project coding slot (2 of 2 occupied).");
	queue.set("writer-3", "Waiting for a project coding slot (2 of 2 occupied).");
	queue.set("writer-2", "Waiting for shared-file ownership.");
	f.sessions["refreshCodingQueueViews"]();
	const views = f.sessions["codingQueueViews"];
	// Overlapping declared files take turns: the second task waits for the first, named by its task.
	assert.deepEqual(views.get("writer-2"), { kind: "files", position: 1, holders: ["Search index"] });
	assert.deepEqual(views.get("writer-3"), { kind: "slots", position: 2, holders: ["Search index", "Export tests"] });
	assert.deepEqual(views.get("solo"), {
		kind: "slots",
		position: 3,
		holders: ["Search index", "Export tests", "Third slice"],
	});
	assert.deepEqual(emitted.sort(), ["solo", "writer-2", "writer-3"]);
	emitted.length = 0;
	f.sessions["refreshCodingQueueViews"]();
	assert.deepEqual(emitted, [], "an unchanged view emits nothing");
	// The second task leaves the line: the others move up and only they emit.
	queue.delete("writer-2");
	f.sessions["refreshCodingQueueViews"]();
	assert.equal(views.get("writer-3")?.position, 1);
	assert.equal(views.get("solo")?.position, 2);
	assert.equal(views.has("writer-2"), false);
	assert.deepEqual(emitted.sort(), ["solo", "writer-3"]);
});

test("a task whose chat waits for the user frees its coding slot; overlapping files still wait", async (t) => {
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
	for (const [writer, task] of [
		["writer-1", first],
		["writer-2", second],
	] as const) {
		f.store.join(writer, f.missionId);
		f.store.claimTask(f.missionId, task.id, writer);
	}
	const other = ["src/other.ts"];
	assert.match(f.sessions.codingCapacityReason(f.project.id, undefined, other) ?? "", /2 of 2 occupied/);
	const chats = new Map<string, Partial<SessionSummary>>();
	const real = f.sessions.get.bind(f.sessions);
	t.mock.method(f.sessions, "get", (id: string) =>
		chats.has(id)
			? ({ id, title: id, cwd: "/", createdAt: 1, updatedAt: 1, state: "idle", ...chats.get(id) } as SessionSummary)
			: real(id),
	);
	// A pending question and a chat waiting for a reply hold no slot.
	chats.set("writer-1", { outcome: "question" });
	chats.set("writer-2", { outcome: "done", waitsForReply: true });
	assert.equal(f.sessions.codingCapacityReason(f.project.id, undefined, other), undefined);
	assert.match(
		f.sessions.codingCapacityReason(f.project.id, undefined, ["src/import.ts"]) ?? "",
		/shared-file/,
		"their files still count",
	);
	// A result delivered since the chat's last input waits for the user's check: no slot either.
	const delivered = t.mock.method(f.store.controls, "latestDeliveryReport", () => ({ reportedAt: 20 }));
	chats.set("writer-1", { working: true, state: "working" });
	chats.set("writer-2", { outcome: "done", lastUserMessageAt: 10 });
	assert.equal(f.sessions.codingCapacityReason(f.project.id, undefined, other), undefined);
	// A send-back (a newer input) or work in progress takes the slot back.
	chats.set("writer-2", { outcome: "done", lastUserMessageAt: 30 });
	assert.match(f.sessions.codingCapacityReason(f.project.id, undefined, other) ?? "", /2 of 2 occupied/);
	delivered.mock.restore();
});

test("a builder that ended its turn with no result and no question is reminded once per turn", async (t) => {
	const f = await publishedPlanningFixture(t, { twoSlices: true, independentSlices: true });
	const service = new MissionService(f.store, f.sessions, f.projects);
	t.after(() => service.dispose());
	const [first, second] = f.store.tasks(f.missionId);
	assert.ok(first && second);
	f.store.join("builder", f.missionId);
	f.store.claimTask(f.missionId, first.id, "builder");
	f.store.join("explorer", f.missionId, {}, "explorer");
	f.store.claimTask(f.missionId, second.id, "explorer");
	// biome-ignore lint/complexity/useLiteralKeys: the bridge the session manager reads
	const bridge = f.sessions["missions"]!;
	assert.equal(bridge.waitsForReply?.("builder", 5), true, "open task, nothing delivered since the input");
	assert.equal(bridge.waitsForReply?.("explorer", 5), false, "explorers are not reminded");
	assert.equal(bridge.waitsForReply?.("stranger", 5), false);
	const delivered = t.mock.method(f.store.controls, "latestDeliveryReport", () => ({ reportedAt: 6 }));
	assert.equal(bridge.waitsForReply?.("builder", 5), false, "it delivered since the input");
	assert.equal(bridge.waitsForReply?.("builder", 7), true, "an older delivery does not count");
	delivered.mock.restore();
	const chats = new Map<string, Partial<SessionSummary>>();
	t.mock.method(f.sessions, "get", (id: string) =>
		chats.has(id)
			? ({ id, title: id, cwd: "/", createdAt: 1, updatedAt: 1, state: "idle", ...chats.get(id) } as SessionSummary)
			: undefined,
	);
	const sent: string[] = [];
	t.mock.method(f.sessions, "sendWaitNudge", async (id: string) => {
		sent.push(id);
		return true;
	});
	chats.set("builder", { missionId: f.missionId, working: true, state: "working" });
	service.nudgeWaitingBuilders();
	assert.deepEqual(sent, [], "a working chat is not reminded");
	chats.set("builder", { missionId: f.missionId, outcome: "done", outcomeAt: 6, lastUserMessageAt: 5 });
	service.nudgeWaitingBuilders();
	service.nudgeWaitingBuilders();
	assert.deepEqual(sent, ["builder"], "checked once per turn; SessionManager keeps it once per input");
	chats.set("builder", { missionId: f.missionId, outcome: "done", outcomeAt: 9, lastUserMessageAt: 8 });
	service.nudgeWaitingBuilders();
	assert.deepEqual(sent, ["builder", "builder"]);
	for (const change of [{ outcome: "question" as const }, { outcome: "stopped" as const }, { mode: "ask" as const }]) {
		chats.set("builder", {
			missionId: f.missionId,
			outcome: "done",
			outcomeAt: 12,
			lastUserMessageAt: 11,
			...change,
		});
		service.nudgeWaitingBuilders();
	}
	assert.equal(sent.length, 2, "questions, Stops and Ask chats are never reminded");
});

test("open tasks of an archived mission hold no coding slot", async (t) => {
	const f = await publishedPlanningFixture(t, { twoSlices: true, independentSlices: true });
	delete f.project.sourceCopy;
	delete f.project.workspace;
	const service = new MissionService(f.store, f.sessions, f.projects);
	t.after(() => service.dispose());
	const [first, second] = f.store.tasks(f.missionId);
	assert.ok(first && second);
	for (const [writer, task] of [
		["old-1", first],
		["old-2", second],
	] as const) {
		f.store.join(writer, f.missionId);
		f.store.claimTask(f.missionId, task.id, writer);
	}
	assert.match(f.sessions.codingCapacityReason(f.project.id) ?? "", /occupied|take turns/);
	f.store.update(f.missionId, { status: "archived" });
	assert.equal(f.sessions.codingCapacityReason(f.project.id), undefined);
});

test("tasks with unknown scopes run side by side; a task waiting on a running task's files holds no slot", async (t) => {
	const f = await publishedPlanningFixture(t, {
		twoSlices: true,
		independentSlices: true,
		files: [["src/search/"], ["src/search/index.ts"]],
	});
	f.project.sourceCopy = "jj";
	delete f.project.workspace;
	const service = new MissionService(f.store, f.sessions, f.projects);
	t.after(() => service.dispose());
	const [first, second] = f.store.tasks(f.missionId);
	assert.ok(first && second);
	for (const [writer, task] of [
		["writer-1", first],
		["writer-2", second],
	] as const) {
		f.store.join(writer, f.missionId);
		f.store.claimTask(f.missionId, task.id, writer);
	}
	// writer-1 runs; writer-2 overlaps its files, so it cannot start and must not take the second slot.
	f.sessions["codingAdmissions"].add("writer-1");
	f.sessions["metas"].set("writer-1", {
		id: "writer-1",
		projectId: f.project.id,
		cwd: "/",
		createdAt: 1,
		updatedAt: 1,
	} as never);
	assert.match(f.sessions.codingCapacityReason(f.project.id, "writer-2") ?? "", /shared-file/);
	assert.equal(f.sessions.codingCapacityReason(f.project.id), undefined, "an unknown-scope chat takes the free slot");
	assert.equal(f.sessions.codingCapacityReason(f.project.id, undefined, ["docs/x.md"]), undefined);
});
