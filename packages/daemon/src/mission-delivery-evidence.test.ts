import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import type { DelegationGrant } from "@pilot/protocol";
import {
	type DeliveryJudgementWrite,
	type DeliveryObservation,
	type DeliveryResolver,
	type DeliverySubmissionWrite,
	deliveryDigest,
	deliverySubmissionWrite,
	evaluateDelivery,
} from "./mission-delivery-evidence.ts";
import { MissionStore } from "./missions.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function fixture(t: TestContext, file = ":memory:") {
	const store = new MissionStore(file);
	let closed = false;
	const close = () => {
		if (!closed) {
			closed = true;
			store.close();
		}
	};
	t.after(close);
	const { id } = store.create({ projectId: "p", title: "Evidence", planningVersion: 1 });
	for (const session of ["lead", "worker", "other"]) store.join(session, id);
	store.update(id, { coordinatorSessionId: "lead" });
	const task = store.addTask(id, {
		title: "Bounded work",
		sessionId: "worker",
		assignment: {
			version: 1,
			expectedRevision: 0,
			intent: "Explain the result",
			scope: "One bounded outcome",
			criteria: ["Outcome", "Limitations"],
		},
	});
	store.writeBrief(id, "Approved scope", 0);
	const request: DeliverySubmissionWrite = {
		version: 1,
		operationId: "submit",
		expectedSubmissionId: null,
		definitionRevision: store.sharedDefinitionRevision(task.id),
		assignment: task.assignment!,
		kind: "research",
		claim: "Sources compared",
		limitations: "Not independently reviewed",
		evidence: [{ kind: "brief", revision: 1 }],
		coverage: [[0], []],
	};
	const resolve: DeliveryResolver = async (reference) => ({
		reference,
		sourceOwnerSessionId: null,
		sha256: deliveryDigest(store.brief(id, 1)),
		availability: "retained",
	});
	const submit = (value: unknown = request, resolver = resolve, actor = "worker") =>
		store.submitDeliveryEvidence(id, task.id, actor, value, resolver);
	const judgement = (submissionId: string): DeliveryJudgementWrite => ({
		version: 1,
		operationId: "judge",
		submissionId,
		expectedJudgementId: null,
		decision: "approve",
		reason: "Useful outcome, subject to required gates",
	});
	const evaluate = (observations?: DeliveryObservation[]) =>
		evaluateDelivery(
			store.task(id, task.id),
			store.require(id).coordinatorSessionId,
			store.currentDeliveryEvidence(id, task.id),
			observations,
			store.sharedDefinitionRevision(task.id),
		);
	return { store, close, id, task, request, resolve, submit, judgement, evaluate };
}

for (const kind of ["code", "native-ui", "research"] as const) {
	test(`${kind} record fixtures separate claims, reference observations, judgement and integration`, async (t) => {
		const f = fixture(t);
		const record = await f.submit({ ...f.request, kind });
		assert.deepEqual(record.request.assignment, f.task.assignment);
		assert.equal(record.ownerSessionId, "worker");
		assert.equal(f.evaluate(record.observations).freshness.judgement, "unavailable");
		const approval = await f.store.judgeDeliveryEvidence(f.id, f.task.id, "lead", f.judgement(record.id));
		const evaluation = f.evaluate(record.observations);
		assert.equal(evaluation.judgement?.id, approval.id);
		assert.deepEqual(evaluation.freshness, { assignment: "current", evidence: "current", judgement: "current" });
		assert.deepEqual(evaluation.coverage, ["claimed", "missing"]);
		assert.ok(Object.values(evaluation.verification).every((value) => value === "unavailable"));
		assert.equal(evaluation.integration, "unavailable");
		assert.equal(evaluation.eligibility, "unavailable");
		assert.equal(f.store.task(f.id, f.task.id).status, "todo");
		assert.equal(f.store.retiredMember("worker"), false);
		assert.equal(f.store.completion(f.id, f.task.id), undefined);
		assert.equal(f.store.nonCodeDelivery(f.id, f.task.id), undefined);
		await assert.rejects(
			f.store.judgeDeliveryEvidence(f.id, f.task.id, "worker", {
				...f.judgement(record.id),
				operationId: "self-approve",
			}),
			/Only the coordinator/,
		);
	});
}

