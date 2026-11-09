import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { PlanningInput } from "@pilot/kernel";
import { interviewDigest } from "./mission-interview-contract.ts";
import { OperationJournal } from "./operation-journal.ts";
import { planningWorkerFixture } from "./planning-workers.fixture.ts";

async function heldFixture(t: Parameters<typeof planningWorkerFixture>[0], followup = false) {
	const f = await planningWorkerFixture(t, { followup });
	const enrolled = await f.post(f.enrollment);
	assert.equal(enrolled.state, "accepted", JSON.stringify(enrolled) + f.logs());
	const missionId = enrolled.result.missionId as string;
	await f.changed(
		() =>
			f.store.planningWorkers.get(missionId)?.phase === "held" &&
			f.sessions.get(f.specs[0]!.sessionId)?.state === "idle",
	);
	return Object.assign(f, { missionId, binding: f.specs[0]!.planning! });
}
async function answerAll(f: Awaited<ReturnType<typeof heldFixture>>) {
	const i = f.store.interviews.latest(f.missionId)!;
	const result = await f.human(f.missionId, {
		purpose: "interview-save",
		expected: { fence: i.fence, revision: i.revision },
		answers: i.questions.map((q) => ({
			questionId: q.id,
			questionDigest: interviewDigest(q),
			selectedOption: q.options[0]!,
			text: "",
		})),
	});
	assert.equal(result.receipt.state, "accepted");
}
async function submit(f: Awaited<ReturnType<typeof heldFixture>>) {
	const i = f.store.interviews.latest(f.missionId)!;
	return f.human(f.missionId, { purpose: "interview-submit", expected: { fence: i.fence, revision: i.revision } });
}

test("real worker returns a durable complete round, ends its turn, and only final submission admits one planning continuation", {
	timeout: 60000,
}, async (t) => {
	const f = await planningWorkerFixture(t);
	const enrolled = await f.post(f.enrollment);
	assert.equal(enrolled.state, "accepted", JSON.stringify(enrolled) + f.logs());
	const missionId = enrolled.result.missionId as string;
	const binding = f.specs[0]!.planning!;
	assert.equal(binding.profile.commit, "4ae2317ddb22b046e26455e4f9c9b3aaaf62212d");
	await f.changed(
		() =>
			f.store.planningWorkers.get(missionId)?.phase === "held" &&
			f.sessions.get(binding.ownerSessionId)?.state === "idle",
	);
	assert.equal(await f.requestCount(), 1, f.logs());
	let interview = f.store.interviews.latest(missionId)!;
	assert.equal(interview.questions.length, 2);
	assert.equal(
		f.sessions.canSendNotice(binding.ownerSessionId),
		false,
		"Generic automatic inputs cannot bypass the planning hold",
	);
	assert.equal(
		f.store.planningWorkers.get(missionId)!.hold!.fence.questionSetRevision,
		interview.fence.questionSetRevision,
	);
	assert.equal((await f.read(missionId)).capabilities.coordinatorProfile, 1);
	const expected = () => ({ fence: interview.fence, revision: interview.revision });
	const partial = await f.human(missionId, { purpose: "interview-submit", expected: expected() });
	assert.equal(partial.receipt.state, "rejected");
	for (const text of ["", "partial", "Different exact draft\n"]) {
		const q = interview.questions[0]!;
		const saved = await f.human(missionId, {
			purpose: "interview-save",
			expected: expected(),
			answers: [{ questionId: q.id, questionDigest: interviewDigest(q), selectedOption: null, text }],
		});
		assert.equal(saved.receipt.state, "accepted");
		interview = f.store.interviews.latest(missionId)!;
		assert.equal(f.store.planningWorkers.get(missionId)!.continuation, null);
		assert.equal(await f.requestCount(), 1);
	}
	assert.equal(
		(await f.human(missionId, { purpose: "interview-submit", expected: expected() })).receipt.state,
		"rejected",
		"Every question, not a required subset",
	);
	const saved = await f.human(missionId, {
		purpose: "interview-save",
		expected: expected(),
		answers: interview.questions.map((q) => ({
			questionId: q.id,
			questionDigest: interviewDigest(q),
			selectedOption: q.options[0]!,
			text: "exact extra detail",
		})),
	});
	assert.equal(saved.receipt.state, "accepted");
	interview = f.store.interviews.latest(missionId)!;
	const final = await f.human(missionId, { purpose: "interview-submit", expected: expected() });
	assert.equal(final.receipt.state, "accepted");
	await f.changed(
		() =>
			f.store.planningWorkers.get(missionId)?.phase === "active" &&
			f.sessions.get(binding.ownerSessionId)?.state === "idle",
	);
	assert.equal(await f.requestCount(), 2, f.logs());
	assert.equal((await f.post(final.op)).state, "accepted");
	assert.equal((await f.post(f.enrollment, true)).state, "accepted");
	assert.equal(await f.requestCount(), 2);
	assert.equal(f.store.tasks(missionId).length, 0, "Submission never admits builds");
	assert.equal(f.specs.length, 1, "No replacement worker or legacy enrollment");
});

