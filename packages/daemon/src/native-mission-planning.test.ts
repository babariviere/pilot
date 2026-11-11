import assert from "node:assert/strict";
import { test } from "node:test";
import type { InterviewWrite, MissionInterview } from "@pilot/protocol";
import { interviewDigest } from "./mission-interview-contract.ts";
import { nativePlanningFixture } from "./native-mission-planning.fixture.ts";
import { OperationJournal } from "./operation-journal.ts";

const expected = (i: MissionInterview) => ({ fence: i.fence, revision: i.revision });

test("native capability, exact project/home/owner and purpose are required for reads and receipts", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	assert.equal((await f.read("")).status, 403);
	assert.equal((await f.read(f.capability, "other-project")).status, 404);
	const read = await (await f.read()).json();
	assert.equal(read.capabilities.continuation, "unavailable");
	assert.equal(read.capabilities.enrollment, "unavailable");
	assert.equal(read.capabilities.admission, "unavailable");
	assert.equal(read.capabilities.coordinatorProfile, "not-configured");
	assert.equal(read.view.plan, null, "configured saved interview with no map differs from unavailable");
	const op = f.operation(
		f.missionId,
		{ purpose: "interview-submit", expected: expected(read.view.interview) } as InterviewWrite,
		read.contextDigest,
	);
	assert.equal((await f.post(op, false, "")).status, 403);
	assert.equal((await f.post(op, true, "")).status, 403);
	assert.deepEqual(await (await f.post(op, true)).json(), { state: "unknown" });
	assert.equal((await f.post({ ...op, origin: { ...op.origin, daemonId: "other" } })).status, 400);
	for (const purpose of [
		"interview-create",
		"interview-continue",
		"agreement-start",
		"plan-map",
		"plan-publish",
		"plan-prototype-result",
		"small-ask-start",
	]) {
		const denied = f.operation(f.missionId, { purpose }, read.contextDigest);
		assert.equal((await f.post(denied)).status, 400, purpose);
	}
	const unavailable = f.operation(f.missionId, { purpose: "prototype-execute" }, read.contextDigest);
	assert.equal((await (await f.post(unavailable)).json()).state, "rejected");
	assert.equal(f.store.tasks(f.missionId).length, 0);
	f.coordinator = { ...f.coordinator!, mode: "ask" };
	assert.equal((await f.read()).status, 409);
	assert.equal((await f.post(op, true)).status, 409);
});

test("native and agent reads share prototype records without enabling preview execution", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	await f.plan({
		purpose: "plan-map",
		expectedRevision: 0,
		destination: "Resolve one design uncertainty",
		sources: [],
		fog: [],
		questions: [
			{
				id: "preview",
				title: "Draft navigation",
				question: "Does this navigation keep context?",
				kind: "prototype",
				options: [],
				recommendedOptionId: null,
				dependsOn: [],
				sources: [],
				prototype: {
					context: "Moving between interview steps",
					experimentType: "ui",
					smallestExperiment: "Two mock native variants",
					maxMinutes: 15,
					maxCostUsd: 1,
				},
			},
		],
	} as { purpose: string });
	let read = await (await f.read()).json();
	assert.equal(read.capabilities.prototype, "unavailable");
	assert.deepEqual(read.view.plan, f.store.plans.get(f.missionId));
	assert.equal(read.view.exploration[0].status, "needs-prototype");
	assert.equal(read.view.exploration[0].evidence, "missing");
	f.store.linkArtifact(f.missionId, {
		sessionId: f.owner,
		artifactId: "preview",
		revision: 3,
		title: "Historical native preview",
		kind: "visual",
	});
	const result = {
		planRevision: read.view.plan.revision,
		questionDigest: read.view.exploration[0].questionDigest,
		contextDigest: read.view.exploration[0].contextDigest,
		artifact: { sessionId: f.owner, artifactId: "preview", revision: 3 },
		observations: ["Both mock variants keep context"],
		verdict: "inconclusive",
		unresolvedQuestions: ["Which does the user prefer?"],
	};
	await f.plan({ purpose: "plan-prototype-result", expectedRevision: 1, questionId: "preview", result } as {
		purpose: string;
	});
	await f.restart();
	read = await (await f.read()).json();
	assert.deepEqual(read.view.plan.questions[0].prototypeResult, result);
	assert.equal(read.view.exploration[0].evidence, "current");
	assert.equal(read.view.plan.questions[0].resolution, null);
	assert.equal(read.capabilities.prototype, "unavailable");
	assert.equal(f.store.tasks(f.missionId).length, 0);
});

