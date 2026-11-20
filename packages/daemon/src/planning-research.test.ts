/** Ready research questions start read-only research chats; findings reach the planner once. Chats are faked. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "@pilot/protocol";
import { explorerQuestionSettled } from "./explorer-questions.ts";
import { publishedPlanningFixture as fixture } from "./published-planning.fixture.ts";

const research = (id: string, dependsOn: string[] = []) => ({
	id,
	title: `Research ${id}`,
	question: `What is true about ${id}?`,
	kind: "research",
	options: [],
	recommendedOptionId: null,
	dependsOn,
	sources: [],
});

test("ready research starts limited read-only chats and reports all findings together, once", async (t) => {
	const f = await fixture(t, { published: false });
	await f.plan({
		purpose: "plan-map",
		expectedRevision: 1,
		destination: "Importer",
		sources: [],
		questions: [research("a"), research("b"), research("c"), research("later", ["a"])],
		fog: [],
	} as { purpose: string });
	const chats = new Map<string, Partial<SessionSummary>>();
	const spawned: { title: string; mode?: string; role?: string }[] = [];
	t.mock.method(
		f.sessions,
		"spawn",
		async (request: { title: string; mode?: string }, _c: boolean, _t: unknown, admission: { role: string }) => {
			const id = `research-${spawned.length + 1}`;
			spawned.push({ title: request.title, mode: request.mode, role: admission.role });
			f.store.join(id, f.missionId, { sessionId: f.owner }, "explorer");
			chats.set(id, { id, state: "working", working: true });
			return { id } as SessionSummary;
		},
	);
	const get = f.sessions.get.bind(f.sessions);
	t.mock.method(f.sessions, "get", (id: string) =>
		chats.has(id) ? ({ ...chats.get(id) } as SessionSummary) : get(id),
	);
	t.mock.method(f.sessions, "lastAssistantReply", async () => "## Findings\nObserved: the importer reads tar files.");

	f.workers.startReconciling();
	await f.workers.settleReconciling();
	assert.deepEqual(spawned, [
		{ title: "Research: Research a", mode: "ask", role: "explorer" },
		{ title: "Research: Research b", mode: "ask", role: "explorer" },
	]);
	const claimed = () => Object.fromEntries(f.store.plans.get(f.missionId)!.questions.map((q) => [q.id, q.claimedBy]));
	assert.deepEqual(claimed(), { a: "research-1", b: "research-2", c: null, later: null });
	assert.equal(f.inputs.length, 0, "starting research sends the planner nothing");

	const finish = (id: string) => chats.set(id, { id, state: "idle", working: false, outcome: "done" });
	const settle = async () => {
		f.workers.scheduleReconcile(f.missionId);
		await f.workers.settleReconciling();
	};
	finish("research-1");
	await settle();
	assert.equal(f.inputs.length, 0, "findings wait while another research chat runs");
	assert.equal(spawned.length, 3, "a finished chat frees its research slot");
	assert.equal(claimed().c, "research-3");

	finish("research-2");
	finish("research-3");
	await settle();
	assert.equal(f.inputs.length, 1, "one planner turn for every finished chat");
	assert.equal(f.inputs[0]!.operation.kind, "plan-research-result");
	for (const id of ["a", "b", "c"]) assert.match(f.inputs[0]!.content, new RegExp(`Map question "${id}"`));
	assert.match(f.inputs[0]!.content, /the importer reads tar files/);
	await settle();
	assert.equal(f.inputs.length, 1, "findings are sent once");

	// The planner finds a's findings weak and unclaims it: one more chat, never a third.
	const unclaim = async () =>
		f.plan({
			purpose: "plan-claim",
			expectedRevision: f.store.plans.get(f.missionId)!.revision,
			questionId: "a",
			claimedBy: null,
		} as { purpose: string });
	await unclaim();
	await settle();
	assert.equal(spawned.length, 4);
	assert.equal(claimed().a, "research-4");
	// research-4 took over a's question: research-1's question no longer needs the user. b's chat still asks.
	assert.deepEqual(f.store.planningWorkers.get(f.missionId)!.research!.a!.earlierSessionIds, ["research-1"]);
	const settled = (id: string, title: string) => explorerQuestionSettled(f.store, { id, title });
	assert.equal(settled("research-1", "Research: Research a"), true);
	assert.equal(settled("research-4", "Research: Research a"), false);
	assert.equal(settled("research-2", "Research: Research b"), false);
	finish("research-4");
	await settle();
	assert.equal(f.inputs.length, 2);
	await unclaim();
	await settle();
	assert.equal(spawned.length, 4, "at most two research chats per question");
	// The planner changes the question (say, new source access): that changed question gets one chat again.
	await f.plan({
		purpose: "plan-map",
		expectedRevision: f.store.plans.get(f.missionId)!.revision,
		destination: "Importer",
		sources: [],
		questions: [
			{ ...research("a"), question: "What is true about a, now that its source is readable?" },
			research("b"),
			research("c"),
			research("later", ["a"]),
		],
		fog: [],
	} as { purpose: string });
	await settle();
	assert.equal(spawned.length, 5);
	assert.equal(claimed().a, "research-5");
	finish("research-5");
	await settle();
	await unclaim();
	await settle();
	assert.equal(spawned.length, 5, "the same changed question does not loop");
	assert.equal(f.store.tasks(f.missionId).length, 0, "research never creates build tasks");
});

test("a research chat that asks the user closes when a newer chat or the plan settles its question", async (t) => {
	const f = await fixture(t, { published: false });
	const revision = () => f.store.plans.get(f.missionId)!.revision;
	// The planner unclaims "a" and rewrites it, as it does after new source access.
	const map = async (aQuestion: string, unclaim = true) => {
		if (unclaim)
			await f.plan({ purpose: "plan-claim", expectedRevision: revision(), questionId: "a", claimedBy: null } as {
				purpose: string;
			});
		await f.plan({
			purpose: "plan-map",
			expectedRevision: revision(),
			destination: "Importer",
			sources: [],
			questions: [{ ...research("a"), question: aQuestion }, research("b")],
			fog: [],
		} as { purpose: string });
	};
	await map("What is true about a?", false);
	const chats = new Map<string, Partial<SessionSummary>>();
	let spawned = 0;
	t.mock.method(f.sessions, "spawn", async () => {
		const id = `research-${++spawned}`;
		f.store.join(id, f.missionId, { sessionId: f.owner }, "explorer");
		chats.set(id, { id, state: "working", working: true });
		return { id } as SessionSummary;
	});
	const get = f.sessions.get.bind(f.sessions);
	t.mock.method(f.sessions, "get", (id: string) =>
		chats.has(id) ? ({ ...chats.get(id) } as SessionSummary) : get(id),
	);
	t.mock.method(f.sessions, "lastAssistantReply", async () => "Findings");
	const withdrawn: [string, string][] = [];
	t.mock.method(f.sessions, "withdrawQuestion", async (id: string, note: string) => {
		withdrawn.push([id, note]);
		chats.set(id, { ...chats.get(id), outcome: "stopped", outcomeReason: note });
		return true;
	});
	const archived: string[] = [];
	t.mock.method(f.sessions, "archive", async (id: string) => {
		archived.push(id);
		chats.set(id, { ...chats.get(id), archivedAt: 1 });
		return chats.get(id) as SessionSummary;
	});
	const settle = async () => {
		f.workers.scheduleReconcile(f.missionId);
		await f.workers.settleReconciling();
	};
	const ask = (id: string) =>
		chats.set(id, {
			id,
			state: "idle",
			working: false,
			outcome: "question",
			outcomeReason: "Can you restore access?",
		});
	f.workers.startReconciling();
	await f.workers.settleReconciling();
	assert.equal(spawned, 2);

	// research-1 asks the user. Its question goes to the planner, which rewrites the map question after new access.
	ask("research-1");
	chats.set("research-2", { id: "research-2", state: "idle", working: false, outcome: "done" });
	await settle();
	assert.equal(f.inputs.length, 1);
	assert.match(
		f.inputs[0]!.content,
		/The research chat ended with a question to the user, not findings: "Can you restore access\?"/,
	);
	assert.deepEqual(withdrawn, [], "a chat that asks stays open until a newer chat replaces it");
	await map("What is true about a, now that its source is readable?");
	await settle();
	assert.equal(spawned, 3, "the changed question gets a newer research chat");
	assert.deepEqual(withdrawn, [["research-1", "Pilot started a newer research chat for this question."]]);
	assert.deepEqual(archived, ["research-1"]);
	await settle();
	assert.equal(withdrawn.length, 1, "a closed chat is closed once");

	// A replaced chat that works again (the user replied) is never archived while it works.
	chats.set("research-3", { id: "research-3", state: "idle", working: false, outcome: "done" });
	await settle();
	await map("What is true about a, from the linked source?");
	await settle();
	assert.equal(spawned, 4);
	assert.deepEqual(f.store.planningWorkers.get(f.missionId)!.research!.a!.earlierSessionIds, [
		"research-1",
		"research-3",
	]);
	assert.deepEqual(archived, ["research-1"], "a finished chat that asks nothing stays as it is");
	chats.set("research-3", { id: "research-3", state: "working", working: true });
	await settle();
	assert.deepEqual(archived, ["research-1"], "a working chat is never archived");

	// The current chat asks the user, and the plan settles its question: it no longer waits on the user either.
	ask("research-4");
	await settle();
	const plans = f.store.plans;
	const plan = plans.get(f.missionId)!;
	t.mock.method(plans, "get", () => ({
		...plan,
		questions: plan.questions.map((q) =>
			q.id === "a" ? { ...q, resolution: { kind: "knowledge", id: "k", digest: "d" } } : q,
		),
	}));
	await settle();
	assert.deepEqual(withdrawn.at(-1), ["research-4", "The plan settled this question."]);
	assert.deepEqual(archived, ["research-1", "research-4"]);
});

test("many split research questions reach the planner in limited batches, not all at the end", async (t) => {
	const f = await fixture(t, { published: false });
	const ids = ["a", "b", "c", "d", "e", "g"];
	await f.plan({
		purpose: "plan-map",
		expectedRevision: 1,
		destination: "Importer",
		sources: [],
		questions: ids.map((id) => research(id)),
		fog: [],
	} as { purpose: string });
	const chats = new Map<string, Partial<SessionSummary>>();
	let spawned = 0;
	t.mock.method(f.sessions, "spawn", async (_r: unknown, _c: boolean, _t: unknown, _a: unknown) => {
		const id = `research-${++spawned}`;
		f.store.join(id, f.missionId, { sessionId: f.owner }, "explorer");
		chats.set(id, { id, state: "working", working: true });
		return { id } as SessionSummary;
	});
	const get = f.sessions.get.bind(f.sessions);
	t.mock.method(f.sessions, "get", (id: string) =>
		chats.has(id) ? ({ ...chats.get(id) } as SessionSummary) : get(id),
	);
	t.mock.method(f.sessions, "lastAssistantReply", async () => "Findings");
	const settle = async () => {
		f.workers.scheduleReconcile(f.missionId);
		await f.workers.settleReconciling();
	};
	const finish = async (n: number) => {
		chats.set(`research-${n}`, { id: `research-${n}`, state: "idle", working: false, outcome: "done" });
		await settle();
	};
	f.workers.startReconciling();
	await f.workers.settleReconciling();
	assert.equal(spawned, 2);
	await finish(1);
	await finish(2);
	assert.equal(f.inputs.length, 0, "two findings wait while chats still run");
	await finish(3);
	assert.equal(f.inputs.length, 1, "a full batch goes while another chat still runs");
	for (const id of ["a", "b", "c"]) assert.match(f.inputs[0]!.content, new RegExp(`Map question "${id}"`));
	assert.doesNotMatch(f.inputs[0]!.content, /Map question "d"/);
	await settle();
	assert.equal(spawned, 5, "research continues after the batch");
	await finish(4);
	await finish(5);
	await finish(6);
	assert.equal(f.inputs.length, 2);
	for (const id of ["d", "e", "g"]) assert.match(f.inputs[1]!.content, new RegExp(`Map question "${id}"`));
});

test("Pilot saves findings word for word as linked Knowledge; the planner gets ids and synopses, not reports", async (t) => {
	const f = await fixture(t, { published: false, knowledge: true });
	await f.plan({
		purpose: "plan-map",
		expectedRevision: 1,
		destination: "Importer",
		sources: [],
		questions: [research("a")],
		fog: [],
	} as { purpose: string });
	const chats = new Map<string, Partial<SessionSummary>>();
	t.mock.method(f.sessions, "spawn", async () => {
		f.store.join("research-1", f.missionId, { sessionId: f.owner }, "explorer");
		chats.set("research-1", { id: "research-1", state: "working", working: true });
		return { id: "research-1" } as SessionSummary;
	});
	const get = f.sessions.get.bind(f.sessions);
	t.mock.method(f.sessions, "get", (id: string) =>
		chats.has(id) ? ({ ...chats.get(id) } as SessionSummary) : get(id),
	);
	const report =
		"## Question\nImporter?\n\n## Findings\nObserved: the importer reads tar files, with spaces kept exactly.\n\n## Limitations\nNone.";
	t.mock.method(f.sessions, "lastAssistantReply", async () => report);
	f.workers.startReconciling();
	await f.workers.settleReconciling();
	chats.set("research-1", { id: "research-1", state: "idle", working: false, outcome: "done" });
	f.workers.scheduleReconcile(f.missionId);
	await f.workers.settleReconciling();
	const saved = f.store.planningWorkers.get(f.missionId)!.research!.a!.knowledge!;
	const entry = f.store.knowledge.detail(f.project.id, saved.id);
	assert.ok(entry?.revision.body.includes(report), "the report is kept word for word");
	assert.deepEqual(entry?.revision.author, { type: "session", sessionId: "research-1" });
	assert.equal(f.store.knowledge.link(f.missionId, saved.id).linked, true);
	assert.equal(saved.synopsis, "Observed: the importer reads tar files, with spaces kept exactly. Limitations None.");
	assert.equal(f.inputs.length, 1);
	assert.match(f.inputs[0]!.content, new RegExp(`Saved as Knowledge ${saved.id}, revision 1`));
	assert.doesNotMatch(f.inputs[0]!.content, /## Findings/, "the planner never gets the full report to retype");
});

test("research waits while the planner works and never starts for a published plan", async (t) => {
	const f = await fixture(t, { published: false });
	await f.plan({
		purpose: "plan-map",
		expectedRevision: 1,
		destination: "Importer",
		sources: [],
		questions: [research("a")],
		fog: [],
	} as { purpose: string });
	const spawn = t.mock.method(f.sessions, "spawn", async () => {
		throw new Error("unexpected");
	});
	const get = f.sessions.get.bind(f.sessions);
	const working = true;
	t.mock.method(f.sessions, "get", (id: string) => {
		const meta = get(id);
		return meta && id === f.owner ? { ...meta, working, state: working ? "working" : meta.state } : meta;
	});
	f.workers.startReconciling();
	await f.workers.settleReconciling();
	assert.equal(spawn.mock.callCount(), 0);

	const published = await fixture(t);
	const spawnPublished = t.mock.method(published.sessions, "spawn", async () => {
		throw new Error("unexpected");
	});
	published.workers.startReconciling();
	await published.workers.settleReconciling();
	assert.equal(spawnPublished.mock.callCount(), 0);
});
