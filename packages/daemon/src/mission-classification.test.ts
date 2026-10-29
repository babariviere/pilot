import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { MissionAssignmentWrite, MissionClassification } from "@pilot/protocol";
import { classificationAdvice, classificationWrite } from "./mission-classification.ts";
import {
	type DeliverySubmissionWrite,
	deliveryAssignment,
	deliveryDigest,
	evaluateDelivery,
} from "./mission-delivery-evidence.ts";
import { MissionStore } from "./missions.ts";

const routine: MissionClassification = {
	version: 1,
	effort: "medium",
	difficulty: "routine",
	risk: "low",
	uncertainty: "known",
	scope: "bounded",
	role: "builder",
	deliveryKind: "code",
};
const assignment: MissionAssignmentWrite = {
	version: 1,
	expectedRevision: 0,
	intent: "Implement known behavior",
	scope: "One bounded module",
	criteria: ["Covered by tests"],
};
function fixture(t: TestContext, path = ":memory:") {
	const store = new MissionStore(path);
	t.after(() => store.close());
	const { id } = store.create({ projectId: "p", title: "Classification", planningVersion: 1 });
	for (const session of ["lead", "worker", "other"]) store.join(session, id);
	store.update(id, { coordinatorSessionId: "lead" });
	const task = store.addTask(id, { title: "Bounded task", sessionId: "worker", assignment });
	const write = (classification: MissionClassification | null = routine) => ({
		assignment: {
			...assignment,
			expectedRevision: store.task(id, task.id).assignment!.revision,
			expectedDefinitionRevision: store.sharedDefinitionRevision(task.id),
			classification,
		},
	});
	return { store, id, task, write };
}

test("Balanced tiers distinguish difficulty, risk and safety unknowns, not effort", () => {
	assert.equal(classificationAdvice(routine).tier, "T1");
	assert.equal(classificationAdvice({ ...routine, difficulty: "substantive" }).tier, "T2");
	assert.equal(classificationAdvice({ ...routine, risk: "medium" }).tier, "T2");
	for (const effort of ["small", "medium", "large", "unknown"] as const)
		assert.equal(classificationAdvice({ ...routine, effort }).tier, "T1");
	for (const change of [
		{ risk: "high" },
		{ risk: "unknown" },
		{ uncertainty: "unknown" },
		{ scope: "unknown" },
		{ difficulty: "hard" },
		{ difficulty: "unknown" },
	] as const) {
		const advice = classificationAdvice({ ...routine, ...change });
		assert.equal(advice.tier, "T3");
		assert.equal(advice.review, "specialist-and-human");
		assert.equal(advice.deliveryBaseline, "human-gate");
	}
	assert.equal(classificationAdvice(undefined).classification, null);
	assert.equal(classificationAdvice(undefined).tier, "T3");
	const expanded = classificationAdvice({ ...routine, scope: "expanded" });
	assert.equal(expanded.needsRescope, true);
	assert.equal(expanded.tier, "T3");
	assert.equal(expanded.advisoryOnly, true);
	const research = classificationAdvice({ ...routine, role: "explorer", deliveryKind: "research" });
	assert.equal(research.tier, "T1");
	assert.match(research.reasons.join(" "), /not proof of code-free/);
});

test("classification parser is exact, bounded and copied; future reads stay unknown", () => {
	assert.deepEqual(classificationWrite(routine), routine);
	assert.notEqual(classificationWrite(routine), routine);
	for (const invalid of [
		null,
		[],
		{},
		{ ...routine, version: 2 },
		{ ...routine, risk: "none" },
		{ ...routine, authority: true },
		{ ...routine, effort: undefined },
	])
		assert.throws(() => classificationWrite(invalid), /classification/);
	assert.equal(classificationAdvice({ ...routine, version: 2 } as never).classification, null);
});

