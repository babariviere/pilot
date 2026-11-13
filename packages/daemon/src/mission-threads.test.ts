import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type TestContext, test } from "node:test";
import { type ConversationId, type EntryId, MemoryStorage } from "@earendil-works/pi-durable";
import type { PlanningInput } from "@pilot/kernel";
import type { EntryRecord } from "@pilot/protocol";
import type { MissionThreadReference, MissionThreadWrite } from "../../protocol/src/mission-thread.ts";
import { MissionThreads } from "./mission-threads.ts";
import { nativePlanningFixture } from "./native-mission-planning.fixture.ts";
import { payloadHash } from "./operation-journal.ts";
import { publishedPlanningFixture } from "./published-planning.fixture.ts";

type ThreadInput = {
	[P in MissionThreadWrite["purpose"]]: Omit<Extract<MissionThreadWrite, { purpose: P }>, "source" | "topicId">;
}[MissionThreadWrite["purpose"]];

async function fixture(t: TestContext, native = false) {
	const f = await publishedPlanningFixture(t, { native });
	const threads = new MissionThreads({ ...f, workers: f.workers });
	const topicId = randomUUID();
	const request = async (write: ThreadInput, id = topicId) => {
		const view = await threads.read(f.project.id, f.missionId);
		return f.operation(f.missionId, { ...write, topicId: id, source: view.source }, view.source);
	};
	const execute = (op: ReturnType<typeof f.operation>) =>
		f.journal.execute(op, (o, e) => threads.admit(o, e.firstEntry));
	const create = await request({ purpose: "thread-create", title: "Importer limits" });
	assert.equal((await execute(create)).state, "accepted");
	return Object.assign(f, { threads, topicId, request, execute, create });
}

test("topics keep exact identity, attribution, references and reversible dispositions without work effects", async (t) => {
	const f = await fixture(t);
	const topic = f.store.threads.get(f.missionId, f.topicId);
	assert.equal(topic.ownerSessionId, f.owner);
	assert.deepEqual(topic.createdBy, { kind: "user", operationId: f.create.operationId, host: f.create.origin });
	const decision = f.store.addDecision(f.missionId, "Keep history");
	const before = {
		mission: f.store.require(f.missionId),
		tasks: f.store.tasks(f.missionId),
		brief: f.store.brief(f.missionId),
		controls: f.store.controls.current(f.missionId),
	};
	const storage = new MemoryStorage();
	const entry: EntryRecord = {
		id: await storage.mintId<EntryId>(),
		conversationId: await storage.mintId<ConversationId>(),
		kind: "original-evidence",
		model: [{ role: "user", content: "Exact old question", timestamp: 1 }],
	};
	const history = t.mock.method(f.sessions, "history", async () => ({ entries: [entry], more: false }));
	const task = f.store.tasks(f.missionId)[0]!;
	for (const reference of [
		{ kind: "history", sessionId: f.owner, entryId: Number(entry.id) },
		{ kind: "task", id: task.id },
		{ kind: "decision", id: decision.id },
	] satisfies MissionThreadReference[]) {
		assert.equal((await f.execute(await f.request({ purpose: "thread-reference", reference }))).state, "accepted");
	}
	for (const disposition of ["later", "discarded", "open"] as const) {
		const op = await f.request({ purpose: "thread-disposition", disposition });
		assert.equal((await f.execute(op)).state, "accepted");
		assert.equal((await f.execute(op)).state, "accepted");
		const current = f.store.threads.get(f.missionId, f.topicId);
		assert.equal(current.disposition, disposition);
		assert.equal(current.references.length, 3);
	}
	const read = await f.threads.history(f.project.id, f.missionId, f.topicId, Number(entry.id) + 1, 1);
	assert.equal(read.scope, "coordinator-history");
	assert.equal(read.sessionId, f.owner);
	assert.deepEqual(read.history.entries, [entry]);
	assert.equal(history.mock.calls[0]!.arguments[0], f.owner);
	assert.deepEqual(f.store.require(f.missionId), before.mission);
	assert.deepEqual(f.store.tasks(f.missionId), before.tasks);
	assert.deepEqual(f.store.brief(f.missionId), before.brief);
	assert.deepEqual(f.store.controls.current(f.missionId), before.controls);
	const originalReceipt = await f.threads.lookup(f.create);
	assert.deepEqual(originalReceipt?.result, { topic }, "exact ACK is not today's topic revision");
	const sibling = randomUUID();
	assert.equal(
		(await f.execute(await f.request({ purpose: "thread-create", title: "Other subject" }, sibling))).state,
		"accepted",
	);
	assert.equal(f.store.threads.list(f.missionId).length, 2);
	assert.equal(f.store.threads.get(f.missionId, f.topicId).references.length, 3);
	assert.equal(f.inputs.length, 0);
	assert.equal(f.store.planningWorkers.get(f.missionId)?.start, undefined);
});