test("later complete rounds ask new questions, preserve earlier submissions, and never inherit answers", {
	timeout: 60000,
}, async (t) => {
	const f = await heldFixture(t, true);
	await answerAll(f);
	const first = await submit(f);
	assert.equal(first.receipt.state, "accepted");
	await f.changed(
		() =>
			f.store.planningWorkers.get(f.missionId)?.phase === "held" &&
			f.store.interviews.latest(f.missionId)!.fence.questionSetRevision === 3 &&
			f.sessions.get(f.binding.ownerSessionId)?.state === "idle",
	);
	assert.equal(await f.requestCount(), 2);
	assert.equal((await submit(f)).receipt.state, "rejected");
	const freshHold = f.store.planningWorkers.get(f.missionId)!.hold;
	assert.equal((await f.post(first.op)).state, "accepted", "Earlier submitted round remains historical only");
	assert.equal(await f.requestCount(), 2);
	assert.deepEqual(f.store.planningWorkers.get(f.missionId)!.hold, freshHold);
	assert.throws(
		() => f.store.interviews.binding(f.missionId, f.store.brief(f.missionId)!),
		/complete interview agreement/,
	);
	assert.equal(f.store.interviews.lookup(first.op)!.submission!.answers.length, 2);
	assert.throws(
		() => f.store.interviews.assertNewQuestions(f.missionId, f.store.interviews.lookup(first.op)!.questions),
		/new clarification/,
	);
	await answerAll(f);
	assert.equal((await submit(f)).receipt.state, "accepted");
	await f.changed(
		() =>
			f.store.planningWorkers.get(f.missionId)?.phase === "active" &&
			f.sessions.get(f.binding.ownerSessionId)?.state === "idle",
	);
	assert.equal(await f.requestCount(), 3);
	assert.equal(f.store.interviews.lookup(first.op)!.submission!.answers.length, 2);
});

for (const change of ["Stop", "pause", "owner", "configuration"] as const) {
	test(`${change} after the saved round refuses continuation without clearing holds`, {
		timeout: 60000,
	}, async (t) => {
		const f = await heldFixture(t);
		await answerAll(f);
		if (change === "Stop") await f.sessions.stop(f.binding.ownerSessionId);
		if (change === "pause")
			await f.service.controls.execute(f.missionId, {
				version: 1,
				action: "pause",
				operationId: randomUUID(),
				home: { daemonId: f.hello.daemonId, lineageId: f.hello.lineageId! },
				projectId: f.project.id,
				coordinatorSessionId: f.binding.ownerSessionId,
				expectedRevision: 0,
			});
		if (change === "owner") f.store.update(f.missionId, { coordinatorSessionId: null });
		if (change === "configuration") await f.projectUpdate();
		if (change === "owner") {
			await assert.rejects(submit(f));
		} else {
			const final = await submit(f);
			assert.equal(final.receipt.state, "accepted");
			await f.server.closePlanning(); // Joins pending/refused continuation, no polling or unsafe retry.
		}
		assert.equal(await f.requestCount(), 1);
		assert.equal(f.store.planningWorkers.get(f.missionId)!.phase, "held");
		assert.equal(f.store.tasks(f.missionId).length, 0);
	});
}

test("lost native admission ACK settles only from its exact durable receipt, never a second input", {
	timeout: 60000,
}, async (t) => {
	const f = await heldFixture(t);
	const admit = f.sessions.admitPlanning.bind(f.sessions);
	t.mock.method(f.sessions, "admitPlanning", async (input: PlanningInput, guard: () => void) => {
		const receipt = await admit(input, guard);
		if (input.operation.kind === "interview-continue") throw new Error("Lost exact native admission ACK");
		return receipt;
	});
	await answerAll(f);
	const before = f.sessions.get(f.binding.ownerSessionId)!.outcomeAt;
	assert.equal((await submit(f)).receipt.state, "accepted");
	await f.changed(
		() =>
			f.sessions.get(f.binding.ownerSessionId)?.state === "idle" &&
			f.sessions.get(f.binding.ownerSessionId)?.outcomeAt !== before &&
			f.store.planningWorkers.get(f.missionId)?.phase === "continuing",
	);
	assert.equal(await f.requestCount(), 2);
	const lookup = t.mock.method(f.sessions, "lookupPlanning", f.sessions.lookupPlanning.bind(f.sessions));
	f.server.recoverOperations();
	await f.changed(() => f.store.planningWorkers.get(f.missionId)?.phase === "active");
	assert.ok(lookup.mock.callCount() >= 1);
	assert.equal(await f.requestCount(), 2);
});

