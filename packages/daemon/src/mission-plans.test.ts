import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type {
	DurableOperation,
	InterviewAnswer,
	PlanPrototypeResult,
	PlanQuestion,
	PlanSlice,
	PlanSpec,
	PlanWrite,
} from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { interviewDigest as digest } from "./mission-interview-contract.ts";
import { MissionInterviews } from "./mission-interviews.ts";
import {
	activeFog,
	MissionPlans,
	planFrontier,
	planningRoute,
	planQuestionDigest,
	planResearchFrontier,
	prototypeContextDigest,
} from "./mission-plans.ts";
import { MissionStore } from "./missions.ts";
import { OperationJournal, payloadHash } from "./operation-journal.ts";
import { WorkflowConfirmations } from "./workflow-confirmations.ts";

const host = { hostId: "native", daemonId: "daemon", lineageId: "lineage" };
function operation(targetId: string, request: { purpose: string }): DurableOperation {
	const payload = JSON.stringify(request);
	return {
		schemaVersion: 1,
		operationId: randomUUID(),
		producerId: randomUUID(),
		sequence: 1,
		origin: host,
		destination: host,
		kind: request.purpose,
		targetId,
		payload,
		payloadHash: payloadHash(payload),
	};
}
const question = (key = "choice", dependsOn: string[] = []): Omit<PlanQuestion, "resolution" | "claimedBy"> => ({
	id: key,
	title: key,
	question: `Which ${key}?`,
	kind: "human",
	options: [
		{ id: "yes", meaning: "Keep native storage" },
		{ id: "no", meaning: "Reconsider" },
	],
	recommendedOptionId: "yes",
	sources: [],
	dependsOn,
});
const fog = () => ({
	id: "later",
	area: "Data shape",
	why: "Needs real samples",
	readyWhen: "Sample is available",
	dependsOn: [],
	sources: [],
});
const prototype = (key = "experiment", dependsOn: string[] = []): ReturnType<typeof question> => ({
	...question(key, dependsOn),
	kind: "prototype",
	prototype: {
		context: "Would a saved draft survive moving between steps?",
		experimentType: "logic-state",
		smallestExperiment: "One pure reducer and three guided scenarios with mock answers",
		maxMinutes: 20,
		maxCostUsd: 1,
	},
});
const ask = (topicId = "choice", ids = [topicId]) => ({
	purpose: "plan-ask",
	topicId,
	questions: ids.map((id) => {
		const q = question(id);
		return {
			id,
			section: "outcome",
			prompt: q.question,
			options: q.options,
			recommendedOptionId: q.recommendedOptionId,
		};
	}),
});
const spec = (): PlanSpec => ({
	problem: "Unclear route",
	solution: "A saved native plan",
	stories: [{ id: "s1", text: "As a user, I can resume planning" }],
	implementation: ["Reuse native storage"],
	testing: ["Test at the service seam"],
	exclusions: ["Live activation"],
});
const slices = (): PlanSlice[] => [
	{
		id: "save",
		title: "Save a plan",
		outcome: "Plan survives reopen",
		acceptance: ["Reopen shows exact draft"],
		storyIds: ["s1"],
		dependsOn: [],
		owners: ["opus-ui", "sol-backend"],
	},
	{
		id: "resume",
		title: "Resume a plan",
		outcome: "Continue from saved answers",
		acceptance: ["Partial answers never start work"],
		storyIds: ["s1"],
		dependsOn: ["save"],
		owners: ["sol-backend"],
	},
];
async function fixture(t: TestContext, disk = false) {
	const home = await mkdtemp(join(tmpdir(), "mission-plan-")),
		file = disk ? join(home, "missions.sqlite") : ":memory:";
	let store = new MissionStore(file),
		journal = new OperationJournal(join(home, "journal"), host),
		allowed = true,
		human = true;
	const confirmations = () => new WorkflowConfirmations({ store, journal, authorize: () => "config-1" });
	const interviews = () =>
		new MissionInterviews({
			store,
			journal,
			confirmations: confirmations(),
			authorize: (purpose) => {
				if (["interview-save", "interview-submit"].includes(purpose) && !human)
					throw new Conflict("Native human action required");
				return "config-1";
			},
		});
	const service = () =>
		new MissionPlans({
			store,
			journal,
			authorize: () => {
				if (!allowed) throw new Conflict("Permission denied");
			},
		});
	const create = operation(randomUUID(), {
		purpose: "interview-create",
		projectId: "project",
		title: "Route",
		ownerSessionId: randomUUID(),
		questions: [
			{ id: "initial", section: "outcome", prompt: "Destination?", options: [], recommendedOptionId: null },
		],
	} as { purpose: string });
	assert.equal((await journal.execute(create, (o, e) => interviews().admit(o, e.firstEntry))).state, "accepted");
	const missionId = store.interviews.lookup(create)!.fence.missionId;
	t.after(async () => {
		await store.durable();
		store.close();
		await rm(home, { recursive: true, force: true });
	});
	const run = (op: DurableOperation) => journal.execute(op, (o, e) => service().admit(o, e.firstEntry));
	return {
		missionId,
		service,
		confirmations,
		run,
		get store() {
			return store;
		},
		get journal() {
			return journal;
		},
		set allowed(v: boolean) {
			allowed = v;
		},
		set human(v: boolean) {
			human = v;
		},
		get plan() {
			return store.plans.get(missionId)!;
		},
		prototypeResult(questionId = "experiment", link = true): PlanPrototypeResult {
			const plan = store.plans.get(missionId)!;
			const artifact = { sessionId: plan.ownerSessionId, artifactId: "prototype-preview", revision: 1 };
			if (link)
				store.linkArtifact(missionId, { ...artifact, title: "Disposable native state preview", kind: "visual" });
			return {
				planRevision: plan.revision,
				questionDigest: planQuestionDigest(plan.questions.find((q) => q.id === questionId)!),
				contextDigest: prototypeContextDigest(plan),
				artifact,
				observations: ["Moving backward kept the mock draft; invalid transition was refused"],
				verdict: "supported",
				unresolvedQuestions: ["Does this match the user's preference?"],
			};
		},
		async write(
			request: Omit<PlanWrite, "expectedRevision"> | object,
			expectedRevision = store.plans.get(missionId)?.revision ?? 0,
		) {
			const op = operation(missionId, { ...request, expectedRevision } as PlanWrite);
			return { op, receipt: await run(op) };
		},
		async map(questions = [question()], fogs = [fog()]) {
			const result = await this.write({
				purpose: "plan-map",
				destination: "A safe plan",
				sources: [],
				questions,
				fog: fogs,
			});
			assert.equal(result.receipt.state, "accepted", result.receipt.reason ?? "map rejected");
			return result;
		},
		async answer(submit = true, selection = "yes", custom = "") {
			const i = store.interviews.latest(missionId)!;
			const answers: InterviewAnswer[] = i.questions.map((q) => ({
				questionId: q.id,
				questionDigest: digest(q),
				selectedOption: q.options.find((o) => o.id === selection) ?? null,
				text: custom,
			}));
			const save = operation(missionId, {
				purpose: "interview-save",
				expected: { fence: i.fence, revision: i.revision },
				answers,
			} as { purpose: string });
			const saved = await journal.execute(save, (o, e) => interviews().admit(o, e.firstEntry));
			if (!submit || saved.state !== "accepted") return saved;
			const current = store.interviews.latest(missionId)!;
			const op = operation(missionId, {
				purpose: "interview-submit",
				expected: { fence: current.fence, revision: current.revision },
			} as { purpose: string });
			return journal.execute(op, (o, e) => interviews().admit(o, e.firstEntry));
		},
		async proposal() {
			await this.map([], []);
			assert.equal(
				(await this.write({ purpose: "plan-propose", spec: spec(), slices: slices() })).receipt.state,
				"accepted",
			);
			return this.write({ purpose: "plan-review" });
		},
		async restart() {
			await store.durable();
			store.close();
			store = new MissionStore(file);
			journal = new OperationJournal(join(home, "journal"), host);
		},
	};
}