test("exact choices/text survive daemon restart; complete submission is separate and never dispatches", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	let read = await (await f.read()).json();
	const question = read.view.interview.questions[0];
	const save = f.operation(
		f.missionId,
		{
			purpose: "interview-save",
			expected: expected(read.view.interview),
			answers: [
				{
					questionId: question.id,
					questionDigest: interviewDigest(question),
					selectedOption: question.options[0],
					text: "  exact\n💬 detail  ",
				},
			],
		} as InterviewWrite,
		read.contextDigest,
	);
	const receipt = await (await f.post(save)).json();
	assert.equal(receipt.state, "accepted", JSON.stringify(receipt));
	await f.restart();
	assert.deepEqual(await (await f.post(save, true)).json(), receipt);
	assert.deepEqual(await (await f.post(save)).json(), receipt);
	read = await (await f.read()).json();
	assert.equal(read.view.interview.answers[0].text, "  exact\n💬 detail  ");
	assert.equal(read.view.interview.submission, null);
	const submit = f.operation(
		f.missionId,
		{ purpose: "interview-submit", expected: expected(read.view.interview) } as InterviewWrite,
		read.contextDigest,
	);
	const submitted = await (await f.post(submit)).json();
	assert.equal(submitted.state, "accepted", JSON.stringify(submitted));
	assert.equal((await (await f.read()).json()).view.interview.submission.operationId, submit.operationId);
	assert.equal(f.store.tasks(f.missionId).length, 0);
	assert.equal(f.store.workflowConfirmations.latest(f.missionId, false), undefined);
	assert.deepEqual(await (await f.post(submit)).json(), submitted);
});

test("topic/context/proposal changes refuse stale answers; full proposal is available before explicit review", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	await f.plan({
		purpose: "plan-map",
		expectedRevision: 0,
		destination: "Importer",
		sources: [],
		questions: [],
		fog: [
			{
				id: "later",
				area: "Large archives",
				why: "May exceed memory",
				readyWhen: "After initial fixture",
				dependsOn: [],
				sources: [],
			},
		],
	} as { purpose: string });
	await f.plan({
		purpose: "plan-propose",
		expectedRevision: 1,
		spec: {
			problem: "Exact problem",
			solution: "Exact solution",
			stories: [{ id: "story", text: "Read imports" }],
			implementation: ["Existing parser"],
			testing: ["Corrupt archive fixture"],
			exclusions: ["No format changes"],
		},
		slices: [
			{
				id: "slice",
				title: "Importer",
				outcome: "Read an archive",
				acceptance: ["Correct bytes"],
				storyIds: ["story"],
				dependsOn: [],
				owners: ["sol-backend"],
			},
		],
	} as { purpose: string });
	await f.plan({ purpose: "plan-review", expectedRevision: 2 } as { purpose: string });
	const read = await (await f.read()).json();
	assert.equal(read.view.plan.spec.testing[0], "Corrupt archive fixture");
	assert.equal(read.view.plan.slices[0].acceptance[0], "Correct bytes");
	assert.equal(read.view.activeFog[0].why, "May exceed memory");
	assert.equal(read.view.plan.review.questionSetRevision, read.view.interview.fence.questionSetRevision);
	const request: InterviewWrite = { purpose: "interview-save", expected: expected(read.view.interview), answers: [] };
	const stale = f.operation(f.missionId, request, read.contextDigest);
	await f.plan({
		purpose: "plan-propose",
		expectedRevision: 3,
		spec: { ...read.view.plan.spec, solution: "Changed proposal" },
		slices: read.view.plan.slices,
	} as { purpose: string });
	const r = await (await f.post(stale)).json();
	assert.equal(r.state, "rejected", JSON.stringify(r));
	assert.match(r.reason, /context changed/);
	assert.equal(f.store.interviews.latest(f.missionId)!.answers.length, 0);
	await f.plan({ purpose: "plan-review", expectedRevision: 4 } as { purpose: string });
	let current = await (await f.read()).json();
	const question = current.view.interview.questions[0];
	const save = f.operation(
		f.missionId,
		{
			purpose: "interview-save",
			expected: expected(current.view.interview),
			answers: [
				{
					questionId: question.id,
					questionDigest: current.questionDigests[question.id],
					selectedOption: question.options.find((o: { id: string }) => o.id === "approve"),
					text: "Reviewed the full proposal",
				},
			],
		} as InterviewWrite,
		current.contextDigest,
	);
	assert.equal((await (await f.post(save)).json()).state, "accepted");
	current = await (await f.read()).json();
	assert.equal(current.view.interview.submission, null, "saved review is not complete submission");
	const submit = f.operation(
		f.missionId,
		{ purpose: "interview-submit", expected: expected(current.view.interview) } as InterviewWrite,
		current.contextDigest,
	);
	assert.equal((await (await f.post(submit)).json()).state, "accepted");
	assert.equal(f.store.tasks(f.missionId).length, 0, "human proposal submission neither publishes nor admits workers");
});