test("strict payloads reject claimed authority, passing gates, mutable references and invalid coverage", async (t) => {
	const f = fixture(t);
	for (const extra of [
		"actor",
		"sessionId",
		"role",
		"currentTask",
		"checks",
		"verification",
		"authority",
		"score",
		"observations",
		"reviewerProfile",
		"independent",
	])
		assert.throws(() => deliverySubmissionWrite({ ...f.request, [extra]: true }), /fields/);
	for (const bad of [
		{ version: 2 },
		{ definitionRevision: 0 },
		{ definitionRevision: "latest" },
		{ expectedSubmissionId: undefined },
		{ evidence: [] },
		{ coverage: [[0]] },
		{ coverage: [[0, 0], []] },
		{ coverage: [[1], []] },
		{ coverage: [[-1], []] },
		{ coverage: [[0.1], []] },
		{ coverage: new Array(2) },
		{ coverage: [new Array(1), []] },
		{ evidence: [f.request.evidence[0], f.request.evidence[0]] },
		{ evidence: [{ kind: "artifact", artifactId: "report" }] },
		{ evidence: [{ kind: "artifact", artifactId: "report", revision: "latest" }] },
		{ evidence: [{ kind: "url", url: "https://example.com" }] },
		{ evidence: [{ kind: "snapshot", snapshotId: "HEAD" }] },
		{ evidence: [{ kind: "brief", revision: 1, fresh: true }] },
		{ assignment: { ...f.request.assignment, version: 2 } },
	])
		assert.throws(() => deliverySubmissionWrite({ ...f.request, ...bad }));
	for (const field of ["intent", "scope", "criteria", "revision"]) {
		const assignment = {
			...f.request.assignment,
			[field]: field === "criteria" ? ["Weakened", "Limitations"] : field === "revision" ? 2 : "Altered",
		};
		await assert.rejects(f.submit({ ...f.request, assignment }), /stale or altered/);
	}
	await assert.rejects(f.submit(f.request, f.resolve, "other"), /owner or coordinator/);
	assert.equal(f.store.deliveryEvidence(f.id, f.task.id).length, 0);
});

test("coverage and request objects are copied before asynchronous resolution", async (t) => {
	const f = fixture(t),
		entered = deferred(),
		resume = deferred();
	const pending = f.submit(f.request, async (ref) => {
		entered.resolve();
		await resume.promise;
		return f.resolve(ref);
	});
	await entered.promise;
	f.request.coverage[0]!.push(99);
	f.request.assignment.criteria[0] = "Mutated caller data";
	resume.resolve();
	const record = await pending;
	assert.deepEqual(record.request.coverage, [[0], []]);
	assert.equal(record.request.assignment.criteria[0], "Outcome");
});

test("assignment/owner changes and pin revocation during host I/O reject admission", async (t) => {
	for (const change of ["assignment", "owner", "brief"] as const) {
		const f = fixture(t),
			entered = deferred(),
			resume = deferred();
		const pending = f.submit(f.request, async (ref) => {
			entered.resolve();
			await resume.promise;
			return f.resolve(ref);
		});
		await entered.promise;
		if (change === "assignment")
			f.store.updateTask(f.id, f.task.id, {
				assignment: {
					version: 1,
					expectedRevision: 1,
					intent: "New intent",
					scope: "New scope",
					criteria: ["New criterion"],
				},
			});
		if (change === "owner") f.store.updateTask(f.id, f.task.id, { sessionId: "other" });
		if (change === "brief") f.store.writeBrief(f.id, "New scope", 1);
		resume.resolve();
		await assert.rejects(pending, /stale|owner|changed/);
		assert.equal(f.store.deliveryEvidence(f.id, f.task.id).length, 0);
	}
});

test("concurrent exact requests converge, while operation and revision conflicts do not append", async (t) => {
	const f = fixture(t);
	const [a, b] = await Promise.all([f.submit(), f.submit()]);
	assert.deepEqual(a, b);
	assert.equal(f.store.deliveryEvidence(f.id, f.task.id).length, 1);
	await assert.rejects(f.submit({ ...f.request, claim: "Different" }), /idempotency conflict/);
	await assert.rejects(
		f.submit({ ...f.request, assignment: { ...f.request.assignment, criteria: ["Altered", "Limitations"] } }),
		/idempotency conflict/,
	);
	await assert.rejects(f.submit({ ...f.request, evidence: [{ kind: "brief", revision: 2 }] }), /idempotency conflict/);
	await assert.rejects(f.submit({ ...f.request, operationId: "new" }), /revision conflict/);
	await assert.rejects(f.submit(f.request, f.resolve, "lead"), /idempotency conflict/);
	const task2 = f.store.addTask(f.id, {
		title: "Other",
		sessionId: "worker",
		assignment: {
			version: 1,
			expectedRevision: 0,
			intent: "Other",
			scope: "Other",
			criteria: ["Other"],
		},
	});
	await assert.rejects(
		f.store.submitDeliveryEvidence(f.id, task2.id, "worker", f.request, f.resolve),
		/idempotency conflict/,
	);
	await assert.rejects(
		f.store.judgeDeliveryEvidence(f.id, f.task.id, "worker", {
			...f.judgement(a.id),
			operationId: f.request.operationId,
		}),
		/idempotency conflict/,
	);
});

