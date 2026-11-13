/** Canonical SQLite/journal and trusted admission, with every worker/provider effect replaced. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type TestContext, test } from "node:test";
import { PLANNING_PROFILE, type PlanningInput } from "@pilot/kernel";
import { interviewDigest } from "./mission-interview-contract.ts";
import { nativePlanningFixture } from "./native-mission-planning.fixture.ts";
import { NativeMissionPlanning } from "./native-mission-planning.ts";
import { PlanningWorkers } from "./planning-workers.ts";

async function fixture(t: TestContext) {
	const f = await nativePlanningFixture({ native: false });
	t.after(() => f.close());
	await f.closePlanning();
	await f.plan({
		purpose: "plan-map",
		expectedRevision: 0,
		destination: "Importer",
		sources: [],
		questions: [],
		fog: [],
	} as { purpose: string });
	await f.plan({
		purpose: "plan-propose",
		expectedRevision: 1,
		spec: {
			problem: "Import",
			solution: "Read exact bytes",
			stories: [{ id: "one", text: "Read" }],
			implementation: ["Keep parser"],
			testing: ["Corrupt archive"],
			exclusions: ["No deployment"],
		},
		slices: [
			{
				id: "one",
				title: "Importer",
				outcome: "Read archive",
				acceptance: ["Exact bytes"],
				storyIds: ["one"],
				dependsOn: [],
				owners: ["sol-backend"],
			},
		],
	} as { purpose: string });
	await f.plan({ purpose: "plan-review", expectedRevision: 2 } as { purpose: string });
	const iv = f.store.interviews.latest(f.missionId)!;
	const { MissionInterviews } = await import("./mission-interviews.ts");
	const interviews = new MissionInterviews({
		store: f.store,
		journal: f.journal,
		confirmations: f.confirmations(),
		authorize: () => "fixture",
	});
	const save = f.operation(f.missionId, {
		purpose: "interview-save",
		expected: { fence: iv.fence, revision: iv.revision },
		answers: iv.questions.map((q) => ({
			questionId: q.id,
			questionDigest: interviewDigest(q),
			selectedOption: q.options.find((o) => o.id === "approve")!,
			text: "",
		})),
	} as { purpose: string });
	assert.equal((await f.journal.execute(save, (o, e) => interviews.admit(o, e.firstEntry))).state, "accepted");
	const latest = f.store.interviews.latest(f.missionId)!;
	const submit = f.operation(f.missionId, {
		purpose: "interview-submit",
		expected: { fence: latest.fence, revision: latest.revision },
	} as { purpose: string });
	assert.equal((await f.journal.execute(submit, (o, e) => interviews.admit(o, e.firstEntry))).state, "accepted");
	await f.plan({ purpose: "plan-publish", expectedRevision: 3 });
	const binding = {
		version: 1 as const,
		profile: PLANNING_PROFILE,
		home: f.home,
		host: f.journal.destination,
		projectId: f.project.id,
		missionId: f.missionId,
		ownerSessionId: f.owner,
		enrollmentId: latest.fence.enrollmentId,
		creationOperationId: "fixture-create",
	};
	f.store.planningWorkers.create(() => ({
		version: 1,
		binding,
		creation: submit,
		goal: "Import",
		configurationDigest: "fixture",
		revision: 1,
		phase: "active",
		hold: null,
		pendingHold: null,
		continuation: null,
	}));
	t.mock.method(f.sessions, "assertPlanningOpen", () => {});
	t.mock.method(f.sessions, "planningIdentity", () => ({ inputGeneration: 0, permission: { level: "investigate" } }));
	t.mock.method(f.sessions, "selectTaskModel", async () => ({ model: "fake/no-send", thinking: "off" }));
	const inputs: PlanningInput[] = [];
	const receipts = new Set<string>();
	const admission = t.mock.method(f.sessions, "admitPlanning", async (input: PlanningInput, guard: () => void) => {
		guard();
		inputs.push(input);
		receipts.add(input.operation.operationId);
		return { admissionId: input.operation.operationId };
	});
	const lookup = t.mock.method(f.sessions, "lookupPlanning", async (input: PlanningInput) =>
		receipts.has(input.operation.operationId) ? { admissionId: input.operation.operationId } : undefined,
	);
	const workers = new PlanningWorkers({
		home: f.home,
		store: f.store,
		journal: f.journal,
		projects: f.projects,
		sessions: f.sessions,
		confirmations: f.confirmations(),
	});
	t.after(() => workers.close());
	const native = new NativeMissionPlanning({
		store: f.store,
		journal: f.journal,
		projects: f.projects,
		sessions: f.sessions,
		confirmations: f.confirmations(),
		workers,
	});
	const revisit = async () => {
		const read = await native.read(f.project.id, f.missionId);
		assert.equal(read.revisit?.available, true, JSON.stringify(read.revisit));
		return f.operation(
			f.missionId,
			{ purpose: "plan-revisit", source: read.revisit!.source } as { purpose: string },
			read.revisit!.contextDigest,
		);
	};
	const execute = (op: ReturnType<typeof f.operation>) =>
		f.journal.execute(op, (o, e) => native.admit(o, e.firstEntry));
	return Object.assign(f, { native, workers, binding, inputs, admission, lookup, revisit, execute, submit, receipts });
}

test("HTTP Revisit requires native authentication and never adopts an unenrolled planner", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	const op = f.operation(
		f.missionId,
		{ purpose: "plan-revisit", source: f.store.revisions.source(f.missionId) } as { purpose: string },
		"a".repeat(64),
	);
	assert.equal((await f.post(op, false, "wrong-capability")).status, 403);
	const receipt = await (await f.post(op)).json();
	assert.equal(receipt.state, "rejected", JSON.stringify(receipt));
	assert.match(receipt.reason, /unheld planner/);
	assert.equal(f.store.planningWorkers.get(f.missionId), undefined);
});

test("explicit Revisit admits only planning; current context and inert delta never reuse creation consent", async (t) => {
	const f = await fixture(t);
	const before = { brief: f.store.brief(f.missionId), tasks: f.store.tasks(f.missionId) };
	assert.equal(f.inputs.length, 0, "passive reads never admit");
	const op = await f.revisit();
	assert.equal((await f.execute(op)).state, "accepted");
	assert.equal(f.inputs.length, 1);
	assert.equal(f.inputs[0]!.hold, null);
	assert.match(f.inputs[0]!.content, /planning-only Revisit/);
	assert.equal((await f.execute(op)).state, "accepted");
	assert.equal(f.inputs.length, 1, "same operation never reenters");
	const context = (await f.workers.call(f.binding, { action: "read" })).value as Record<string, unknown>;
	assert.equal(context.plan, undefined, "no historical full plan in default context");
	assert.ok(context.agreement);
	assert.ok(context.settledAnswers);
	await assert.rejects(
		f.workers.call(f.binding, {
			action: "write",
			toolCallId: "bad-publish",
			request: { purpose: "plan-publish", expectedRevision: 4 },
		}),
		/only saves requested Revisit/,
	);
	const result = await f.workers.call(f.binding, {
		action: "revision",
		toolCallId: "delta",
		request: {
			purpose: "revision-propose",
			source: f.store.revisions.source(f.missionId),
			summary: "New importer goal",
			delta: {
				goal: "Read encrypted archives",
				corrections: [{ kind: "permission", text: "Proposed, not granted" }],
			},
		},
	});
	assert.equal((result.value as { state: string }).state, "accepted");
	assert.deepEqual(f.store.brief(f.missionId), before.brief);
	assert.deepEqual(f.store.tasks(f.missionId), before.tasks);
	assert.equal(f.store.revisions.pending(f.missionId)?.current, true);
	assert.equal((await f.execute(f.submit)).state, "accepted", "historical creation submission is only its receipt");
	assert.equal(f.inputs.length, 1);
});

for (const change of ["held", "Stop", "pause", "owner", "revision", "access", "busy"] as const) {
	test(`Revisit refuses changed ${change} without dispatch`, async (t) => {
		const f = await fixture(t);
		const op = await f.revisit();
		if (change === "held") {
			const state = f.store.planningWorkers.get(f.missionId)!;
			f.store.planningWorkers.change(f.missionId, state.revision, (s) => {
				s.phase = "held";
			});
		}
		if (change === "Stop") t.mock.method(f.sessions, "planningIdentity", () => ({ inputGeneration: 1 }));
		if (change === "pause" || change === "access")
			t.mock.method(f.sessions, "assertPlanningOpen", () => {
				throw new Error(change);
			});
		if (change === "owner") f.store.update(f.missionId, { coordinatorSessionId: null });
		if (change === "revision") f.store.update(f.missionId, { goal: "Changed goal" });
		if (change === "busy") f.coordinator = { ...f.coordinator!, working: true };
		const result = await f.execute(op);
		assert.equal(result.state, "rejected", JSON.stringify(result));
		assert.equal(f.inputs.length, 0);
	});
}

test("lost Revisit ACK uses original admission lookup; missing evidence never resends", async (t) => {
	const f = await fixture(t);
	const op = await f.revisit();
	f.admission.mock.mockImplementation(async (input: PlanningInput, guard: () => void) => {
		guard();
		f.inputs.push(input);
		f.receipts.add(input.operation.operationId);
		throw new Error("Lost ACK");
	});
	assert.equal((await f.execute(op)).state, "pending");
	assert.equal(f.store.planningWorkers.get(f.missionId)?.phase, "revisiting");
	f.receipts.clear();
	assert.equal((await f.native.lookup(op))?.state, "pending");
	assert.equal(f.inputs.length, 1);
	f.receipts.add(op.operationId);
	assert.equal((await f.native.lookup(op))?.state, "accepted");
	assert.equal(f.inputs.length, 1);
	assert.ok(f.lookup.mock.callCount() >= 2);
});

test("Revisit questions preserve agreement and only their exact final submit continues planning", async (t) => {
	const f = await fixture(t);
	const before = f.store.brief(f.missionId);
	assert.equal((await f.execute(await f.revisit())).state, "accepted");
	const original = f.store.interviews.latest(f.missionId)!;
	const q = { ...f.question, id: "new-gap", prompt: "What new archive constraint matters?" };
	const round = await f.workers.call(f.binding, {
		action: "questions",
		toolCallId: "revisit-round",
		request: {
			purpose: "interview-questions",
			kind: "revisit",
			expected: { fence: original.fence, revision: original.revision },
			questions: [q],
		},
	});
	assert.ok(round.hold);
	assert.equal(f.workers.revisitView(f.missionId).available, false, "held planner stays held");
	let read = await f.native.read(f.project.id, f.missionId);
	let iv = read.view!.interview;
	assert.equal(iv.kind, "revisit");
	assert.equal(
		(
			await f.execute(
				f.operation(
					f.missionId,
					{ purpose: "interview-submit", expected: { fence: iv.fence, revision: iv.revision } } as {
						purpose: string;
					},
					read.contextDigest!,
				),
			)
		).state,
		"rejected",
		"no partial submission",
	);
	assert.equal(f.inputs.length, 1);
	const save = f.operation(
		f.missionId,
		{
			purpose: "interview-save",
			expected: { fence: iv.fence, revision: iv.revision },
			answers: [
				{
					questionId: q.id,
					questionDigest: interviewDigest(q),
					selectedOption: q.options[0],
					text: "Exact extra detail",
				},
			],
		} as { purpose: string },
		read.contextDigest!,
	);
	assert.equal((await f.execute(save)).state, "accepted");
	read = await f.native.read(f.project.id, f.missionId);
	iv = read.view!.interview;
	assert.equal(f.inputs.length, 1, "autosave never continues");
	let continued!: () => void;
	const arrived = new Promise<void>((resolve) => {
		continued = resolve;
	});
	t.mock.method(f.sessions, "planningIdle", async (_id: string, guard: () => void) => {
		guard();
	});
	f.admission.mock.mockImplementation(async (input: PlanningInput, guard: () => void) => {
		guard();
		f.inputs.push(input);
		f.receipts.add(input.operation.operationId);
		continued();
		return { admissionId: input.operation.operationId };
	});
	const submit = f.operation(
		f.missionId,
		{ purpose: "interview-submit", expected: { fence: iv.fence, revision: iv.revision } } as { purpose: string },
		read.contextDigest!,
	);
	assert.equal((await f.execute(submit)).state, "accepted");
	await arrived;
	assert.equal(f.inputs.length, 2);
	assert.equal(f.inputs[1]!.operation.kind, "interview-continue");
	assert.deepEqual(f.store.brief(f.missionId), before);
	assert.equal(f.store.interviews.history(f.missionId).length, 2);
	assert.equal((await f.execute(submit)).state, "accepted");
	assert.equal(f.inputs.length, 2);
});

test("post-Pause requires a fresh user preview and exact confirmation; lost ACK never reapplies", async (t) => {
	const f = await fixture(t);
	const original = await f.store.revisions.propose(
		f.missionId,
		{
			operationId: randomUUID(),
			source: f.store.revisions.source(f.missionId),
			summary: "Review new scope",
			delta: { markdown: "New reviewed agreement" },
		},
		{ sessionId: f.owner },
	);
	const control = f.store.controls.current(f.missionId);
	f.store.controls.write(
		{
			version: 1,
			missionId: f.missionId,
			state: "acknowledged",
			ownerFence: "isolated-fixture",
			command: {
				version: 1,
				operationId: randomUUID(),
				home: { daemonId: f.hello.daemonId, lineageId: f.hello.lineageId! },
				projectId: f.project.id,
				coordinatorSessionId: f.owner,
				expectedRevision: control.revision,
				action: "pause",
			},
			control: { ...control, revision: control.revision + 1, held: true, state: "paused" },
			members: [],
		},
		control.revision,
	);
	await f.store.durable();
	const source = f.store.revisions.source(f.missionId);
	const stale = f.operation(
		f.missionId,
		{ purpose: "revision-confirm", proposalId: original.id, digest: original.digest, source } as { purpose: string },
		source,
	);
	assert.equal((await f.execute(stale)).state, "rejected");
	const preview = f.operation(
		f.missionId,
		{ purpose: "revision-preview", proposalId: original.id, digest: original.digest, source } as { purpose: string },
		source,
	);
	const receipt = await f.execute(preview);
	assert.equal(receipt.state, "accepted");
	const fresh = f.store.revisions.lookup(f.missionId, preview.operationId)!;
	assert.notEqual(fresh.id, original.id);
	assert.notEqual(fresh.digest, original.digest);
	assert.deepEqual(fresh.repreviewOf, { id: original.id, digest: original.digest });
	assert.equal(f.inputs.length, 0, "preview never wakes held planner");
	assert.notEqual(f.store.brief(f.missionId)?.markdown, "New reviewed agreement");
	const confirm = f.operation(
		f.missionId,
		{ purpose: "revision-confirm", proposalId: fresh.id, digest: fresh.digest, source } as { purpose: string },
		source,
	);
	const apply = f.store.revisions.confirm.bind(f.store.revisions);
	const calls = t.mock.method(f.store.revisions, "confirm", async (...args: Parameters<typeof apply>) => {
		await apply(...args);
		throw new Error("Lost confirmation ACK");
	});
	assert.equal((await f.execute(confirm)).state, "pending");
	assert.equal((await f.native.lookup(confirm))?.state, "accepted");
	assert.equal(calls.mock.callCount(), 1);
	assert.equal(f.store.brief(f.missionId)?.markdown, "New reviewed agreement");
	assert.equal(f.store.controls.current(f.missionId).held, true);
	assert.equal(f.inputs.length, 0);
});