test("authorization is checked after asynchronous durability; late changes cannot return accepted", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	const old = f.store.durable.bind(f.store);
	let change = false;
	t.mock.method(f.store, "durable", async () => {
		await old();
		if (change) f.coordinator = undefined;
	});
	change = true;
	assert.equal((await f.read()).status, 409);
});

test("topic rounds bind native human submissions and cannot answer a different topic", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	const topic = (id: string) => ({
		id,
		title: id,
		question: `Choose ${id}`,
		kind: "human",
		options: [],
		recommendedOptionId: null,
		dependsOn: [],
		sources: [],
	});
	await f.plan({
		purpose: "plan-map",
		expectedRevision: 0,
		destination: "Two choices",
		sources: [],
		questions: [topic("first"), topic("second")],
		fog: [],
	} as { purpose: string });
	await f.plan({ purpose: "plan-ask", expectedRevision: 1, topicId: "first", questions: [f.question] } as {
		purpose: string;
	});
	const first = await (await f.read()).json();
	await f.plan({ purpose: "plan-ask", expectedRevision: 2, topicId: "second", questions: [f.question] } as {
		purpose: string;
	});
	const op = f.operation(
		f.missionId,
		{ purpose: "interview-submit", expected: expected(first.view.interview) } as InterviewWrite,
		first.contextDigest,
	);
	const r = await (await f.post(op)).json();
	assert.equal(r.state, "rejected");
	assert.equal((await (await f.read()).json()).view.plan.round.topicId, "second");
	assert.equal(f.store.interviews.latest(f.missionId)!.submission, null);
});

test("changed owner after a saved effect stays uncertain until exact restart recovery", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	const read = await (await f.read()).json();
	const coordinator = f.coordinator;
	const q = read.view.interview.questions[0];
	const op = f.operation(
		f.missionId,
		{
			purpose: "interview-save",
			expected: expected(read.view.interview),
			answers: [
				{ questionId: q.id, questionDigest: interviewDigest(q), selectedOption: q.options[0], text: "committed" },
			],
		} as InterviewWrite,
		read.contextDigest,
	);
	const durable = f.store.durable.bind(f.store);
	t.mock.method(f.store, "durable", async () => {
		await durable();
		f.coordinator = undefined;
	});
	assert.notEqual((await f.post(op)).status, 200);
	assert.equal(f.store.interviews.lookup(op)!.answers[0]!.text, "committed");
	t.mock.restoreAll();
	f.coordinator = coordinator;
	await f.restart();
	// Recovery may settle the exact stored effect, but does not execute a fresh human write.
	const receipt = await (await f.post(op)).json();
	assert.equal(receipt.state, "accepted", JSON.stringify(receipt));
	assert.equal(f.store.interviews.latest(f.missionId)!.revision, 2);
});

test("legacy missions are explicitly not enrolled, not empty or automatically adopted", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	const old = f.store.create({ projectId: f.project.id, title: "Historical mission" });
	const r = await fetch(`${f.root}/api/projects/${f.project.id}/missions/${old.id}/planning`, {
		headers: { "x-pilot-github-capability": f.capability },
	});
	assert.equal(r.status, 200);
	const read = await r.json();
	assert.equal(read.status, "not-enrolled");
	assert.equal(read.view, null);
	assert.equal(read.capabilities.answers, "unavailable");
	assert.equal(read.capabilities.enrollment, "unavailable");
	assert.equal(read.capabilities.continuation, "unavailable");
	assert.equal(read.capabilities.admission, "unavailable");
	assert.equal(f.store.interviews.latest(old.id), undefined);
	assert.equal(f.store.require(old.id).planningVersion, undefined);
});

test("Stop/configuration change during journal I/O refuses before saving human answers", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	const read = await (await f.read()).json();
	const op = f.operation(
		f.missionId,
		{ purpose: "interview-save", expected: expected(read.view.interview), answers: [] } as InterviewWrite,
		read.contextDigest,
	);
	const checkpoint = OperationJournal.prototype.checkpoint;
	t.mock.method(
		OperationJournal.prototype,
		"checkpoint",
		async function (this: OperationJournal, ...args: Parameters<typeof checkpoint>) {
			await checkpoint.apply(this, args);
			f.coordinator = { ...f.coordinator!, inputGeneration: 1 };
		},
	);
	const receipt = await (await f.post(op)).json();
	assert.equal(receipt.state, "rejected", JSON.stringify(receipt));
	assert.match(receipt.reason, /context changed/);
	assert.equal(f.store.interviews.latest(f.missionId)!.revision, read.view.interview.revision);
});