test("route selects actual Wayfinder only for unclear multi-session work", () => {
	assert.equal(planningRoute(true, true), "wayfinder");
	for (const [unclear, multi] of [
		[false, false],
		[true, false],
		[false, true],
	])
		assert.equal(planningRoute(unclear!, multi!), "grill-with-docs");
});

test("prototype fog promotion restores typed bounded exploration, never research dispatch", async (t) => {
	const f = await fixture(t, true);
	await f.map([{ ...question("fact"), kind: "research" }]);
	const old = f.plan;
	assert.equal(
		(await f.write({ purpose: "plan-promote", fogId: "later", questions: [prototype()] })).receipt.state,
		"accepted",
	);
	assert.equal(activeFog(f.plan).length, 0);
	assert.deepEqual(f.plan.fog[0]!.promotedTo, ["experiment"]);
	assert.deepEqual(
		planResearchFrontier(f.plan).map((q) => q.id),
		["fact"],
	);
	const view = await f.service().view(f.missionId);
	assert.deepEqual(
		view.exploration.map((e) => e.status),
		["needs-research", "needs-prototype"],
	);
	assert.equal(view.exploration[1]!.evidence, "missing");
	const saved = f.plan;
	await f.restart();
	assert.deepEqual(f.plan, saved);
	assert.equal((await f.service().read(f.missionId, old.revision))!.fog[0]!.promotedTo.length, 0);
	assert.equal(f.store.tasks(f.missionId).length, 0);
	assert.equal(f.plan.spec, null); // Experiments belong in agreement, not only after spec/tickets.
});