test("only planners persist classification; both revisions reject stale and owner ABA writes", (t) => {
	const f = fixture(t);
	const first = f.write();
	assert.throws(() => f.store.updateTask(f.id, f.task.id, first, { sessionId: "worker" }), /Coordinator-owned/);
	const changed = f.store.updateTask(f.id, f.task.id, first, { sessionId: "lead" });
	assert.deepEqual(changed.assignment?.classification, routine);
	assert.equal(f.store.membership("worker")?.role, "builder", "classification intent is not a session capability");
	assert.ok(f.store.sharedDefinitionRevision(f.task.id) > first.assignment.expectedDefinitionRevision);
	assert.throws(() => f.store.updateTask(f.id, f.task.id, first), /Assignment revision conflict/);
	const stale = f.write(null);
	f.store.releaseTask(f.id, f.task.id);
	f.store.updateTask(f.id, f.task.id, { sessionId: "worker" });
	assert.equal(f.store.task(f.id, f.task.id).assignment?.revision, stale.assignment.expectedRevision);
	assert.throws(() => f.store.updateTask(f.id, f.task.id, stale), /Task definition revision conflict/);
	assert.deepEqual(f.store.task(f.id, f.task.id).assignment?.classification, routine);
	f.store.updateTask(f.id, f.task.id, f.write(null));
	assert.equal(f.store.task(f.id, f.task.id).assignment?.classification, undefined);
});

test("creation and explicit clearing require definition CAS; omissions preserve or invalidate honestly", (t) => {
	const f = fixture(t);
	for (const invalid of [
		{ ...assignment, expectedRevision: 1, classification: routine },
		{ ...assignment, expectedRevision: 1, classification: null },
		{ ...assignment, expectedRevision: 1, expectedDefinitionRevision: -1, classification: routine },
		{ ...assignment, expectedRevision: 1, expectedDefinitionRevision: 0, classification: routine },
	])
		assert.throws(
			() => f.store.updateTask(f.id, f.task.id, { assignment: invalid }),
			/expectedDefinitionRevision|definition revision/,
		);
	const created = f.store.addTask(f.id, {
		title: "Classified on creation",
		assignment: { ...assignment, expectedDefinitionRevision: 0, classification: routine },
	});
	assert.deepEqual(created.assignment?.classification, routine);
	f.store.updateTask(f.id, f.task.id, f.write());
	f.store.updateTask(f.id, f.task.id, { body: "Old client body patch" });
	const oldClient = { ...assignment, expectedRevision: 2 };
	const roundtrip = f.store.updateTask(f.id, f.task.id, { assignment: JSON.parse(JSON.stringify(oldClient)) });
	assert.deepEqual(roundtrip.assignment?.classification, routine);
	for (const change of [
		{ intent: "New intent" },
		{ scope: "Expanded assignment" },
		{ criteria: ["New acceptance"] },
	]) {
		f.store.updateTask(f.id, f.task.id, f.write());
		const current = f.store.task(f.id, f.task.id).assignment!;
		const result = f.store.updateTask(f.id, f.task.id, {
			assignment: { ...assignment, expectedRevision: current.revision, ...change },
		});
		assert.equal(result.assignment?.classification, undefined);
	}
	const legacy = f.store.create({ projectId: "p", title: "Legacy" });
	assert.throws(
		() =>
			f.store.addTask(legacy.id, {
				title: "No adoption",
				assignment: { ...assignment, expectedDefinitionRevision: 0, classification: routine },
			}),
		/requires planningVersion/,
	);
	assert.equal(f.task.assignment?.classification, undefined);
});

test("classification and unknown stored versions survive disk reads without invented defaults", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "classification-"));
	const path = join(root, "missions.sqlite");
	const f = fixture(t, path);
	f.store.updateTask(f.id, f.task.id, f.write());
	await f.store.durable();
	const reopened = new MissionStore(path);
	t.after(() => reopened.close());
	t.after(() => rmSync(root, { recursive: true, force: true }));
	assert.deepEqual(reopened.task(f.id, f.task.id).assignment?.classification, routine);
	const future = { ...reopened.task(f.id, f.task.id).assignment!, classification: { version: 9, future: "retained" } };
	reopened["run"]("UPDATE tasks SET assignment=? WHERE id=?", JSON.stringify(future), f.task.id);
	assert.deepEqual(reopened.task(f.id, f.task.id).assignment, future);
	assert.equal(classificationAdvice(reopened.task(f.id, f.task.id).assignment?.classification).classification, null);
	const oldClient = { ...assignment, expectedRevision: future.revision };
	reopened.updateTask(f.id, f.task.id, { assignment: oldClient });
	assert.deepEqual(
		reopened.task(f.id, f.task.id).assignment?.classification,
		future.classification,
		"unchanged old-client writes preserve unknown stored classification",
	);
	await reopened.durable();
});