test("submission, source and review supersession preserve history without carrying approval forward", async (t) => {
	const f = fixture(t),
		a = await f.submit();
	const approval = await f.store.judgeDeliveryEvidence(f.id, f.task.id, "lead", f.judgement(a.id));
	for (const availability of ["partial", "unavailable"] as const) {
		const current = f.evaluate([{ ...a.observations[0]!, availability }]);
		assert.notEqual(current.freshness.evidence, "current");
		assert.equal(current.freshness.judgement, "stale");
		assert.equal(current.eligibility, "unavailable");
	}
	assert.equal(f.evaluate([{ ...a.observations[0]!, sha256: "b".repeat(64) }]).freshness.evidence, "stale");
	assert.equal(f.evaluate().freshness.evidence, "unavailable");
	const b = await f.submit({ ...f.request, operationId: "new-source", expectedSubmissionId: a.id }, async (ref) => ({
		...(await f.resolve(ref)),
		sha256: "b".repeat(64),
	}));
	assert.equal(f.evaluate(b.observations).freshness.judgement, "stale");
	await assert.rejects(
		f.store.judgeDeliveryEvidence(f.id, f.task.id, "lead", {
			...f.judgement(a.id),
			operationId: "old-target",
			expectedJudgementId: approval.id,
		}),
		/stale submission/,
	);
	await assert.rejects(
		f.store.judgeDeliveryEvidence(f.id, f.task.id, "lead", {
			...f.judgement(b.id),
			operationId: "racing-review",
		}),
		/judgement revision conflict/,
	);
	await f.store.judgeDeliveryEvidence(f.id, f.task.id, "lead", {
		...f.judgement(b.id),
		operationId: "review2",
		expectedJudgementId: approval.id,
		decision: "request-changes",
	});
	assert.equal(f.evaluate(b.observations).judgement?.request.decision, "request-changes");
	assert.equal(f.store.deliveryEvidence(f.id, f.task.id)[1]?.id, approval.id);
	f.store.updateTask(f.id, f.task.id, {
		assignment: {
			version: 1,
			expectedRevision: 1,
			intent: "Changed intent",
			scope: "Changed scope",
			criteria: ["Changed criteria"],
		},
	});
	assert.equal(f.evaluate(b.observations).freshness.assignment, "stale");
	assert.equal(f.evaluate(b.observations).freshness.judgement, "stale");
	assert.deepEqual(f.store.deliveryEvidence(f.id, f.task.id)[0], a);
});

test("required failures, skipped checks and repeated green claims cannot become observed passing gates", async (t) => {
	const f = fixture(t);
	let previous: string | null = null;
	for (const claim of ["Unknown", "Failed", "Skipped", "Stale", "Unavailable", "100/100, repeated green runs"]) {
		const record = await f.submit({
			...f.request,
			operationId: `run-${claim.split(/\W/)[0]}`,
			claim,
			expectedSubmissionId: previous,
		});
		previous = record.id;
		assert.ok(Object.values(f.evaluate(record.observations).verification).every((value) => value === "unavailable"));
	}
});

