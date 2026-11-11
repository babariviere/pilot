import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type TestContext, test } from "node:test";
import type { MissionPlanMap, SessionSummary } from "@pilot/protocol";
import { interviewDigest } from "./mission-interview-contract.ts";
import { MissionPlanReader } from "./mission-plans.ts";
import { MissionService } from "./mission-service.ts";
import { nativePlanningFixture } from "./native-mission-planning.fixture.ts";

async function fixture(t: TestContext) {
	const f = await nativePlanningFixture();
	let service = new MissionService(f.store, f.sessions, f.projects);
	const members = new Map<string, SessionSummary>();
	const get = f.sessions.get.bind(f.sessions);
	t.mock.method(f.sessions, "get", (id: string) => members.get(id) ?? get(id));
	const add = (role: "explorer" | "builder" | "reviewer") => {
		const id = randomUUID();
		members.set(id, { ...f.coordinator!, id, mode: role === "explorer" ? "ask" : "build" });
		f.store.join(id, f.missionId, { sessionId: f.owner }, role);
		return id;
	};
	t.after(async () => {
		await service.notices.stop();
		await f.close();
	});
	return {
		...f,
		get store() {
			return f.store;
		},
		get service() {
			return service;
		},
		members,
		add,
		readNative: f.read,
		async restart() {
			await service.notices.stop();
			await f.restart();
			service = new MissionService(f.store, f.sessions, f.projects);
		},
		async read(id: string, args = {}) {
			return (await service.call(id, "map", args)) as { map: MissionPlanMap };
		},
	};
}

test("current members read the canonical native/coordinator map, unchanged after persisted reopen", async (t) => {
	const f = await fixture(t);
	const ids = [f.owner, f.add("explorer"), f.add("builder"), f.add("reviewer")];
	const decision = f.store.addDecision(f.missionId, "Keep the saved storage", undefined, "all");
	await f.plan({
		purpose: "plan-map",
		expectedRevision: 0,
		destination: "One shared map",
		sources: [],
		questions: [
			{
				id: "choice",
				title: "Storage",
				question: "Which storage?",
				kind: "human",
				options: [{ id: "keep", meaning: "Keep it" }],
				recommendedOptionId: "keep",
				dependsOn: [],
				sources: [{ kind: "decision", id: decision.id, digest: interviewDigest(decision) }],
			},
		],
		fog: [
			{ id: "later", area: "Capacity", why: "Need samples", readyWhen: "Samples exist", dependsOn: [], sources: [] },
		],
	} as { purpose: string });
	const canonical = async () =>
		(await new MissionPlanReader({ store: f.store, authorize: () => {} }).view(f.missionId)).map;
	const native = await (await f.readNative()).json();
	assert.deepEqual(native.view.map, await canonical());
	const before = f.store.detail(f.missionId, true);
	for (const id of ids) assert.deepEqual((await f.read(id)).map, native.view.map);
	assert.deepEqual(f.store.detail(f.missionId, true), before, "reads never mutate or admit work");
	await f.restart();
	for (const id of ids) assert.deepEqual((await f.read(id)).map, native.view.map);
	// A changed citation stays changed, not silently current, for every reader.
	f.store.updateDecision(f.missionId, decision.id, "Keep storage with a limit");
	const changed = await canonical();
	assert.equal(changed.items[0]!.sources[0]!.state, "changed");
	for (const id of ids) assert.deepEqual((await f.read(id)).map, changed);
	assert.equal(f.store.tasks(f.missionId).length, 0);
});

test("member map refuses outsiders, cross-project rows, archived chats and caller-selected context", async (t) => {
	const f = await fixture(t);
	const member = f.add("explorer");
	await assert.rejects(f.read(randomUUID()), /not part of a mission/);
	for (const args of [{ missionId: f.missionId }, { projectId: f.project.id }, { revision: 1 }, { markdown: "write" }])
		await assert.rejects(f.read(member, args), /no arguments/);
	f.members.get(member)!.projectId = "other";
	await assert.rejects(f.read(member), /same-project/);
	f.members.get(member)!.projectId = f.project.id;
	f.members.get(member)!.archivedAt = 1;
	await assert.rejects(f.read(member), /same-project/);
	f.members.get(member)!.archivedAt = undefined;
	f.store.update(f.missionId, { status: "archived" });
	await assert.rejects(f.read(member), /same-project/);
	f.store.update(f.missionId, { status: "active" });
	const legacy = f.store.create({ projectId: f.project.id, title: "No saved planning context" });
	f.store.join(member, legacy.id);
	await assert.rejects(f.read(member), /planning owner required|planning coordinator required/);
});

