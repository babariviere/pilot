/** Ready prototype questions start read-only prototype chats; their artifact reaches the planner once. Chats are faked. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type TestContext, test } from "node:test";
import type { ArtifactSummary, SessionSummary } from "@pilot/protocol";
import { MissionPlans } from "../mission-plans.ts";
import { payloadHash } from "../../../transport/operations/operation-journal.ts";
import { publishedPlanningFixture as fixture } from "../publication/published-planning.fixture.ts";

const prototype = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	title: `Prototype ${id}`,
	question: `Which layout makes ${id} clear?`,
	kind: "prototype",
	options: [],
	recommendedOptionId: null,
	dependsOn: [],
	sources: [],
	prototype: {
		context: "Mock Today screen",
		experimentType: "ui",
		smallestExperiment: "Three variants of the error card",
		maxCostUsd: 3,
		model: "faux/opus",
		...extra,
	},
});
const research = (id: string) => ({
	id,
	title: `Research ${id}`,
	question: `What is true about ${id}?`,
	kind: "research",
	options: [],
	recommendedOptionId: null,
	dependsOn: [],
	sources: [],
});

async function prototypes(t: TestContext, questions: unknown[]) {
	const f = await fixture(t, { published: false });
	await f.plan({
		purpose: "plan-map",
		expectedRevision: 1,
		destination: "Today",
		sources: [],
		questions,
		fog: [],
	} as { purpose: string });
	const chats = new Map<string, Partial<SessionSummary>>();
	const spawned: { id: string; title: string; mode?: string; role?: string; message: string; model: string }[] = [];
	const models: (string | undefined)[] = [];
	t.mock.method(f.sessions, "selectTaskModel", async (_cwd: string, model?: string) => {
		models.push(model);
		return { model: model ?? "faux/default", thinking: "medium" };
	});
	t.mock.method(
		f.sessions,
		"spawn",
		async (
			request: { title: string; mode?: string; message: string; model: string },
			_c: boolean,
			_t: unknown,
			admission: { role: string },
		) => {
			const id = `chat-${spawned.length + 1}`;
			spawned.push({ id, ...request, role: admission.role });
			f.store.join(id, f.missionId, { sessionId: f.owner }, "explorer");
			chats.set(id, { id, state: "working", working: true });
			return { id } as SessionSummary;
		},
	);
	const get = f.sessions.get.bind(f.sessions);
	t.mock.method(f.sessions, "get", (id: string) =>
		chats.has(id) ? ({ ...chats.get(id) } as SessionSummary) : get(id),
	);
	t.mock.method(f.sessions, "lastAssistantReply", async (id: string) => `## Variants\nReport of ${id}: A, B and C.`);
	const published = new Map<string, ArtifactSummary[]>();
	t.mock.method(f.sessions, "artifacts", async (id: string) => published.get(id) ?? []);
	const stopped: string[] = [];
	t.mock.method(f.sessions, "stop", async (id: string) => {
		stopped.push(id);
		chats.set(id, { id, state: "idle", working: false, outcome: "stopped" });
		return {} as never;
	});
	const settle = async () => {
		f.workers.scheduleReconcile(f.missionId);
		await f.workers.settleReconciling();
	};
	const finish = async (id: string) => {
		chats.set(id, { id, state: "idle", working: false, outcome: "done" });
		await settle();
	};
	const publish = (sessionId: string, artifactId: string, revision: number) =>
		published.set(sessionId, [
			{ id: "picture", sessionId, title: "A picture", kind: "image", revision: 1, createdAt: 1, updatedAt: 9 },
			{ id: artifactId, sessionId, title: "Today variants", kind: "nsh", revision, createdAt: 1, updatedAt: 5 },
		]);
	const claimed = () => Object.fromEntries(f.store.plans.get(f.missionId)!.questions.map((q) => [q.id, q.claimedBy]));
	return Object.assign(f, { spawned, models, settle, finish, publish, claimed, stopped });
}

test("a ready prototype starts one read-only chat with its planner's model; its artifact is linked and passed once", async (t) => {
	const f = await prototypes(t, [
		prototype("p1", { model: "faux/opus", thinking: "high" }),
		prototype("p2", { model: "faux/sol" }),
		research("r"),
	]);
	f.workers.startReconciling();
	await f.workers.settleReconciling();
	assert.deepEqual(
		f.spawned.map((s) => [s.title, s.mode, s.role, s.model]),
		[
			["Prototype: Prototype p1 (about $3)", "ask", "explorer", "faux/opus"],
			["Research: Research r", "ask", "explorer", "faux/default"],
		],
		"one prototype chat at a time, beside research",
	);
	assert.deepEqual(f.models, ["faux/opus", undefined]);
	assert.match(f.spawned[0]!.message, /Publish exactly one NSH artifact/);
	assert.match(f.spawned[0]!.message, /Budget: about \$3\./);
	assert.doesNotMatch(f.spawned[0]!.message, /minute/);
	assert.deepEqual(f.claimed(), { p1: "chat-1", p2: null, r: "chat-2" });

	f.publish("chat-1", "variants", 3);
	await f.finish("chat-1");
	assert.deepEqual(
		f.store.artifactReferences(f.missionId, "variants").map((l) => [l.sessionId, l.revision]),
		[["chat-1", 3]],
		"Pilot links the newest NSH artifact at its revision; images are left alone",
	);
	assert.equal(f.store.artifactReferences(f.missionId, "picture").length, 0);
	assert.equal(f.spawned.length, 3, "the next prototype starts when the slot frees");
	assert.equal(f.spawned[2]!.title, "Prototype: Prototype p2 (about $3)");
	assert.equal(f.inputs.length, 0, "results wait while other chats run");

	await f.finish("chat-2");
	await f.finish("chat-3");
	assert.equal(f.inputs.length, 1);
	const content = f.inputs[0]!.content;
	assert.equal(f.inputs[0]!.operation.kind, "plan-research-result");
	assert.match(content, /# Prototype for map question "p1"/);
	assert.match(content, /"artifactId":"variants","revision":3,"sessionId":"chat-1"/);
	assert.match(content, /Report of chat-1: A, B and C/);
	assert.match(
		content,
		/# Prototype for map question "p2" \(Prototype p2\), prototype chat chat-3\n\nThe chat published no NSH artifact/,
	);
	assert.match(content, /# Map question "r"/);
	assert.match(content, /save plan-prototype-result with exactly that artifact pin/);
	await f.settle();
	assert.equal(f.inputs.length, 1, "results are sent once");
	assert.equal(f.store.tasks(f.missionId).length, 0, "prototypes never create build tasks");
});

test("a prototype chat has no time limit, even with a time saved by an older plan", async (t) => {
	const f = await prototypes(t, [prototype("p1", { maxMinutes: 5 })]);
	f.workers.startReconciling();
	await f.workers.settleReconciling();
	assert.equal(f.spawned.length, 1);
	const state = f.store.planningWorkers.get(f.missionId)!;
	f.store.planningWorkers.change(f.missionId, state.revision, (s) => {
		s.research!.p1!.startedAt = Date.now() - 600 * 60_000;
	});
	f.publish("chat-1", "variants", 1);
	await f.settle();
	assert.deepEqual(f.stopped, [], "a long-running chat runs on");
	assert.equal(f.inputs.length, 0);
	await f.finish("chat-1");
	assert.equal(f.inputs.length, 1);
	assert.doesNotMatch(f.inputs[0]!.content, /limit/);
	assert.match(f.inputs[0]!.content, /"artifactId":"variants"/);
});

test("a prototype is made again only when the planner changes its question, never a third time", async (t) => {
	const f = await prototypes(t, [prototype("p1")]);
	f.workers.startReconciling();
	await f.workers.settleReconciling();
	f.publish("chat-1", "variants", 2);
	await f.finish("chat-1");
	assert.equal(f.inputs.length, 1);
	// Saving the result releases the question; an unchanged question gets no second prototype.
	await f.plan({
		purpose: "plan-claim",
		expectedRevision: f.store.plans.get(f.missionId)!.revision,
		questionId: "p1",
		claimedBy: null,
	} as { purpose: string });
	await f.settle();
	assert.equal(f.spawned.length, 1, "a released, unchanged question is not made again");
	const change = (what: string) =>
		f.plan({
			purpose: "plan-map",
			expectedRevision: f.store.plans.get(f.missionId)!.revision,
			destination: "Today",
			sources: [],
			questions: [prototype("p1", { smallestExperiment: what })],
			fog: [],
		} as { purpose: string });
	await change("Variant B with a larger error banner");
	await f.settle();
	assert.equal(f.spawned.length, 2);
	assert.match(
		f.spawned[1]!.message,
		/An earlier prototype for this question exists: artifact variants, revision 2, of chat chat-1/,
	);
	assert.match(f.spawned[1]!.message, /Variant B with a larger error banner/);
	await f.finish("chat-2");
	await f.plan({
		purpose: "plan-claim",
		expectedRevision: f.store.plans.get(f.missionId)!.revision,
		questionId: "p1",
		claimedBy: null,
	} as { purpose: string });
	await change("Again");
	await f.settle();
	assert.equal(f.spawned.length, 2, "at most two prototype chats per question");
	assert.match(f.workers.unstickView(f.missionId).line, /Pilot made 2 prototypes for "Prototype p1"/);
});

test("a prototype waits for its planner to choose the model, and Unstick and Continue say so", async (t) => {
	const legacy = prototype("p1");
	delete (legacy.prototype as { model?: string }).model;
	const f = await prototypes(t, [legacy]);
	f.workers.startReconciling();
	await f.workers.settleReconciling();
	assert.equal(f.spawned.length, 0, "no prototype chat without the planner's model");
	const unstick = f.workers.unstickView(f.missionId);
	assert.equal(unstick.state, "stuck");
	assert.match(unstick.line, /"Prototype p1" waits for the planning agent to choose the model/);
	await f.plan({
		purpose: "plan-map",
		expectedRevision: f.store.plans.get(f.missionId)!.revision,
		destination: "Today",
		sources: [],
		questions: [prototype("p1", { model: "faux/sol" })],
		fog: [],
	} as { purpose: string });
	await f.settle();
	assert.deepEqual(
		f.spawned.map((s) => s.model),
		["faux/sol"],
	);
});

test("a prototype's model is checked when the map is saved, and a refusal lists the allowed models", async (t) => {
	const f = await fixture(t, { published: false });
	const plans = new MissionPlans({
		store: f.store,
		journal: f.journal,
		authorize: () => {},
		checkModel: async (model) => {
			if (model !== "faux/opus")
				throw new Error(`Model ${model} is not available in the project's scope. Allowed models: faux/opus`);
		},
	});
	const save = async (model: string) => {
		const payload = JSON.stringify({
			purpose: "plan-map",
			expectedRevision: f.store.plans.get(f.missionId)!.revision,
			destination: "Today",
			sources: [],
			questions: [prototype("p1", { model })],
			fog: [],
		});
		const op = {
			schemaVersion: 1 as const,
			operationId: randomUUID(),
			producerId: randomUUID(),
			sequence: 1,
			origin: { ...f.journal.destination, hostId: "fixture" },
			destination: f.journal.destination,
			targetId: f.missionId,
			kind: "plan-map",
			payload,
			payloadHash: payloadHash(payload),
		};
		return f.journal.execute(op, (o, entry) => plans.admit(o, entry.firstEntry));
	};
	const refused = await save("faux/unknown");
	assert.equal(refused.state, "rejected");
	assert.match(
		refused.reason ?? "",
		/Prototype "p1": Model faux\/unknown is not available.*Allowed models: faux\/opus/,
	);
	assert.equal((await save("faux/opus")).state, "accepted");
	assert.equal(f.store.plans.get(f.missionId)!.questions.find((q) => q.id === "p1")!.prototype!.model, "faux/opus");
});