test("lost ACK retries recover the exact durable record after reopen without mutable source access", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-evidence-"));
	const file = join(dir, "missions.sqlite"),
		f = fixture(t, file);
	const durable = f.store.durable.bind(f.store);
	const lost = t.mock.method(f.store, "durable", async () => {
		await durable();
		throw new Error("lost ACK");
	});
	await assert.rejects(f.submit(), /lost ACK/);
	lost.mock.restore();
	const original = f.store.deliveryEvidence(f.id, f.task.id)[0]!;
	const judgement = f.judgement(original.id);
	const approved = await f.store.judgeDeliveryEvidence(f.id, f.task.id, "lead", judgement);
	f.store.writeBrief(f.id, "Scope revised", 1);
	f.store.update(f.id, { coordinatorSessionId: "other" });
	await durable();
	const disk = new DatabaseSync(file, { readOnly: true });
	assert.equal(disk.prepare("SELECT count(*) AS n FROM task_delivery_evidence").get()?.n, 2);
	disk.close();
	f.close();
	const reopened = new MissionStore(file);
	t.after(async () => {
		reopened.close();
		await rm(dir, { recursive: true, force: true });
	});
	const neverRead: DeliveryResolver = async () => {
		throw new Error("source removed");
	};
	assert.deepEqual(await reopened.submitDeliveryEvidence(f.id, f.task.id, "worker", f.request, neverRead), original);
	assert.deepEqual(await reopened.judgeDeliveryEvidence(f.id, f.task.id, "lead", judgement), approved);
	await assert.rejects(
		reopened.submitDeliveryEvidence(f.id, f.task.id, "worker", { ...f.request, claim: "Changed" }, neverRead),
		/idempotency conflict/,
	);
	assert.equal(
		evaluateDelivery(
			reopened.task(f.id, f.task.id),
			"other",
			reopened.currentDeliveryEvidence(f.id, f.task.id),
			original.type === "submission" ? original.observations : undefined,
			reopened.sharedDefinitionRevision(f.task.id),
		).freshness.judgement,
		"stale",
	);
});

test("successful acknowledgements including retries wait for the durability barrier", async (t) => {
	const f = fixture(t),
		entered = deferred(),
		release = deferred();
	const barrier = t.mock.method(f.store, "durable", async () => {
		entered.resolve();
		await release.promise;
	});
	let acknowledged = false;
	const pending = f.submit().then((record) => {
		acknowledged = true;
		return record;
	});
	await entered.promise;
	assert.equal(acknowledged, false);
	release.resolve();
	const record = await pending;
	barrier.mock.restore();
	const enteredRetry = deferred(),
		releaseRetry = deferred();
	t.mock.method(f.store, "durable", async () => {
		enteredRetry.resolve();
		await releaseRetry.promise;
	});
	acknowledged = false;
	const retry = f.submit().then((value) => {
		acknowledged = true;
		return value;
	});
	await enteredRetry.promise;
	assert.equal(acknowledged, false);
	releaseRetry.resolve();
	assert.deepEqual(await retry, record);
});

test("history is bounded and pageable, with latest judgement independent of page size", async (t) => {
	const f = fixture(t),
		submission = await f.submit();
	let previous: string | null = null;
	for (let i = 0; i < 103; i++) {
		const record = await f.store.judgeDeliveryEvidence(f.id, f.task.id, "lead", {
			...f.judgement(submission.id),
			operationId: `review-${i}`,
			expectedJudgementId: previous,
		});
		previous = record.id;
	}
	const page = f.store.deliveryEvidence(f.id, f.task.id);
	assert.equal(page.length, 100);
	const earlier = f.store.deliveryEvidence(f.id, f.task.id, page[0]!.id);
	assert.equal(earlier.length, 4);
	assert.deepEqual(earlier[0], submission);
	assert.equal(f.store.currentDeliveryEvidence(f.id, f.task.id).length, 2);
	assert.equal(f.evaluate(submission.observations).judgement?.id, previous);
	assert.throws(() => f.store.deliveryEvidence(f.id, f.task.id, "unknown"), /cursor/);
	assert.throws(() => f.store.deliveryEvidence(f.id, f.task.id, undefined, 101), /limit/);
});

test("legacy missions remain inspectable but cannot adopt revision-bound evidence", async (t) => {
	const f = fixture(t),
		legacy = f.store.create({ projectId: "p", title: "Legacy" });
	f.store.join("worker", legacy.id);
	const task = f.store.addTask(legacy.id, { title: "Legacy", sessionId: "worker" });
	await assert.rejects(
		f.store.submitDeliveryEvidence(legacy.id, task.id, "worker", f.request, f.resolve),
		/planningVersion 1/,
	);
	const receipt = { commit: "a".repeat(40), checks: "Claimed green", issues: "" };
	assert.deepEqual(f.store.completeTask(legacy.id, task.id, "worker", receipt), receipt);
	assert.equal(f.store.deliveryEvidence(legacy.id, task.id).length, 0);
});