test("decision references require canonical IDs in the current mission", async (t) => {
	const f = await fixture(t);
	const decision = f.store.addDecision(f.missionId, "Keep history");
	const other = await f.createPlanning("Other mission");
	const foreign = f.store.addDecision(other, "Other scope");
	for (const id of [randomUUID(), foreign.id, `D${decision.number}`]) {
		const receipt = await f.execute(
			await f.request({ purpose: "thread-reference", reference: { kind: "decision", id } }),
		);
		assert.equal(receipt.state, "rejected");
		assert.equal(f.store.threads.get(f.missionId, f.topicId).references.length, 0);
	}
	assert.equal(
		(
			await f.execute(
				await f.request({ purpose: "thread-reference", reference: { kind: "decision", id: decision.id } }),
			)
		).state,
		"accepted",
	);
	assert.equal(f.inputs.length, 0);
});

test("discussion uses exact saved input and distinct qualified purpose, never Build or Start", async (t) => {
	const f = await fixture(t);
	const before = {
		brief: f.store.brief(f.missionId),
		tasks: f.store.tasks(f.missionId),
		interview: f.store.interviews.latest(f.missionId),
	};
	const text = "  What about encrypted archives?\n🙂  ";
	const op = await f.request({ purpose: "thread-send", text });
	assert.equal(f.inputs.length, 0, "passive preview cannot wake a coordinator");
	const receipt = await f.execute(op);
	assert.equal(receipt.state, "accepted", JSON.stringify(receipt));
	assert.equal(f.inputs.length, 1);
	const input = f.inputs[0]!;
	assert.equal(input.operation.kind, "thread-send");
	assert.equal(JSON.parse(input.operation.payload).text, text);
	assert.match(input.content, /discussion, not execution/);
	assert.match(input.content, /Importer limits/);
	assert.equal(input.hold, null);
	assert.equal((await f.execute(op)).state, "accepted");
	assert.deepEqual((await f.threads.lookup(op))?.result, receipt.result);
	assert.equal(f.inputs.length, 1);
	const topic = f.store.threads.get(f.missionId, f.topicId);
	assert.deepEqual(topic.inputs, [{ operationId: op.operationId, sessionId: f.owner }]);
	assert.deepEqual(f.store.brief(f.missionId), before.brief);
	assert.deepEqual(f.store.tasks(f.missionId), before.tasks);
	assert.deepEqual(f.store.interviews.latest(f.missionId), before.interview);
	assert.equal(f.store.planningWorkers.get(f.missionId)?.start, undefined);
});

for (const change of ["held", "Stop", "pause", "access", "owner", "revision", "busy", "disposition"] as const) {
	test(`discussion refuses ${change} without clearing a hold or dispatching`, async (t) => {
		const f = await fixture(t);
		const op = await f.request({ purpose: "thread-send", text: "Clarify limits" });
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
		if (change === "revision") f.store.update(f.missionId, { goal: "Different scope" });
		if (change === "busy") f.coordinator = { ...f.coordinator!, working: true };
		if (change === "disposition")
			await f.execute(await f.request({ purpose: "thread-disposition", disposition: "later" }));
		assert.equal((await f.execute(op)).state, "rejected");
		assert.equal(f.inputs.length, 0);
		assert.equal(f.store.threads.get(f.missionId, f.topicId).inputs.length, 0);
	});
}