test("prototype bounds and safe output intents refuse missing or privileged fields", async (t) => {
	const f = await fixture(t);
	const p = prototype();
	for (const q of [
		{ ...p, prototype: undefined },
		{ ...p, prototype: { ...p.prototype, maxMinutes: 0 } },
		{ ...p, prototype: { ...p.prototype, maxCostUsd: -1 } },
		{ ...p, prototype: { ...p.prototype, experimentType: "browser" } },
		{ ...p, prototype: { ...p.prototype, daemonCredentials: true } },
		{ ...p, prototypeResult: {} },
		{ ...p, kind: "research" },
	]) {
		assert.equal(
			(await f.write({ purpose: "plan-map", destination: "Safe", sources: [], questions: [q], fog: [] })).receipt
				.state,
			"rejected",
		);
	}
	assert.equal(f.store.plans.get(f.missionId), undefined);
	await f.map([p]);
	const result = f.prototypeResult();
	for (const extra of [{ execute: true }, { branch: "throwaway" }, { productionAccepted: true }])
		assert.equal(
			(await f.write({ purpose: "plan-prototype-result", questionId: p.id, result: { ...result, ...extra } }))
				.receipt.state,
			"rejected",
		);
	assert.equal(f.plan.questions[0]!.prototypeResult, undefined);
	assert.equal(f.store.tasks(f.missionId).length, 0);
});

test("prototype findings require exact linked artifact and question/context/revision", async (t) => {
	const f = await fixture(t);
	await f.map([prototype()]);
	const result = f.prototypeResult("experiment", false);
	const capture = (r: PlanPrototypeResult) =>
		f.write({ purpose: "plan-prototype-result", questionId: "experiment", result: r });
	assert.equal((await capture(result)).receipt.state, "rejected");
	f.prototypeResult();
	for (const bad of [
		{ ...result, planRevision: 0 },
		{ ...result, questionDigest: "wrong" },
		{ ...result, contextDigest: "wrong" },
		{ ...result, artifact: { ...result.artifact, revision: 2 } },
		{ ...result, artifact: { ...result.artifact, sessionId: "other" } },
		{ ...result, observations: [] },
	])
		assert.equal((await capture(bad)).receipt.state, "rejected");
	f.allowed = false;
	assert.equal((await capture(result)).receipt.state, "rejected");
	f.allowed = true;
	assert.equal((await capture(result)).receipt.state, "accepted");
	assert.deepEqual(f.plan.questions[0]!.prototypeResult, result);
	assert.equal((await f.service().view(f.missionId)).exploration[0]!.evidence, "current");
	assert.equal(f.plan.questions[0]!.resolution, null);
	assert.equal((await f.write({ purpose: "plan-review" })).receipt.state, "rejected");
});

test("successful prototype is evidence, only explicit complete human feedback resolves it", async (t) => {
	const f = await fixture(t, true);
	await f.map([prototype(), question("follow-up", ["experiment"])]);
	assert.equal((await f.write(ask("experiment"))).receipt.state, "rejected");
	const result = f.prototypeResult();
	assert.equal(
		(await f.write({ purpose: "plan-prototype-result", questionId: "experiment", result })).receipt.state,
		"accepted",
	);
	assert.equal(f.plan.questions[0]!.resolution, null);
	assert.equal(
		planFrontier(f.plan).some((q) => q.id === "follow-up"),
		false,
	);
	assert.equal(
		(
			await f.write({
				purpose: "plan-resolve",
				questionId: "experiment",
				resolution: { kind: "knowledge", id: "facts", digest: "guess" },
			})
		).receipt.state,
		"rejected",
	);
	assert.equal((await f.write(ask("experiment", ["prototype-feedback"]))).receipt.state, "accepted");
	await f.answer(false, "yes", "I like this behavior");
	assert.equal(f.plan.questions[0]!.resolution, null);
	assert.equal((await f.answer(true, "yes", "I like this behavior")).state, "accepted");
	const submission = f.store.interviews.latest(f.missionId)!.submission!;
	const resolution = { kind: "interview", id: submission.operationId, digest: submission.digest };
	assert.equal(
		(await f.write({ purpose: "plan-resolve", questionId: "experiment", resolution })).receipt.state,
		"accepted",
	);
	assert.equal(
		(await f.write({ purpose: "plan-resolve", questionId: "follow-up", resolution })).receipt.state,
		"rejected",
	);
	assert.deepEqual(
		planFrontier(f.plan).map((q) => q.id),
		["follow-up"],
	);
	await f.restart();
	assert.deepEqual(f.plan.questions[0]!.prototypeResult, result);
	assert.equal(f.store.tasks(f.missionId).length, 0);
});