test("daemon restart preserves drafts and the round hold, with no historical auto-send", {
	timeout: 60000,
}, async (t) => {
	const f = await heldFixture(t);
	const round = f.store.planningWorkers.get(f.missionId)!.hold;
	await f.restart();
	assert.equal(await f.requestCount(), 1);
	assert.equal(f.specs.length, 1, "Cold reads and restart do not reopen the waiting worker");
	assert.deepEqual(f.store.planningWorkers.get(f.missionId)!.hold, round);
	assert.equal((await f.read(f.missionId)).view.interview.questions.length, 2);
	await answerAll(f);
	assert.equal((await submit(f)).receipt.state, "accepted");
	await f.changed(
		() =>
			f.store.planningWorkers.get(f.missionId)?.phase === "active" &&
			f.sessions.get(f.binding.ownerSessionId)?.state === "idle",
	);
	assert.equal(await f.requestCount(), 2, f.logs());
	assert.deepEqual(f.specs[1]!.planning, f.binding);
	assert.equal(f.specs[1]!.planningHeldOnOpen, true);
});

test("entered admission without a native receipt stays Unknown across restart and duplicate submit", {
	timeout: 60000,
}, async (t) => {
	const f = await heldFixture(t);
	t.mock.method(f.sessions, "admitPlanning", async () => {
		throw new Error("Unknown entered native admission");
	});
	await answerAll(f);
	const final = await submit(f);
	assert.equal(final.receipt.state, "accepted");
	await f.server.closePlanning();
	assert.equal(f.store.planningWorkers.get(f.missionId)!.phase, "continuing");
	await f.restart();
	assert.equal((await f.post(final.op)).state, "accepted");
	f.server.recoverOperations();
	await f.server.closePlanning();
	assert.equal(f.store.planningWorkers.get(f.missionId)!.phase, "continuing");
	assert.equal(await f.requestCount(), 1);
	assert.equal(f.specs.length, 1, "No writer is opened to replay an uncertain admission");
});

test("a fast continuation tool waits for its full admission receipt before opening the next round", {
	timeout: 60000,
}, async (t) => {
	let release!: () => void, entered!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const reached = new Promise<void>((resolve) => {
		entered = resolve;
	});
	t.after(release);
	const execute = OperationJournal.prototype.execute;
	t.mock.method(
		OperationJournal.prototype,
		"execute",
		async function (this: OperationJournal, ...args: Parameters<typeof execute>) {
			const result = await execute.call(this, ...args);
			if (args[0].kind === "interview-continue" && result.state === "accepted") {
				entered();
				await gate;
			}
			return result;
		},
	);
	const f = await heldFixture(t, true);
	await answerAll(f);
	assert.equal((await submit(f)).receipt.state, "accepted");
	await reached;
	await f.changed(
		() => f.kernels[0]!.toolsRunning === true && f.store.planningWorkers.get(f.missionId)?.phase === "continuing",
	);
	assert.equal(f.store.interviews.latest(f.missionId)!.fence.questionSetRevision, 2);
	release();
	await f.changed(
		() =>
			f.store.planningWorkers.get(f.missionId)?.phase === "held" &&
			f.store.interviews.latest(f.missionId)!.fence.questionSetRevision === 3 &&
			f.sessions.get(f.binding.ownerSessionId)?.state === "idle",
	);
	assert.equal(await f.requestCount(), 2, "The follow-up tool was not refused or retried during receipt persistence");
});

test("native reads reject worker state appended after the invoked durability barrier", {
	timeout: 60000,
}, async (t) => {
	const f = await heldFixture(t);
	const durable = f.store.durable.bind(f.store);
	let once = true;
	t.mock.method(f.store, "durable", async () => {
		await durable();
		if (once) {
			once = false;
			const state = f.store.planningWorkers.get(f.missionId)!;
			f.store.planningWorkers.change(f.missionId, state.revision, (next) => {
				next.goal = "Changed after the read barrier";
			});
		}
	});
	await assert.rejects(f.read(f.missionId), /worker changed during read/);
});

