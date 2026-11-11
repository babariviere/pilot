import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { interviewDigest } from "./mission-interview-contract.ts";
import { canonicalJSON, OperationJournal, payloadHash } from "./operation-journal.ts";
import { planningWorkerFixture } from "./planning-workers.fixture.ts";
import { Worker } from "./sessions.ts";

async function published(t: Parameters<typeof planningWorkerFixture>[0], journey = false) {
	const f = await planningWorkerFixture(t, journey ? { journey: true } : { publishedPlan: true });
	const enrollment = await f.post(f.enrollment);
	assert.equal(enrollment.state, "accepted", JSON.stringify(enrollment));
	const missionId = enrollment.result.missionId as string;
	const owner = f.specs[0]!.sessionId;
	await f.changed(
		() => f.store.planningWorkers.get(missionId)?.phase === "held" && f.sessions.get(owner)?.state === "idle",
	);
	if (journey) {
		const round = f.store.interviews.latest(missionId)!;
		assert.equal(round.questions.length, 2);
		const saved = await f.human(missionId, {
			purpose: "interview-save",
			expected: { fence: round.fence, revision: round.revision },
			answers: round.questions.map((q) => ({
				questionId: q.id,
				questionDigest: interviewDigest(q),
				selectedOption: q.options[0]!,
				text: "Clarified exactly",
			})),
		});
		assert.equal(saved.receipt.state, "accepted");
		const answered = f.store.interviews.latest(missionId)!;
		assert.equal(
			(
				await f.human(missionId, {
					purpose: "interview-submit",
					expected: { fence: answered.fence, revision: answered.revision },
				})
			).receipt.state,
			"accepted",
		);
		await f.changed(
			() =>
				f.store.planningWorkers.get(missionId)?.phase === "held" &&
				f.store.interviews.latest(missionId)!.fence.questionSetRevision > round.fence.questionSetRevision &&
				f.sessions.get(owner)?.state === "idle",
		);
		assert.equal(f.store.tasks(missionId).length, 0, "Clarification submission admits no Build");
	}
	const i = f.store.interviews.latest(missionId)!;
	assert.equal(i.questions.length, 1, f.logs());
	assert.equal(
		(
			await f.human(missionId, {
				purpose: "interview-save",
				expected: { fence: i.fence, revision: i.revision },
				answers: i.questions.map((q) => ({
					questionId: q.id,
					questionDigest: interviewDigest(q),
					selectedOption: q.options.find((o) => o.id === "approve")!,
					text: "",
				})),
			})
		).receipt.state,
		"accepted",
	);
	const saved = f.store.interviews.latest(missionId)!;
	assert.equal(
		(
			await f.human(missionId, {
				purpose: "interview-submit",
				expected: { fence: saved.fence, revision: saved.revision },
			})
		).receipt.state,
		"accepted",
	);
	await f.changed(() => !!f.store.plans.get(missionId)?.publication && f.sessions.get(owner)?.state === "idle");
	assert.equal(f.specs.length, 1, "Approval and publication do not admit a builder");
	const read = await f.read(missionId);
	assert.equal(read.start.available, true, JSON.stringify(read.start) + f.logs());
	const op = f.operation(
		missionId,
		{
			purpose: "plan-start",
			expectedRevision: read.start.revision,
			planDigest: read.start.digest,
			taskId: read.start.taskId,
		} as { purpose: string },
		read.start.contextDigest,
	);
	return Object.assign(f, { missionId, owner, op });
}

test("clarification -> separate agreement -> explicit Start -> offline report; duplicate and reopen never create again", {
	timeout: 90000,
}, async (t) => {
	const f = await published(t, true);
	const receipt = await f.post(f.op);
	assert.equal(receipt.state, "accepted", JSON.stringify(receipt) + f.logs());
	await f.changed(() => f.service.reports.latest(f.missionId).length === 1);
	assert.equal(f.specs.length, 2, f.logs());
	assert.equal(f.store.task(f.missionId, JSON.parse(f.op.payload).taskId).sessionId, receipt.result.sessionId);
	assert.equal(
		(await f.service.reports.views(f.missionId))[0]!.report.write.summary,
		"Offline background worker reported",
	);
	const overview = await (await fetch(`${f.base}/api/projects/${f.project.id}/day`)).json();
	assert.equal(
		overview.reports[0].report.write.summary,
		"Offline background worker reported",
		"The existing Today read exposes the real worker report",
	);
	assert.deepEqual(await f.post(f.op), receipt);
	assert.deepEqual(await f.post(f.op, true), receipt);
	await f.restart();
	assert.deepEqual(await f.post(f.op), receipt);
	assert.equal((await f.read(f.missionId)).start.state, "admitted");
	assert.equal(f.sessions.list().length, 2);
});