test("changed prototype map retains evidence as stale and refuses old result or feedback", async (t) => {
	const f = await fixture(t);
	await f.map([prototype()]);
	const result = f.prototypeResult();
	await f.write({ purpose: "plan-prototype-result", questionId: "experiment", result });
	await f.write(ask("experiment", ["feedback"]));
	await f.answer();
	const submission = f.store.interviews.latest(f.missionId)!.submission!;
	const before = f.plan.revision;
	await f.map([{ ...prototype(), prototype: { ...prototype().prototype!, context: "New user context" } }]);
	assert.deepEqual(f.plan.questions[0]!.prototypeResult, result);
	assert.equal((await f.service().view(f.missionId)).exploration[0]!.evidence, "stale");
	assert.equal(
		(await f.write({ purpose: "plan-prototype-result", questionId: "experiment", result })).receipt.state,
		"rejected",
	);
	assert.equal(
		(
			await f.write({
				purpose: "plan-resolve",
				questionId: "experiment",
				resolution: { kind: "interview", id: submission.operationId, digest: submission.digest },
			})
		).receipt.state,
		"rejected",
	);
	assert.deepEqual((await f.service().read(f.missionId, before))!.questions[0]!.prototypeResult, result);
	const revised = f.prototypeResult();
	assert.equal(
		(await f.write({ purpose: "plan-prototype-result", questionId: "experiment", result: revised })).receipt.state,
		"accepted",
	);
	f.store.unlinkArtifact(f.missionId, revised.artifact.artifactId);
	assert.equal((await f.service().view(f.missionId)).exploration[0]!.evidence, "stale");
	assert.equal((await f.write(ask("experiment"))).receipt.state, "rejected");
});

test("prototype decision reuse requires explicit user origin, not an agent preference", async (t) => {
	const f = await fixture(t);
	await f.map([]);
	const agent = f.store.addDecision(f.missionId, "Agent prefers A", { sessionId: f.plan.ownerSessionId }, "all");
	const user = f.store.addDecision(f.missionId, "I choose B", undefined, "all");
	const sources = [agent, user].map((d) => ({ kind: "decision" as const, id: d.id, digest: digest(d) }));
	await f.map([{ ...prototype(), sources }]);
	await f.write({ purpose: "plan-prototype-result", questionId: "experiment", result: f.prototypeResult() });
	assert.equal(
		(
			await f.write({
				purpose: "plan-resolve",
				questionId: "experiment",
				resolution: { kind: "decision", id: agent.id, digest: digest(agent) },
			})
		).receipt.state,
		"rejected",
	);
	assert.equal(
		(
			await f.write({
				purpose: "plan-resolve",
				questionId: "experiment",
				resolution: { kind: "decision", id: user.id, digest: digest(user) },
			})
		).receipt.state,
		"accepted",
	);
});

test("prototype dependencies and permission changes at checkpoint fence evidence capture", async (t) => {
	const f = await fixture(t);
	await f.map([question("first"), prototype("experiment", ["first"])]);
	assert.equal(
		(await f.write({ purpose: "plan-prototype-result", questionId: "experiment", result: f.prototypeResult() }))
			.receipt.state,
		"rejected",
	);
	await f.map([prototype()]);
	const result = f.prototypeResult();
	const checkpoint = f.journal.checkpoint.bind(f.journal);
	f.journal.checkpoint = async (op, marker) => {
		await checkpoint(op, marker);
		f.allowed = false;
	};
	assert.equal(
		(await f.write({ purpose: "plan-prototype-result", questionId: "experiment", result })).receipt.state,
		"rejected",
	);
	assert.equal(f.plan.questions[0]!.prototypeResult, undefined);
});