test("member map keeps submitted interview provenance after a later round and reopen", async (t) => {
	const f = await fixture(t);
	const member = f.add("explorer");
	await f.plan({
		purpose: "plan-map",
		expectedRevision: 0,
		destination: "Saved choice",
		sources: [],
		fog: [],
		questions: [
			{
				id: "choice",
				title: "Storage",
				question: "Which storage?",
				kind: "human",
				options: [{ id: "keep", meaning: "Keep it" }],
				recommendedOptionId: "keep",
				dependsOn: [],
				sources: [],
			},
		],
	} as { purpose: string });
	await f.plan({ purpose: "plan-ask", expectedRevision: 1, topicId: "choice", questions: [f.question] } as {
		purpose: string;
	});
	let read = await (await f.readNative()).json();
	const question = read.view.interview.questions[0];
	const send = async (request: object) => {
		const result = await (
			await f.post(f.operation(f.missionId, request as { purpose: string }, read.contextDigest))
		).json();
		assert.equal(result.state, "accepted", JSON.stringify(result));
		read = await (await f.readNative()).json();
	};
	const expected = () => ({ fence: read.view.interview.fence, revision: read.view.interview.revision });
	await send({
		purpose: "interview-save",
		expected: expected(),
		answers: [
			{
				questionId: question.id,
				questionDigest: interviewDigest(question),
				selectedOption: question.options[0],
				text: "Exact saved choice",
			},
		],
	});
	await send({ purpose: "interview-submit", expected: expected() });
	const submission = read.view.interview.submission;
	await f.plan({
		purpose: "plan-resolve",
		expectedRevision: 2,
		questionId: "choice",
		resolution: { kind: "interview", id: submission.operationId, digest: submission.digest },
	} as { purpose: string });
	const first = (await f.read(member)).map;
	assert.equal(first.items[0]!.state, "settled");
	assert.equal(first.items[0]!.settledBy?.id, submission.operationId);
	assert.equal(first.items[0]!.settledBy?.state, "current");
	assert.deepEqual(first, (await (await f.readNative()).json()).view.map);
	// A new saved question set must not relabel or re-answer the submitted choice.
	await f.questions([{ ...f.question, id: "new-question", prompt: "A new clarification?" }]);
	await f.restart();
	assert.deepEqual((await f.read(member)).map, first);
	assert.equal(f.store.interviews.history(f.missionId)[0]!.interview.answers[0]!.text, "Exact saved choice");
});

for (const change of ["leave", "rejoin", "mission", "session-project", "owner-project", "project-path"] as const) {
	test(`member map rechecks ${change} during the durability barrier`, async (t) => {
		const f = await fixture(t);
		const member = f.add("builder");
		const durable = f.store.durable.bind(f.store);
		let changed = false;
		t.mock.method(f.store, "durable", async () => {
			await durable();
			if (changed) return;
			changed = true;
			if (change === "leave" || change === "rejoin" || change === "mission") f.store.leave(member);
			if (change === "rejoin") f.store.join(member, f.missionId, { sessionId: f.owner }, "builder");
			if (change === "mission") f.store.join(member, f.store.create({ projectId: f.project.id, title: "Other" }).id);
			if (change === "session-project") f.members.get(member)!.projectId = "other";
			if (change === "owner-project") f.coordinator!.projectId = "other";
			if (change === "project-path")
				t.mock.method(f.projects, "require", () => ({ ...f.project, path: "/changed" }));
		});
		await assert.rejects(f.read(member), /same-project|context changed/);
	});
}