test("unavailable persistence never acknowledges a new record or an exact retry", async (t) => {
	const f = fixture(t);
	const failure = t.mock.method(f.store, "durable", async () => {
		throw new Error("disk unavailable");
	});
	await assert.rejects(f.submit(), /disk unavailable/);
	await assert.rejects(f.submit(), /disk unavailable/);
	const saved = f.store.deliveryEvidence(f.id, f.task.id)[0]!;
	assert.equal(f.store.deliveryEvidence(f.id, f.task.id).length, 1);
	const judge = f.judgement(saved.id);
	await assert.rejects(f.store.judgeDeliveryEvidence(f.id, f.task.id, "lead", judge), /disk unavailable/);
	await assert.rejects(f.store.judgeDeliveryEvidence(f.id, f.task.id, "lead", judge), /disk unavailable/);
	assert.equal(f.store.deliveryEvidence(f.id, f.task.id).length, 2);
	failure.mock.restore();
	assert.equal(
		(await f.store.judgeDeliveryEvidence(f.id, f.task.id, "lead", judge)).id,
		f.store.deliveryEvidence(f.id, f.task.id)[1]!.id,
	);
});

test("judgement acknowledgement waits for durability and changed decisions conflict on retry", async (t) => {
	const f = fixture(t),
		saved = await f.submit();
	const entered = deferred(),
		release = deferred();
	const barrier = t.mock.method(f.store, "durable", async () => {
		entered.resolve();
		await release.promise;
	});
	let acknowledged = false;
	const request = f.judgement(saved.id);
	const pending = f.store.judgeDeliveryEvidence(f.id, f.task.id, "lead", request).then((record) => {
		acknowledged = true;
		return record;
	});
	await entered.promise;
	assert.equal(acknowledged, false);
	release.resolve();
	const record = await pending;
	barrier.mock.restore();
	assert.deepEqual(await f.store.judgeDeliveryEvidence(f.id, f.task.id, "lead", request), record);
	await assert.rejects(
		f.store.judgeDeliveryEvidence(f.id, f.task.id, "lead", { ...request, decision: "reject" }),
		/idempotency conflict/,
	);
	await assert.rejects(
		f.store.judgeDeliveryEvidence(f.id, f.task.id, "worker", { ...request, actor: "lead" }),
		/fields/,
	);
});

test("reference identity mismatches and unsupported host observations do not append", async (t) => {
	const f = fixture(t);
	for (const change of [
		{ reference: { kind: "brief", revision: 2 } },
		{ sha256: "HEAD" },
		{ availability: "passed" },
	]) {
		const resolver = (async (ref) => ({ ...(await f.resolve(ref)), ...change })) as DeliveryResolver;
		await assert.rejects(f.submit(f.request, resolver), /identity mismatch/);
	}
	assert.equal(f.store.deliveryEvidence(f.id, f.task.id).length, 0);
});

test("coordinator self-judgement records intent but cannot supply independent review", async (t) => {
	const f = fixture(t);
	f.store.updateTask(f.id, f.task.id, { sessionId: "lead" });
	const saved = await f.submit(
		{ ...f.request, definitionRevision: f.store.sharedDefinitionRevision(f.task.id) },
		f.resolve,
		"lead",
	);
	await f.store.judgeDeliveryEvidence(f.id, f.task.id, "lead", f.judgement(saved.id));
	assert.equal(f.evaluate(saved.observations).verification.independentReview, "unavailable");
	assert.equal(f.evaluate(saved.observations).verification.authority, "unavailable");
});

test("release/reclaim ABA fences stale submissions and judgement despite unchanged owner and assignment", async (t) => {
	const f = fixture(t),
		saved = await f.submit();
	const judgement = f.judgement(saved.id);
	const approved = await f.store.judgeDeliveryEvidence(f.id, f.task.id, "lead", judgement);
	f.store.releaseTask(f.id, f.task.id);
	f.store.claimTask(f.id, f.task.id, "worker", { sessionId: "lead" });
	assert.equal(f.store.task(f.id, f.task.id).sessionId, saved.ownerSessionId);
	assert.deepEqual(f.store.task(f.id, f.task.id).assignment, saved.request.assignment);
	assert.ok(f.store.sharedDefinitionRevision(f.task.id) > saved.request.definitionRevision);
	assert.equal(f.evaluate(saved.observations).freshness.assignment, "stale");
	assert.equal(f.evaluate(saved.observations).freshness.judgement, "stale");
	await assert.rejects(
		f.submit({ ...f.request, operationId: "stale-aba", expectedSubmissionId: saved.id }),
		/definition revision is stale/,
	);
	await assert.rejects(
		f.store.judgeDeliveryEvidence(f.id, f.task.id, "lead", {
			...judgement,
			operationId: "stale-judge",
			expectedJudgementId: approved.id,
		}),
		/definition revision is stale/,
	);
	// An exact retry recovers history only; it does not make the old record current again.
	assert.deepEqual(await f.submit(), saved);
	assert.deepEqual(await f.store.judgeDeliveryEvidence(f.id, f.task.id, "lead", judgement), approved);
	assert.equal(f.evaluate(saved.observations).freshness.judgement, "stale");
	const fresh = await f.submit({
		...f.request,
		operationId: "fresh-aba",
		expectedSubmissionId: saved.id,
		definitionRevision: f.store.sharedDefinitionRevision(f.task.id),
	});
	assert.equal(f.evaluate(fresh.observations).freshness.judgement, "stale");
});

