/** Unstick: why a mission's planning moves, waits or is stuck, with at most one fix. Reading changes nothing. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "@pilot/protocol";
import { publishedPlanningFixture as fixture } from "./published-planning.fixture.ts";

test("an idle planner on an open plan is stuck, and Continue planning is the fix; a working one moves", async (t) => {
	const f = await fixture(t, { published: false });
	const view = f.workers.unstickView(f.missionId);
	assert.deepEqual([view.state, view.fix], ["stuck", "continue"]);
	assert.match(view.line, /ended its turn while the plan is still open/);
	assert.ok(view.checks.some((c) => c.startsWith("Planning agent: idle")));
	const read = await f.native.read(f.project.id, f.missionId);
	assert.deepEqual((read as { unstick?: unknown }).unstick, view);

	const get = f.sessions.get.bind(f.sessions);
	t.mock.method(f.sessions, "get", (id: string) => {
		const meta = get(id);
		return meta && id === f.binding.ownerSessionId
			? ({ ...meta, state: "working", working: true } as SessionSummary)
			: meta;
	});
	assert.equal(f.workers.unstickView(f.missionId).state, "moving");
});

test("a planner that ended its turn in prose shows its last words on the plan read and the planning list", async (t) => {
	const f = await fixture(t, { published: false });
	const view = f.workers.unstickView(f.missionId);
	assert.equal(view.reply, true);
	assert.match(view.line, /may be waiting for your reply/);
	const words = "Which database should the export use? Tell me and I will continue.";
	const reads = t.mock.method(f.sessions, "lastAssistantReply", async (id: string) =>
		id === f.binding.ownerSessionId ? `  ${words}\n` : undefined,
	);
	const read = (await f.native.read(f.project.id, f.missionId)) as { unstick?: { plannerSays?: string } };
	assert.equal(read.unstick?.plannerSays, words);
	const list = await f.native.inventory(f.project.id);
	const row = list.items.find((i) => i.missionId === f.missionId);
	assert.deepEqual(row?.stuck, { line: view.line, reply: true, plannerSays: words });
	// needsYou keeps following the stage alone (questions or review). Stuck is its own field.
	assert.equal(row?.needsYou, row?.stage === "questions" || row?.stage === "review");
	// The list keeps the stuck read and the words: another list read reads no history and no unstick again.
	const plain = t.mock.method(f.workers, "unstickView");
	const before = reads.mock.callCount();
	const again = await f.native.inventory(f.project.id);
	assert.deepEqual(again.items.find((i) => i.missionId === f.missionId)?.stuck, row?.stuck);
	assert.equal(reads.mock.callCount(), before);
	assert.equal(plain.mock.callCount(), 0);
	// A change of the mission drops the kept read; a new turn of the planner drops its words.
	f.store.planningWorkers.change(f.missionId, f.store.planningWorkers.get(f.missionId)!.revision, () => {});
	await f.native.inventory(f.project.id);
	assert.equal(plain.mock.callCount(), 1);
	const get = f.sessions.get.bind(f.sessions);
	t.mock.method(f.sessions, "get", (id: string) => {
		const s = get(id);
		return s && id === f.binding.ownerSessionId ? ({ ...s, outcomeAt: 99, updatedAt: 99 } as SessionSummary) : s;
	});
	await f.native.inventory(f.project.id);
	assert.equal(reads.mock.callCount(), before + 1);
	assert.equal(plain.mock.callCount(), 2);
});

test("Diagnostics read planning facts and recent operations, never question or answer text", async (t) => {
	const f = await fixture(t, { published: false });
	const read = await f.native.read(f.project.id, f.missionId);
	const op = f.operation(f.missionId, { purpose: "plan-continue" }, read.continuePlanning!.contextDigest);
	assert.equal((await f.execute(op)).state, "accepted");
	const refused = f.operation(
		f.missionId,
		{ purpose: "plan-continue", feedback: "  " },
		read.continuePlanning!.contextDigest,
	);
	assert.equal((await f.execute(refused)).state, "rejected");
	const facts = f.workers.diagnosticPlanning(f.missionId)!;
	assert.equal(facts.plannerChatId, f.binding.ownerSessionId);
	assert.deepEqual(
		facts.operations.items.map((o) => [o.kind, o.state]),
		[
			["plan-continue", "rejected"],
			["plan-continue", "accepted"],
		],
	);
	assert.ok(facts.operations.items[0]!.reason);
	assert.ok(facts.map && facts.map.byteLimit === 192 * 1024 && facts.map.openQuestions >= 0);
	assert.ok(facts.round && facts.round.questions > 0);
	const text = JSON.stringify(facts);
	for (const q of f.store.interviews.latest(f.missionId)!.questions)
		assert.ok(!text.includes(q.prompt), "no question text");
	assert.equal(f.workers.diagnosticPlanning("missing"), null);
});

test("a refused save shows its reason until a save is accepted", async (t) => {
	const f = await fixture(t, { published: false });
	f.store.plans.refused(f.missionId, {
		kind: "plan-map",
		reason: "Invalid planning list: the map holds at most 40 questions",
	});
	const view = f.workers.unstickView(f.missionId);
	assert.deepEqual([view.state, view.fix], ["stuck", "continue"]);
	assert.match(
		view.line,
		/refused the planning agent's last save, and it stopped: Invalid planning list: the map holds/,
	);
	assert.ok(view.checks.includes("Last save refused: plan-map"));
	f.store.plans.refused(f.missionId, null);
	assert.doesNotMatch(f.workers.unstickView(f.missionId).line, /refused/);
});

test("answers to an earlier wording block saves: stuck, and dropping them is the fix; otherwise a round just waits", async (t) => {
	const f = await fixture(t, { published: false });
	const state = f.store.planningWorkers.get(f.missionId)!;
	f.store.planningWorkers.change(f.missionId, state.revision, (s) => {
		s.phase = "held";
	});
	const latest = f.store.interviews.latest(f.missionId)!;
	const q = latest.questions[0]!;
	const open = (answers: { questionId: string; questionDigest: string }[]) =>
		t.mock.method(f.store.interviews, "latest", () => ({ ...latest, submission: undefined, answers }));
	const waiting = open([]);
	assert.deepEqual(
		[f.workers.unstickView(f.missionId).state, f.workers.unstickView(f.missionId).fix],
		["waiting", null],
	);
	waiting.mock.restore();
	open([{ questionId: q.id, questionDigest: "earlier" }]);
	const view = f.workers.unstickView(f.missionId);
	assert.deepEqual([view.state, view.fix], ["stuck", "drop-earlier-answers"]);
	assert.ok(view.checks.some((c) => c.includes("1 to an earlier wording")));
});
