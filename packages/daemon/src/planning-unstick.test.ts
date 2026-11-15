/** Unstick: why a mission's planning moves, waits or is stuck, with at most one fix. Reading changes nothing. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "@pilot/protocol";
import { publishedPlanningFixture as fixture } from "./published-planning.fixture.ts";

test("an idle planner on an open plan is stuck, and Continue planning is the fix; a working one moves", async (t) => {
	const f = await fixture(t, { published: false });
	const view = f.workers.unstickView(f.missionId);
	assert.deepEqual([view.state, view.fix], ["stuck", "continue"]);
	assert.match(view.line, /stopped while the plan is still open/);
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