test("planning idle admission wakes on a late tool-drain packet without ordinary summary fan-out", {
	timeout: 60000,
}, async (t) => {
	const f = await heldFixture(t);
	const worker = f.kernels[0]!;
	worker.toolsRunning = true;
	let summaries = 0;
	const off = f.sessions.onChange(() => {
		summaries++;
	});
	t.after(off);
	const waiting = f.sessions.planningIdle(f.binding.ownerSessionId, () => {}, new AbortController().signal);
	// This packet normally has no summary event. The previous idle notification arrived first.
	// biome-ignore lint/complexity/useLiteralKeys: Exercise the production IPC boundary and its private owner metadata.
	f.sessions["onPacket"](f.sessions["require"](f.binding.ownerSessionId), worker, {
		type: "tools.running",
		running: false,
	});
	await waiting;
	assert.equal(summaries, 0);
});

test("crash before initial generation preserves only an unanswerable bootstrap across recovery", {
	timeout: 60000,
}, async (t) => {
	const f = await planningWorkerFixture(t);
	const create = f.sessions.createPlanningWorker.bind(f.sessions);
	t.mock.method(f.sessions, "createPlanningWorker", async (...args: Parameters<typeof create>) => {
		await create(...args);
		await f.crashWorker();
		throw new Error("Interrupted setup before first generation");
	});
	const result = await f.post(f.enrollment);
	assert.equal(result.state, "pending");
	const bootstrap = f.store.interviews.lookup(f.enrollment)!;
	const missionId = bootstrap.fence.missionId;
	assert.deepEqual(bootstrap.questions, []);
	assert.equal(bootstrap.submission, null);
	assert.equal(f.store.planningWorkers.get(missionId)!.phase, "setup");
	assert.equal(f.store.planningWorkers.call(missionId, "$initial"), undefined);
	const read = await f.read(missionId);
	assert.equal(read.status, "preparing");
	assert.equal(read.view, null);
	assert.equal(read.contextDigest, null);
	assert.equal(read.capabilities.answers, "unavailable");
	const forbiddenSubmit = f.operation(
		missionId,
		{ purpose: "interview-submit", expected: { fence: bootstrap.fence, revision: bootstrap.revision } } as {
			purpose: string;
		},
		"0".repeat(64),
	);
	assert.equal((await f.post(forbiddenSubmit)).state, "rejected");
	await f.restart();
	assert.equal((await f.post(f.enrollment)).state, "pending", "Recovery cannot invent initial admission proof");
	assert.equal((await f.post(f.enrollment, true)).state, "pending");
	assert.deepEqual(f.store.interviews.latest(missionId), bootstrap);
	assert.equal((await f.read(missionId)).status, "preparing");
	assert.equal(await f.requestCount(), 0);
	assert.equal(f.specs.length, 1, "Recovery never creates or sends an initial historical input");
	assert.equal(f.store.tasks(missionId).length, 0);
});

test("Stop between complete submission and native admission cannot be cleared by continuation", {
	timeout: 60000,
}, async (t) => {
	let release!: () => void, entered!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const reached = new Promise<void>((resolve) => {
		entered = resolve;
	});
	t.after(release);
	const f = await heldFixture(t);
	const admit = f.sessions.admitPlanning.bind(f.sessions);
	let continuationAttempts = 0;
	t.mock.method(f.sessions, "admitPlanning", async (input: PlanningInput, guard: () => void) => {
		if (input.operation.kind === "interview-continue") {
			continuationAttempts++;
			entered();
			await gate;
		}
		return admit(input, guard);
	});
	await answerAll(f);
	const round = f.store.planningWorkers.get(f.missionId)!.hold;
	const final = await submit(f);
	assert.equal(final.receipt.state, "accepted");
	await reached;
	assert.equal(f.store.interviews.latest(f.missionId)!.submission!.operationId, final.op.operationId);
	await f.sessions.stop(f.binding.ownerSessionId);
	release();
	await f.server.closePlanning();
	assert.equal(f.store.planningWorkers.get(f.missionId)!.phase, "continuing");
	assert.deepEqual(f.store.planningWorkers.get(f.missionId)!.hold, round);
	assert.equal(await f.requestCount(), 1);
	assert.equal(continuationAttempts, 1);
	await f.restart();
	assert.equal((await f.post(final.op)).state, "accepted", "Historic submission receipt grants no new admission");
	f.server.recoverOperations();
	await f.server.closePlanning();
	assert.equal(await f.requestCount(), 1);
	assert.equal(f.specs.length, 1);
	assert.deepEqual(f.store.planningWorkers.get(f.missionId)!.hold, round);
	assert.equal(f.store.tasks(f.missionId).length, 0);
});