test("lost send ACK and restart use only original kernel receipt, never a second admission", async (t) => {
	const f = await fixture(t, true);
	const op = await f.request({ purpose: "thread-send", text: "Exact input" });
	f.admission.mock.mockImplementation(async (input: PlanningInput, guard: () => void) => {
		guard();
		f.inputs.push(input);
		f.receipts.add(input.operation.operationId);
		throw new Error("Lost ACK");
	});
	assert.equal((await f.execute(op)).state, "pending");
	f.receipts.clear();
	assert.equal((await f.threads.lookup(op))?.state, "pending");
	assert.equal((await f.execute(op)).state, "pending");
	assert.equal(f.inputs.length, 1);
	await f.workers.close();
	await f.restart();
	assert.equal((await (await f.post(op, true)).json()).state, "pending");
	assert.equal(f.inputs.length, 1, "restart never admits an uncertain input");
	f.receipts.add(op.operationId);
	assert.equal((await (await f.post(op, true)).json()).state, "accepted");
	const threads = new MissionThreads({ ...f, workers: f.workers });
	assert.equal((await threads.lookup(op))?.state, "accepted");
	assert.deepEqual(f.store.threads.get(f.missionId, f.topicId).inputs, [
		{ operationId: op.operationId, sessionId: f.owner },
	]);
	const changed = { ...op, payload: op.payload.replace("Exact input", "Other input") };
	changed.payloadHash = payloadHash(changed.payload);
	await assert.rejects(threads.lookup(changed), /different|changed|identity|payload/i);
});

test("late source change after durable topic intent prevents dispatch, and lookup never retries", async (t) => {
	const f = await fixture(t);
	const op = await f.request({ purpose: "thread-send", text: "Clarify limits" });
	const durable = f.store.durable.bind(f.store);
	t.mock.method(f.store, "durable", async () => {
		await durable();
		f.store.update(f.missionId, { goal: "Changed during flush" });
	});
	assert.equal((await f.execute(op)).state, "pending");
	assert.equal(f.store.threads.get(f.missionId, f.topicId).inputs.length, 1, "intent is not admission proof");
	assert.equal((await f.threads.lookup(op))?.state, "pending");
	assert.equal(f.inputs.length, 0);
});

for (const change of ["source", "Stop", "permission"] as const)
	test(`final admission guard catches ${change} races inside asynchronous session admission`, async (t) => {
		const f = await fixture(t);
		const op = await f.request({ purpose: "thread-send", text: "Clarify limits" });
		f.admission.mock.mockImplementation(async (_input: PlanningInput, guard: () => void) => {
			if (change === "source") f.store.update(f.missionId, { goal: "Changed before kernel commit" });
			if (change === "Stop") t.mock.method(f.sessions, "planningIdentity", () => ({ inputGeneration: 1 }));
			if (change === "permission")
				t.mock.method(f.sessions, "planningIdentity", () => ({
					inputGeneration: 0,
					permission: { level: "none" },
				}));
			guard();
			throw new Error("Must not reach a provider");
		});
		assert.equal((await f.execute(op)).state, "pending");
		assert.equal((await f.threads.lookup(op))?.state, "pending");
		assert.equal(f.inputs.length, 0);
	});

test("history rechecks permission, project and membership after asynchronous reads", async (t) => {
	const f = await fixture(t);
	t.mock.method(f.sessions, "history", async () => {
		f.store.update(f.missionId, { coordinatorSessionId: null });
		return { entries: [], more: false };
	});
	await assert.rejects(f.threads.history(f.project.id, f.missionId, f.topicId), /coordinator|source/);
	await assert.rejects(f.threads.read(f.project.id, f.missionId), /coordinator/);
	await assert.rejects(f.threads.lookup(f.create), /coordinator/);
});

test("HTTP topics require native authority, preserve metadata across reopen, and never adopt legacy planners", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	t.mock.method(f.sessions, "planningIdentity", () => ({ inputGeneration: 0 }));
	const url = `${f.root}/api/projects/${f.project.id}/missions/${f.missionId}/threads`;
	assert.equal((await fetch(url)).status, 403);
	const headers = { "x-pilot-github-capability": f.capability };
	let view = await (await fetch(url, { headers })).json();
	assert.equal(view.discussion.available, false);
	const topicId = randomUUID();
	const create = f.operation(
		f.missionId,
		{ purpose: "thread-create", topicId, title: "Question", source: view.source } as { purpose: string },
		view.source,
	);
	assert.equal((await f.post(create, false, "invalid")).status, 403);
	assert.equal((await (await f.post(create)).json()).state, "accepted");
	view = await (await fetch(url, { headers })).json();
	const send = f.operation(
		f.missionId,
		{ purpose: "thread-send", topicId, text: "Not a Build", source: view.source } as { purpose: string },
		view.source,
	);
	assert.equal((await (await f.post(send)).json()).state, "rejected");
	assert.equal(f.store.planningWorkers.get(f.missionId), undefined);
	await f.restart();
	assert.equal((await (await f.post(create, true)).json()).state, "accepted");
	assert.equal(f.store.threads.get(f.missionId, topicId).title, "Question");
});