test("prototype result lost ACK is lookup-only after restart, entered absence stays Unknown", async (t) => {
	const f = await fixture(t, true);
	await f.map([prototype()]);
	const result = f.prototypeResult();
	const op = operation(f.missionId, {
		purpose: "plan-prototype-result",
		expectedRevision: f.plan.revision,
		questionId: "experiment",
		result,
	} as PlanWrite);
	assert.equal(
		(
			await f.journal.execute(op, async (o, e) => {
				await f.service().admit(o, e.firstEntry);
				throw new Error("lost ACK");
			})
		).state,
		"pending",
	);
	const saved = f.plan;
	await f.restart();
	assert.equal((await f.run(op)).state, "accepted");
	assert.deepEqual(f.plan, saved);
	const absent = operation(f.missionId, {
		purpose: "plan-prototype-result",
		expectedRevision: saved.revision,
		questionId: "experiment",
		result: f.prototypeResult(),
	} as PlanWrite);
	await f.journal.reserve(absent);
	await f.journal.checkpoint(absent, {
		stage: "planning-entered",
		purpose: absent.kind,
		payloadHash: absent.payloadHash,
	});
	assert.equal((await f.run(absent)).state, "pending");
	assert.deepEqual(f.plan, saved);
});

test("native fog promotion is atomic, revision-fenced, historical and restored", async (t) => {
	const f = await fixture(t, true);
	await f.map();
	const old = f.plan;
	const [a, b] = await Promise.all([
		f.write({ purpose: "plan-promote", fogId: "later", questions: [question("sharp", ["choice"])] }, old.revision),
		f.write({ purpose: "plan-promote", fogId: "later", questions: [question("duplicate")] }, old.revision),
	]);
	assert.deepEqual([a.receipt.state, b.receipt.state].sort(), ["accepted", "rejected"]);
	assert.equal(activeFog(f.plan).length, 0);
	assert.equal(f.plan.questions.length, 2);
	assert.equal((await f.service().read(f.missionId, old.revision))!.fog[0]!.why, "Needs real samples");
	const saved = f.plan;
	await f.restart();
	assert.deepEqual(f.plan, saved);
	assert.equal(activeFog(f.plan).length, 0);
	assert.deepEqual(
		planFrontier(f.plan).map((q) => q.id),
		["choice"],
	);
	const fresh = await f.write({ purpose: "plan-promote", fogId: "later", questions: [question("again")] });
	assert.equal(fresh.receipt.state, "rejected");
});

test("dependency edits change the frontier and reject cycles without build tasks", async (t) => {
	const f = await fixture(t);
	await f.map([question("a"), question("b", ["a"])]);
	assert.deepEqual(
		planFrontier(f.plan).map((q) => q.id),
		["a"],
	);
	await f.map([question("a", ["b"]), question("b")]);
	assert.deepEqual(
		planFrontier(f.plan).map((q) => q.id),
		["b"],
	);
	const bad = await f.write({
		purpose: "plan-map",
		destination: "same",
		sources: [],
		questions: [question("a", ["b"]), question("b", ["a"])],
		fog: [],
	});
	assert.equal(bad.receipt.state, "rejected");
	assert.equal(f.store.tasks(f.missionId).length, 0);
});

test("settled decisions are reused without new human answers or changing existing work", async (t) => {
	const f = await fixture(t);
	const d = f.store.addDecision(f.missionId, "Use native storage", undefined, "all");
	const source = { kind: "decision" as const, id: d.id, digest: digest(d) };
	const q = { ...question(), sources: [source] };
	await f.map([q]);
	const existing = f.store.addTask(f.missionId, { title: "Existing build", status: "todo" });
	assert.equal(
		(
			await f.write({
				purpose: "plan-resolve",
				questionId: q.id,
				resolution: { kind: "decision", id: d.id, digest: digest(d) },
			})
		).receipt.state,
		"accepted",
	);
	assert.deepEqual(f.store.task(f.missionId, existing.id), existing);
	assert.equal(
		(
			await f.write({
				purpose: "plan-map",
				destination: "same",
				sources: [],
				questions: [{ ...q, question: "Changed?" }],
				fog: [],
			})
		).receipt.state,
		"rejected",
	);
	assert.equal(f.store.workflowConfirmationState(f.missionId).decisions.length, 1);
});