test("release/reclaim ABA during resolution is rejected by the existing definition fence", async (t) => {
	const f = fixture(t),
		entered = deferred(),
		resume = deferred();
	const pending = f.submit(f.request, async (ref) => {
		entered.resolve();
		await resume.promise;
		return f.resolve(ref);
	});
	await entered.promise;
	f.store.releaseTask(f.id, f.task.id);
	f.store.claimTask(f.id, f.task.id, "worker", { sessionId: "lead" });
	resume.resolve();
	await assert.rejects(pending, /definition revision is stale/);
	assert.equal(f.store.deliveryEvidence(f.id, f.task.id).length, 0);
});

test("worker and coordinator continuation preserve history without transferring current approval", async (t) => {
	const f = fixture(t),
		saved = await f.submit();
	const approval = await f.store.judgeDeliveryEvidence(f.id, f.task.id, "lead", f.judgement(saved.id));
	f.store.continueSession("lead", "new-lead");
	assert.equal(f.evaluate(saved.observations).freshness.judgement, "stale");
	const currentApproval = await f.store.judgeDeliveryEvidence(f.id, f.task.id, "new-lead", {
		...f.judgement(saved.id),
		operationId: "new-coordinator",
		expectedJudgementId: approval.id,
	});
	assert.equal(f.evaluate(saved.observations).freshness.judgement, "current");
	f.store.continueSession("worker", "successor");
	assert.equal(f.store.task(f.id, f.task.id).sessionId, "successor");
	assert.ok(f.store.sharedDefinitionRevision(f.task.id) > saved.request.definitionRevision);
	assert.equal(f.evaluate(saved.observations).freshness.judgement, "stale");
	assert.equal(f.store.deliveryEvidence(f.id, f.task.id)[1]!.actorSessionId, "lead");
	assert.equal(saved.ownerSessionId, "worker");
	await assert.rejects(
		f.store.judgeDeliveryEvidence(f.id, f.task.id, "new-lead", {
			...f.judgement(saved.id),
			operationId: "continued-old-source",
			expectedJudgementId: currentApproval.id,
		}),
		/definition revision is stale|owner is stale/,
	);
});

test("progress projections retain definition identity, while explicit task edits invalidate it", async (t) => {
	const f = fixture(t),
		saved = await f.submit();
	await f.store.judgeDeliveryEvidence(f.id, f.task.id, "lead", f.judgement(saved.id));
	const host = { hostId: "test", daemonId: "test", lineageId: "test" };
	// Exercise the retained projection helper only. No allocation is installed or activated.
	const grant: DelegationGrant = {
		delegationId: "fixture",
		task: { mission: { home: host, missionId: f.id }, taskId: f.task.id },
		executionEpoch: 1,
		bindingId: "fixture",
		bindingGeneration: 1,
		target: { host, projectId: "p" },
		session: { host, sessionId: "worker" },
		definitionRevision: saved.request.definitionRevision,
		context: { mission: 1, memory: 1 },
		manifestId: "fixture",
		references: [],
		request: { message: "fixture" },
		state: "accepted",
	};
	f.store.projectSharedProgress(grant, "blocked");
	assert.equal(f.store.sharedDefinitionRevision(f.task.id), saved.request.definitionRevision);
	assert.equal(f.evaluate(saved.observations).freshness.assignment, "current");
	assert.equal(f.evaluate(saved.observations).eligibility, "unavailable");
	f.store.updateTask(f.id, f.task.id, { body: "Material definition change" });
	assert.ok(f.store.sharedDefinitionRevision(f.task.id) > saved.request.definitionRevision);
	assert.equal(f.evaluate(saved.observations).freshness.judgement, "stale");
	f.store.projectSharedProgress(grant, "in_progress");
	assert.equal(f.store.task(f.id, f.task.id).status, "blocked", "a stale projection cannot make a definition current");
});
