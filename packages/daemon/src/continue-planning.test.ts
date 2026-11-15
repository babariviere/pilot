/** Continue planning: an explicit user wake for an idle, unpublished planner. Worker effects are faked. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { publishedPlanningFixture as fixture } from "./published-planning.fixture.ts";

async function continueOp(f: Awaited<ReturnType<typeof fixture>>) {
	const read = await f.native.read(f.project.id, f.missionId);
	assert.equal(read.continuePlanning?.available, true, JSON.stringify(read.continuePlanning));
	return f.operation(f.missionId, { purpose: "plan-continue" }, read.continuePlanning!.contextDigest);
}

test("Continue planning admits one planning-only turn, once", async (t) => {
	const f = await fixture(t, { published: false });
	assert.equal(f.inputs.length, 0, "passive reads never admit");
	const op = await continueOp(f);
	assert.equal((await f.execute(op)).state, "accepted");
	assert.equal(f.inputs.length, 1);
	assert.equal(f.inputs[0]!.hold, null);
	assert.match(f.inputs[0]!.content, /asked you to continue planning/);
	assert.equal((await f.execute(op)).state, "accepted");
	assert.equal(f.inputs.length, 1, "same operation never reenters");
});

test("feedback on the interview reaches the planner word for word; empty or extra fields are refused", async (t) => {
	const f = await fixture(t, { published: false });
	const read = await f.native.read(f.project.id, f.missionId);
	const digest = read.continuePlanning!.contextDigest;
	const empty = f.operation(f.missionId, { purpose: "plan-continue", feedback: "  " }, digest);
	assert.equal((await f.execute(empty)).state, "rejected");
	const extra = f.operation(f.missionId, { purpose: "plan-continue", feedback: "x", answer: "a" }, digest);
	assert.equal((await f.execute(extra)).state, "rejected");
	const text = 'Too technical. Use plain words, and "FB-01" means nothing to me.';
	const op = f.operation(f.missionId, { purpose: "plan-continue", feedback: text }, digest);
	assert.equal((await f.execute(op)).state, "accepted");
	assert.equal(f.inputs.length, 1);
	assert.match(f.inputs[0]!.content, /feedback on the current interview instead of answering it/);
	assert.ok(f.inputs[0]!.content.endsWith(`Feedback: ${JSON.stringify(text)}`));
});

test("an approved repair note reaches the planner word for word; with feedback, empty or too long, it is refused", async (t) => {
	const f = await fixture(t, { published: false });
	const read = await f.native.read(f.project.id, f.missionId);
	const digest = read.continuePlanning!.contextDigest;
	for (const payload of [
		{ purpose: "plan-continue", note: "x", feedback: "y" },
		{ purpose: "plan-continue", note: " " },
		{ purpose: "plan-continue", note: "x".repeat(2001) },
	])
		assert.equal((await f.execute(f.operation(f.missionId, payload, digest))).state, "rejected");
	const note = "The map is full: merge open research questions a and b.";
	const op = f.operation(f.missionId, { purpose: "plan-continue", note }, digest);
	assert.equal((await f.execute(op)).state, "accepted");
	assert.equal(f.inputs.length, 1);
	assert.match(f.inputs[0]!.content, /repair agent looked at why planning stopped, and the user approved this note/);
	assert.ok(f.inputs[0]!.content.endsWith(`Note: ${JSON.stringify(note)}`));
});

test("a round waiting for answers takes a comment, which releases that exact round; never a plain Continue", async (t) => {
	const f = await fixture(t, { published: false });
	const state = f.store.planningWorkers.get(f.missionId)!;
	const hold = {
		fence: { ...state.binding, answerRevision: 1, questionSetRevision: 2 } as never,
		revision: 3,
		operationId: "held-round",
		contextDigest: "d".repeat(64),
	};
	f.store.planningWorkers.change(f.missionId, state.revision, (s) => {
		s.phase = "held";
		s.hold = hold;
	});
	const read = await f.native.read(f.project.id, f.missionId);
	assert.equal(read.continuePlanning?.available, true);
	assert.equal((read.continuePlanning as { feedbackOnly?: boolean }).feedbackOnly, true);
	const digest = read.continuePlanning!.contextDigest;
	assert.equal((await f.execute(f.operation(f.missionId, { purpose: "plan-continue" }, digest))).state, "rejected");
	const op = f.operation(f.missionId, { purpose: "plan-continue", feedback: "Plainer words, please." }, digest);
	assert.equal((await f.execute(op)).state, "accepted");
	assert.equal(f.inputs.length, 1);
	assert.deepEqual(f.inputs[0]!.hold, hold);
	const after = f.store.planningWorkers.get(f.missionId)!;
	assert.equal(after.phase, "active");
	assert.equal(after.hold, null);
});

test("a parked idle planner can continue; a working one cannot", async (t) => {
	const f = await fixture(t, { published: false });
	const get = f.sessions.get.bind(f.sessions);
	let state: "parked" | "working" = "parked";
	t.mock.method(f.sessions, "get", (id: string) => {
		const meta = get(id);
		return meta && id === f.binding.ownerSessionId ? { ...meta, state, working: state === "working" } : meta;
	});
	const op = await continueOp(f);
	state = "working";
	assert.equal((await f.native.read(f.project.id, f.missionId)).continuePlanning?.available, false);
	assert.equal((await f.execute(op)).state, "rejected");
	state = "parked";
	const again = await continueOp(f);
	assert.equal((await f.execute(again)).state, "accepted");
	assert.equal(f.inputs.length, 1);
});

test("Continue planning refuses a stale view, a held planner and a published plan", async (t) => {
	const f = await fixture(t, { published: false });
	const stale = f.operation(f.missionId, { purpose: "plan-continue" }, "b".repeat(64));
	assert.equal((await f.execute(stale)).state, "rejected");
	const op = await continueOp(f);
	const state = f.store.planningWorkers.get(f.missionId)!;
	f.store.planningWorkers.change(f.missionId, state.revision, (s) => {
		s.phase = "held";
	});
	assert.equal((await f.execute(op)).state, "rejected");
	assert.equal(f.inputs.length, 0);

	const published = await fixture(t);
	const read = await published.native.read(published.project.id, published.missionId);
	assert.equal(read.continuePlanning?.available, false);
	assert.match(read.continuePlanning!.reason, /Revisit/);
});