test("unavailable model authority leaves Start unavailable with no new worker", { timeout: 60000 }, async (t) => {
	const f = await published(t);
	t.mock.method(f.sessions, "selectTaskModel", async () => {
		throw new Error("Model authority unavailable");
	});
	assert.equal((await f.read(f.missionId)).start.available, false);
	assert.equal((await f.post(f.op)).state, "rejected");
	assert.equal(f.specs.length, 1);
});

test("stale plan and modified published task refuse without admission", { timeout: 60000 }, async (t) => {
	const f = await published(t);
	const request = JSON.parse(f.op.payload);
	const payload = canonicalJSON({ ...request, expectedRevision: request.expectedRevision - 1 });
	assert.equal(
		(
			await f.post({
				...f.op,
				operationId: randomUUID(),
				producerId: randomUUID(),
				payload,
				payloadHash: payloadHash(payload),
			})
		).state,
		"rejected",
	);
	f.store.updateTask(f.missionId, request.taskId, { body: "Unapproved replacement" });
	assert.equal((await f.post(f.op)).state, "rejected");
	assert.equal((await f.read(f.missionId)).start.available, false);
	assert.equal(f.specs.length, 1);
});

for (const change of ["Stop", "Pause", "close"] as const) {
	test(`${change} during final kernel Start admission refuses without provider work`, {
		timeout: 60000,
	}, async (t) => {
		const f = await published(t);
		const count = await f.requestCount();
		const original = Worker.prototype.request;
		t.mock.method(Worker.prototype, "request", async function (this: Worker, ...args: Parameters<typeof original>) {
			if (args[0].type === "plan.start") {
				if (change === "Stop") await f.sessions.stop(f.owner);
				if (change === "Pause") {
					await f.service.controls.execute(f.missionId, {
						version: 1,
						action: "pause",
						operationId: randomUUID(),
						home: { daemonId: f.hello.daemonId, lineageId: f.hello.lineageId! },
						projectId: f.project.id,
						coordinatorSessionId: f.owner,
						expectedRevision: 0,
					});
				}
				if (change === "close") {
					// Closing joins this entered input. It must not settle before the guard refuses.
					void f.server.closePlanning();
				}
			}
			return original.apply(this, args);
		});
		const receipt = await f.post(f.op);
		assert.equal(receipt.state, "pending", JSON.stringify(receipt));
		await f.server.closePlanning();
		assert.equal(await f.requestCount(), count);
		assert.equal(
			await f.sessions.lookupPublishedTask(
				f.store.planningWorkers.get(f.missionId)!.start!.sessionId,
				f.op.operationId,
			),
			false,
		);
		assert.equal((await f.post(f.op, true)).state, "pending");
	});
}

test("lost kernel ACK is exact lookup-only, including after daemon reopen", { timeout: 60000 }, async (t) => {
	const f = await published(t);
	const original = f.sessions.admitPublishedTask.bind(f.sessions);
	t.mock.method(f.sessions, "admitPublishedTask", async (...args: Parameters<typeof original>) => {
		await original(...args);
		throw new Error("Lost kernel ACK");
	});
	assert.equal((await f.post(f.op)).state, "pending");
	await f.changed(
		() =>
			f.service.reports.latest(f.missionId).length === 1 &&
			f.sessions.get(f.store.planningWorkers.get(f.missionId)?.start?.sessionId ?? "")?.state === "idle",
	);
	const count = await f.requestCount();
	const receipt = await f.post(f.op, true);
	assert.equal(receipt.state, "accepted", JSON.stringify(receipt));
	await f.restart();
	assert.deepEqual(await f.post(f.op, true), receipt);
	assert.equal(await f.requestCount(), count);
	assert.equal(f.sessions.list().length, 2);
});

test("Start reserved before effect stays Unknown across duplicate and reopen; no retry can create a worker", {
	timeout: 60000,
}, async (t) => {
	const f = await published(t);
	t.mock.method(f.sessions, "admitPublishedTask", async () => {
		throw new Error("Interrupted before create");
	});
	assert.equal((await f.post(f.op)).state, "pending");
	assert.equal(f.specs.length, 1);
	await f.restart();
	assert.equal((await f.post(f.op, true)).state, "pending");
	assert.equal((await f.post(f.op)).state, "pending");
	assert.equal((await f.read(f.missionId)).start.state, "unknown");
	assert.equal(f.sessions.list().length, 1);
});

test("Stop during durable reservation and unavailable model authority start no work", { timeout: 60000 }, async (t) => {
	const f = await published(t);
	const checkpoint = OperationJournal.prototype.checkpoint;
	t.mock.method(
		OperationJournal.prototype,
		"checkpoint",
		async function (this: OperationJournal, ...args: Parameters<typeof checkpoint>) {
			await checkpoint.apply(this, args);
			if (args[0].kind === "plan-start") await f.sessions.stop(f.owner);
		},
	);
	assert.equal((await f.post(f.op)).state, "rejected");
	assert.equal(f.store.planningWorkers.get(f.missionId)!.start, undefined);
	assert.equal(f.specs.length, 1);
	assert.equal((await f.read(f.missionId)).start.available, false);
});