test("human decisions require full explicit submission, keeping suggestions and partial drafts", async (t) => {
	const f = await fixture(t, true);
	await f.map([question("a"), question("b")]);
	assert.equal((await f.write(ask("a", ["a-1", "a-2"]))).receipt.state, "accepted");
	assert.equal(f.store.interviews.latest(f.missionId)!.answers.length, 0);
	assert.equal((await f.answer(false, "yes", "  exact draft\n")).state, "accepted");
	const saved = f.store.interviews.latest(f.missionId)!;
	await f.restart();
	assert.deepEqual(f.store.interviews.latest(f.missionId), saved);
	assert.equal(saved.submission, null);
	assert.equal(
		(
			await f.write({
				purpose: "plan-resolve",
				questionId: "a",
				resolution: { kind: "interview", id: "guessed", digest: "guessed" },
			})
		).receipt.state,
		"rejected",
	);
	f.human = false;
	assert.equal((await f.answer()).state, "rejected");
	f.human = true;
	assert.equal((await f.answer(true, "yes", "extra detail")).state, "accepted");
	const s = f.store.interviews.latest(f.missionId)!.submission!;
	assert.equal(
		(
			await f.write({
				purpose: "plan-resolve",
				questionId: "a",
				resolution: { kind: "interview", id: s.operationId, digest: s.digest },
			})
		).receipt.state,
		"accepted",
	);
	assert.equal(
		(
			await f.write({
				purpose: "plan-resolve",
				questionId: "b",
				resolution: { kind: "interview", id: s.operationId, digest: s.digest },
			})
		).receipt.state,
		"rejected",
	);
});

test("research uses linked Knowledge and cannot resolve human decisions", async (t) => {
	const f = await fixture(t);
	const k = f.store.knowledge.write("project", undefined, {
		operationId: randomUUID(),
		requestHash: "hash",
		expectedRevision: 0,
		kind: "investigation",
		title: "Facts",
		synopsis: "Primary sources",
		body: "Observed evidence",
		sources: [],
		author: { type: "user" },
	});
	f.store.knowledge.setLink(f.missionId, k.entry.id, 0, { linked: true, pinnedRevision: 1 }, { type: "user" });
	const source = { kind: "knowledge" as const, id: k.entry.id, revision: 1, linkRevision: 1 };
	await f.map([
		{ ...question("fact"), kind: "research", sources: [source] },
		{ ...question("choice", ["fact"]), sources: [source] },
	]);
	const resolution = { kind: "knowledge", id: k.entry.id, digest: digest(source) };
	assert.equal((await f.write({ purpose: "plan-resolve", questionId: "fact", resolution })).receipt.state, "accepted");
	assert.deepEqual(
		planFrontier(f.plan).map((q) => q.id),
		["choice"],
	);
	assert.equal(
		(await f.write({ purpose: "plan-resolve", questionId: "choice", resolution })).receipt.state,
		"rejected",
	);
	f.store.knowledge.setLink(f.missionId, k.entry.id, 1, { linked: false }, { type: "user" });
	assert.equal((await f.write(ask())).receipt.state, "rejected");
});