test("classified #18 evidence freezes assessment and becomes stale after definition changes", async (t) => {
	const f = fixture(t);
	f.store.updateTask(f.id, f.task.id, f.write());
	f.store.writeBrief(f.id, "Immutable evidence", 0);
	const task = f.store.task(f.id, f.task.id);
	assert.deepEqual(deliveryAssignment(task.assignment), task.assignment);
	assert.throws(() => deliveryAssignment({ ...task.assignment, classification: null }), /classification/);
	const request: DeliverySubmissionWrite = {
		version: 1,
		operationId: "submit",
		expectedSubmissionId: null,
		definitionRevision: f.store.sharedDefinitionRevision(task.id),
		assignment: task.assignment!,
		kind: "research",
		claim: "Reported only",
		limitations: "No verification",
		evidence: [{ kind: "brief", revision: 1 }],
		coverage: [[0]],
	};
	const resolve = async (reference: DeliverySubmissionWrite["evidence"][number]) => ({
		reference,
		sourceOwnerSessionId: null,
		sha256: deliveryDigest("retained"),
		availability: "retained" as const,
	});
	const record = await f.store.submitDeliveryEvidence(f.id, task.id, "worker", request, resolve);
	const { classification: _classification, ...omitted } = request.assignment;
	await assert.rejects(
		f.store.submitDeliveryEvidence(
			f.id,
			task.id,
			"worker",
			{ ...request, operationId: "omitted", expectedSubmissionId: record.id, assignment: omitted },
			resolve,
		),
		/stale or altered/,
	);
	await f.store.judgeDeliveryEvidence(f.id, task.id, "lead", {
		version: 1,
		operationId: "judge",
		submissionId: record.id,
		expectedJudgementId: null,
		decision: "approve",
		reason: "Recorded, not completion",
	});
	const evaluate = () =>
		evaluateDelivery(
			f.store.task(f.id, task.id),
			"lead",
			f.store.currentDeliveryEvidence(f.id, task.id),
			record.observations,
			f.store.sharedDefinitionRevision(task.id),
		);
	assert.equal(evaluate().freshness.judgement, "current");
	assert.equal(evaluate().eligibility, "unavailable");
	f.store.updateTask(f.id, task.id, f.write({ ...routine, risk: "high" }));
	assert.equal(evaluate().freshness.assignment, "stale");
	assert.equal(evaluate().freshness.judgement, "stale");
	assert.deepEqual(record.request.assignment.classification, routine);
	assert.equal(
		(await f.store.submitDeliveryEvidence(f.id, task.id, "worker", request, resolve)).id,
		record.id,
		"lost ACK recovers the exact historical record, not fresh approval",
	);
	assert.equal(evaluate().freshness.judgement, "stale");
	assert.equal(f.store.task(f.id, task.id).status, "todo");
	assert.equal(f.store.retiredMember("worker"), false);
	assert.equal(f.store.completion(f.id, task.id), undefined);
});

test("classification race during async #18 evidence resolution cannot commit stale evidence", async (t) => {
	const f = fixture(t);
	f.store.updateTask(f.id, f.task.id, f.write());
	f.store.writeBrief(f.id, "Evidence", 0);
	let resume!: () => void;
	const wait = new Promise<void>((r) => {
		resume = r;
	});
	let entered!: () => void;
	const started = new Promise<void>((r) => {
		entered = r;
	});
	const task = f.store.task(f.id, f.task.id);
	const pending = f.store.submitDeliveryEvidence(
		f.id,
		task.id,
		"worker",
		{
			version: 1,
			operationId: "racing",
			expectedSubmissionId: null,
			definitionRevision: f.store.sharedDefinitionRevision(task.id),
			assignment: task.assignment!,
			kind: "research",
			claim: "Claim",
			limitations: "",
			evidence: [{ kind: "brief", revision: 1 }],
			coverage: [[0]],
		},
		async (reference) => {
			entered();
			await wait;
			return { reference, sourceOwnerSessionId: null, sha256: deliveryDigest("evidence"), availability: "retained" };
		},
	);
	await started;
	f.store.updateTask(f.id, task.id, f.write({ ...routine, scope: "expanded" }));
	resume();
	await assert.rejects(pending, /stale or altered/);
	assert.equal(f.store.deliveryEvidence(f.id, task.id).length, 0);
});