test("spec and slice publication requires exact review and produces traced native tasks only", async (t) => {
	const f = await fixture(t);
	assert.equal((await f.proposal()).receipt.state, "accepted");
	assert.equal((await f.write({ purpose: "plan-publish" })).receipt.state, "rejected");
	assert.equal((await f.answer(false, "approve")).state, "accepted");
	assert.equal((await f.write({ purpose: "plan-publish" })).receipt.state, "rejected");
	assert.equal((await f.answer(true, "approve")).state, "accepted");
	const publication = await f.write({ purpose: "plan-publish" });
	assert.equal(publication.receipt.state, "accepted", publication.receipt.reason ?? "publication rejected");
	const tasks = f.store.tasks(f.missionId);
	assert.equal(tasks.length, 2);
	assert.deepEqual(tasks[1]!.dependsOn, [tasks[0]!.id]);
	for (const task of tasks) {
		assert.equal(task.status, "todo");
		assert.equal(task.sessionId, undefined);
		assert.match(task.body!, /Stories: s1/);
		assert.match(task.body!, /Spec revision: /);
	}
	assert.match(f.store.brief(f.missionId)!.markdown, /## Testing Decisions/);
	assert.ok(f.store.interviews.binding(f.missionId, f.store.brief(f.missionId)!)?.planning);
	const approval = await f.confirmations().prepare(f.missionId, "workflow-approve");
	assert.ok(approval.package.agreement?.planning);
	assert.deepEqual(await f.run(publication.op), publication.receipt);
	assert.equal(f.store.tasks(f.missionId).length, 2);
	assert.equal((await f.write({ purpose: "plan-publish" })).receipt.state, "rejected");
	f.store.writeBrief(f.missionId, "Changed spec", f.store.require(f.missionId).briefRevision);
	await assert.rejects(f.confirmations().prepare(f.missionId, "workflow-approve"), /complete interview agreement/);
});

test("changed spec invalidates saved review, rejects broken traceability and does not invent answers", async (t) => {
	const f = await fixture(t);
	await f.proposal();
	await f.answer(true, "approve");
	assert.equal(
		(await f.write({ purpose: "plan-propose", spec: { ...spec(), solution: "Changed" }, slices: slices() })).receipt
			.state,
		"accepted",
	);
	assert.equal(f.plan.review, null);
	assert.equal((await f.write({ purpose: "plan-publish" })).receipt.state, "rejected");
	assert.equal(
		(await f.write({ purpose: "plan-propose", spec: spec(), slices: [{ ...slices()[0]!, storyIds: ["invented"] }] }))
			.receipt.state,
		"rejected",
	);
	assert.equal(f.store.tasks(f.missionId).length, 0);
});

test("lost publication ACK recovers exact receipt after restart, never duplicates native tasks", async (t) => {
	const f = await fixture(t, true);
	await f.proposal();
	await f.answer(true, "approve");
	const op = operation(f.missionId, { purpose: "plan-publish", expectedRevision: f.plan.revision } as PlanWrite);
	const receipt = await f.journal.execute(op, async (o, e) => {
		await f.service().admit(o, e.firstEntry);
		throw new Error("lost ACK");
	});
	assert.equal(receipt.state, "pending");
	assert.equal(f.store.tasks(f.missionId).length, 2);
	await f.restart();
	assert.equal((await f.run(op)).state, "accepted");
	assert.equal(f.store.tasks(f.missionId).length, 2);
});

test("entered operations without effects remain Unknown, even with a fresh service", async (t) => {
	const f = await fixture(t);
	await f.map();
	const op = operation(f.missionId, {
		purpose: "plan-promote",
		expectedRevision: f.plan.revision,
		fogId: "later",
		questions: [question("now")],
	} as PlanWrite);
	await f.journal.reserve(op);
	await f.journal.checkpoint(op, { stage: "planning-entered", purpose: op.kind, payloadHash: op.payloadHash });
	assert.equal((await f.run(op)).state, "pending");
	assert.equal(activeFog(f.plan).length, 1);
});

test("permission and owner changes across checkpoint refuse without effects", async (t) => {
	const f = await fixture(t);
	await f.map();
	f.allowed = false;
	assert.equal(
		(await f.write({ purpose: "plan-promote", fogId: "later", questions: [question("no")] })).receipt.state,
		"rejected",
	);
	f.allowed = true;
	const checkpoint = f.journal.checkpoint.bind(f.journal);
	f.journal.checkpoint = async (op, marker) => {
		await checkpoint(op, marker);
		f.allowed = false;
	};
	assert.equal(
		(await f.write({ purpose: "plan-promote", fogId: "later", questions: [question("no")] })).receipt.state,
		"rejected",
	);
	assert.equal(activeFog(f.plan).length, 1);
	f.allowed = true;
	f.journal.checkpoint = checkpoint;
	const owner = f.plan.ownerSessionId;
	f.store.update(f.missionId, { coordinatorSessionId: null });
	f.store.update(f.missionId, { coordinatorSessionId: owner });
	await assert.rejects(f.service().read(f.missionId), /owner changed/);
});

test("durability failure after commit is Unknown and read rechecks concurrent edits", async (t) => {
	const f = await fixture(t);
	await f.map();
	const durable = f.store.durable.bind(f.store);
	f.store.durable = async () => {
		throw new Conflict("disk unavailable");
	};
	const result = await f.write({ purpose: "plan-promote", fogId: "later", questions: [question("saved")] });
	assert.equal(result.receipt.state, "pending");
	f.store.durable = durable;
	assert.equal((await f.run(result.op)).state, "accepted");
	assert.equal(activeFog(f.plan).length, 0);
	f.store.durable = async () => {
		await durable();
		f.store.update(f.missionId, { coordinatorSessionId: null });
	};
	await assert.rejects(f.service().read(f.missionId), /coordinator|required|changed/);
	f.store.durable = durable;
});

test("upstream publishing or execution fields cannot cross the native adapter", async (t) => {
	const f = await fixture(t);
	await f.map();
	for (const purpose of [
		"github-create-issue",
		"linear-create",
		"research-branch",
		"write-markdown",
		"agreement-start",
		"interview-save",
	]) {
		const op = operation(f.missionId, { purpose });
		assert.equal((await f.run(op)).state, "rejected");
	}
	assert.equal(
		(
			await f.write({
				purpose: "plan-map",
				destination: "Notes: this map carries execution",
				sources: [],
				questions: [],
				fog: [],
				publishTo: "github",
			})
		).receipt.state,
		"rejected",
	);
	assert.equal(f.store.tasks(f.missionId).length, 0);
});

test("claims fence concurrent frontier work without assigning build tasks", async (t) => {
	const f = await fixture(t);
	await f.map();
	const revision = f.plan.revision;
	const [a, b] = await Promise.all([
		f.write({ purpose: "plan-claim", questionId: "choice", claimedBy: f.plan.ownerSessionId }, revision),
		f.write({ purpose: "plan-claim", questionId: "choice", claimedBy: f.plan.ownerSessionId }, revision),
	]);
	assert.deepEqual([a.receipt.state, b.receipt.state].sort(), ["accepted", "rejected"]);
	assert.equal(planFrontier(f.plan).length, 0);
	assert.equal(
		(await f.write({ purpose: "plan-claim", questionId: "choice", claimedBy: null })).receipt.state,
		"accepted",
	);
	assert.equal(planFrontier(f.plan).length, 1);
	assert.equal(
		(await f.write({ purpose: "plan-claim", questionId: "choice", claimedBy: "other-mission" })).receipt.state,
		"rejected",
	);
	assert.equal(f.store.tasks(f.missionId).length, 0);
});

test("changed destination and question options cannot inherit a human round", async (t) => {
	const f = await fixture(t);
	await f.map();
	await f.write(ask());
	await f.answer(true);
	const s = f.store.interviews.latest(f.missionId)!.submission!;
	assert.equal(
		(
			await f.write({
				purpose: "plan-map",
				destination: "Changed destination",
				sources: [],
				questions: [question()],
				fog: [fog()],
			})
		).receipt.state,
		"accepted",
	);
	assert.equal(
		(
			await f.write({
				purpose: "plan-resolve",
				questionId: "choice",
				resolution: { kind: "interview", id: s.operationId, digest: s.digest },
			})
		).receipt.state,
		"rejected",
	);
	await f.write(ask());
	assert.equal(
		(
			await f.write({
				purpose: "plan-map",
				destination: "Changed destination",
				sources: [],
				questions: [{ ...question(), options: [{ id: "yes", meaning: "Different meaning" }] }],
				fog: [fog()],
			})
		).receipt.state,
		"accepted",
	);
	assert.equal(
		(
			await f.write({
				purpose: "plan-resolve",
				questionId: "choice",
				resolution: { kind: "interview", id: s.operationId, digest: s.digest },
			})
		).receipt.state,
		"rejected",
	);
});

test("native view distinguishes typed exploration from fog and exposes exact sources", async (t) => {
	const f = await fixture(t);
	await f.map([{ ...question("fact"), kind: "research" }, question("choice", ["fact"])]);
	const d = f.store.addDecision(f.missionId, "Reuse the existing store", undefined, "all");
	const view = await f.service().view(f.missionId);
	assert.equal(view.decisions[0]!.source.digest, digest(d));
	assert.deepEqual(
		view.exploration.map((q) => [q.status, q.ready]),
		[
			["needs-research", true],
			["needs-grilling", false],
		],
	);
	assert.equal(view.activeFog.length, 1);
	assert.equal(f.store.tasks(f.missionId).length, 0);
	assert.equal((await f.write(ask("fact"))).receipt.state, "rejected");
	assert.equal((await f.write(ask("choice"))).receipt.state, "rejected");
	assert.equal(f.store.interviews.latest(f.missionId)!.fence.questionSetRevision, 1);
	f.allowed = false;
	await assert.rejects(f.service().view(f.missionId), /Permission denied/);
});

test("publication retains unresolved fog without turning it into blockers or admissions", async (t) => {
	const f = await fixture(t);
	await f.map([]);
	assert.equal((await f.write({ purpose: "plan-propose", spec: spec(), slices: slices() })).receipt.state, "accepted");
	await f.write({ purpose: "plan-review" });
	await f.answer(true, "approve");
	assert.equal((await f.write({ purpose: "plan-publish" })).receipt.state, "accepted");
	assert.match(f.store.brief(f.missionId)!.markdown, /Unresolved Fog of war/);
	assert.equal(activeFog(f.plan).length, 1);
	assert.equal(f.store.tasks(f.missionId).filter((t) => t.dependsOn?.length).length, 1);
	assert.ok(f.store.tasks(f.missionId).every((t) => t.status === "todo" && !t.sessionId));
});
