import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import {
	allocationWrite,
	type ContributionAllocation,
	type ContributionAllocationWrite,
	evaluateContributionAllocation,
} from "./mission-contribution-allocation.ts";
import { type DeliveryObservation, deliveryDigest, latestSubmission } from "./mission-delivery-evidence.ts";
import { MissionStore } from "./missions.ts";

async function fixture(t: TestContext, file = ":memory:") {
	const store = new MissionStore(file);
	let closed = false;
	const close = () => {
		if (!closed) {
			store.close();
			closed = true;
		}
	};
	t.after(close);
	const { id } = store.create({ projectId: "p", title: "Allocation", planningVersion: 1 });
	for (const s of ["lead", "worker", "other"]) store.join(s, id);
	store.update(id, { coordinatorSessionId: "lead" });
	const task = store.addTask(id, {
		title: "Report",
		sessionId: "worker",
		assignment: { version: 1, expectedRevision: 0, intent: "Report", scope: "Bounded", criteria: ["Sources"] },
	});
	store.writeBrief(id, "Approved", 0);
	let authorized = true;
	const authorize = () => {
		if (!authorized) throw new Error("host project denied");
	};
	const resolve = async (reference: DeliveryObservation["reference"]): Promise<DeliveryObservation> => ({
		reference,
		sourceOwnerSessionId: reference.kind === "brief" ? null : "worker",
		sha256: deliveryDigest(reference),
		availability: "retained",
	});
	const host = { authorize, resolve, validateSources: (_observations: DeliveryObservation[]) => {} };
	const submissionRequest = {
		version: 1,
		operationId: "submission",
		expectedSubmissionId: null,
		definitionRevision: store.sharedDefinitionRevision(task.id),
		assignment: task.assignment!,
		kind: "research",
		claim: "Report",
		limitations: "Unverified",
		evidence: [{ kind: "brief", revision: 1 }],
		coverage: [[0]],
	};
	const submission = await store.submitDeliveryEvidence(id, task.id, "worker", submissionRequest, resolve);
	const request: ContributionAllocationWrite = {
		version: 1,
		operationId: "allocation",
		expectedAllocationId: null,
		action: "allocate",
		reason: "Scope for later assessment, not acceptance",
		submissionId: submission.id,
		assignment: task.assignment!,
		ownerSessionId: "worker",
		definitionRevision: store.sharedDefinitionRevision(task.id),
		expectedContextFence: store.allocationContextFence(id),
		sources: submission.observations,
	};
	const record = (value: unknown = request, actor = "lead", overrides = {}) =>
		store.recordContributionAllocation(id, task.id, actor, value, { ...host, ...overrides });
	const evaluate = (
		record: ContributionAllocation,
		observations: DeliveryObservation[] | undefined = request.sources,
	) =>
		evaluateContributionAllocation(record, {
			task: store.task(id, task.id),
			definitionRevision: store.sharedDefinitionRevision(task.id),
			coordinatorSessionId: store.require(id).coordinatorSessionId,
			contextFence: store.allocationContextFence(id),
			latestAllocationId: store.latestContributionAllocation(id, task.id)?.id ?? null,
			submission: latestSubmission(store.currentDeliveryEvidence(id, task.id)),
			observations,
		});
	return {
		store,
		id,
		task,
		host,
		authorize,
		request,
		submission,
		submissionRequest,
		record,
		evaluate,
		close,
		revoke: () => {
			authorized = false;
		},
	};
}

test("allocation is selected later scope, never historical purpose or a delivery gate", async (t) => {
	const f = await fixture(t),
		saved = await f.record();
	assert.equal(saved.historicalTaskAttribution, "unknown");
	assert.equal(saved.scopeCoverage, "selected-only");
	const result = f.evaluate(saved);
	assert.equal(result.applicability, "current");
	for (const key of [
		"checks",
		"independentReview",
		"authority",
		"liveSourceFreshness",
		"contributionCompleteness",
		"acceptance",
		"integration",
		"eligibility",
	] as const)
		assert.equal(result[key], "unavailable", key);
	assert.equal(f.store.task(f.id, f.task.id).status, "todo");
	assert.equal(f.store.completion(f.id, f.task.id), undefined);
	assert.equal(f.store.nonCodeDelivery(f.id, f.task.id), undefined);
	assert.deepEqual(f.store.currentDeliveryEvidence(f.id, f.task.id), [f.submission]);
	assert.deepEqual(f.store.reviewHistory(f.id, f.task.id), []);
	assert.equal(f.store.retiredMember("worker"), false);
});

test("strict fields reject actors, forged gates, URLs, live sources and invalid identities", async (t) => {
	const f = await fixture(t);
	for (const key of ["actorSessionId", "role", "checks", "approved", "taskAttribution", "exhaustive"])
		assert.throws(() => allocationWrite({ ...f.request, [key]: "lead" }));
	for (const reference of [
		{ kind: "url", url: "https://example.com" },
		{ kind: "snapshot", snapshotId: "latest" },
		{ kind: "artifact", artifactId: "a" },
		{ kind: "path", path: "/etc/passwd" },
	])
		assert.throws(() => allocationWrite({ ...f.request, sources: [{ ...f.request.sources[0], reference }] }));
	for (const availability of ["partial", "unavailable", "skipped", "failed"])
		assert.throws(() => allocationWrite({ ...f.request, sources: [{ ...f.request.sources[0], availability }] }));
	assert.throws(() => allocationWrite({ ...f.request, sources: [] }));
	assert.throws(() => allocationWrite({ ...f.request, sources: [f.request.sources[0], f.request.sources[0]] }));
	assert.throws(() =>
		allocationWrite({ ...f.request, expectedContextFence: { ...f.request.expectedContextFence, actor: "lead" } }),
	);
	assert.throws(() => allocationWrite({ ...f.request, definitionRevision: 0 }));
});

test("task, submission, worker and exact submitted source mismatches never allocate", async (t) => {
	const f = await fixture(t);
	for (const patch of [
		{ submissionId: "other-submission" },
		{ ownerSessionId: "other" },
		{ assignment: { ...f.request.assignment, scope: "Changed" } },
		{ sources: [{ ...f.request.sources[0], sha256: "e".repeat(64) }] },
		{ sources: [{ ...f.request.sources[0], sourceOwnerSessionId: "other" }] },
		{ sources: [{ ...f.request.sources[0], reference: { kind: "snapshot", snapshotId: "f".repeat(64) } }] },
	])
		await assert.rejects(f.record({ ...f.request, ...patch }));
	const another = f.store.addTask(f.id, {
		title: "Other",
		sessionId: "worker",
		assignment: { version: 1, expectedRevision: 0, intent: "Report", scope: "Bounded", criteria: ["Sources"] },
	});
	await assert.rejects(
		f.store.recordContributionAllocation(
			f.id,
			another.id,
			"lead",
			{ ...f.request, definitionRevision: f.store.sharedDefinitionRevision(another.id) },
			f.host,
		),
		/submission/,
	);
	const unrelated = f.store.create({ projectId: "other-project", title: "Unrelated", planningVersion: 1 });
	await assert.rejects(
		f.store.recordContributionAllocation(unrelated.id, f.task.id, "lead", f.request, f.host),
		/member|mission/i,
	);
	assert.deepEqual(f.store.contributionAllocationHistory(f.id, f.task.id), []);
});

test("code must select its own exact comparison, not an unselected snapshot or report", async (t) => {
	const f = await fixture(t);
	const snapshot = { kind: "snapshot" as const, snapshotId: "f".repeat(64) };
	const submission = await f.store.submitDeliveryEvidence(
		f.id,
		f.task.id,
		"worker",
		{
			...f.submissionRequest,
			operationId: "code",
			expectedSubmissionId: f.submission.id,
			kind: "code",
			evidence: [snapshot, ...f.submissionRequest.evidence],
			coverage: [[1]],
		},
		f.host.resolve,
	);
	const request = { ...f.request, submissionId: submission.id };
	await assert.rejects(f.record(request), /select.*comparison/);
	const selected = await f.record({ ...request, sources: [submission.observations[0]] });
	assert.equal(selected.scopeCoverage, "selected-only");
	assert.equal(selected.historicalTaskAttribution, "unknown");
	assert.equal(f.evaluate(selected, [submission.observations[0]!]).applicability, "current");
});

for (const change of [
	"assignment",
	"criteria",
	"owner-aba",
	"reassignment",
	"brief",
	"member-aba",
	"coordinator-aba",
	"continuation",
	"detach",
] as const) {
	test(`${change} invalidates history and rejects new allocation against old fences`, async (t) => {
		const f = await fixture(t),
			saved = await f.record();
		if (change === "assignment" || change === "criteria")
			f.store.updateTask(f.id, f.task.id, {
				assignment: {
					version: 1,
					expectedRevision: 1,
					intent: "Report",
					scope: change === "assignment" ? "New" : "Bounded",
					criteria: [change === "criteria" ? "New criteria" : "Sources"],
				},
			});
		if (change === "owner-aba" || change === "reassignment") {
			f.store.releaseTask(f.id, f.task.id);
			f.store.claimTask(f.id, f.task.id, change === "owner-aba" ? "worker" : "other", { sessionId: "lead" });
		}
		if (change === "brief") f.store.writeBrief(f.id, "Changed", 1);
		if (change === "member-aba") {
			f.store.leave("other");
			f.store.join("other", f.id);
		}
		if (change === "coordinator-aba") {
			f.store.update(f.id, { coordinatorSessionId: "other" });
			f.store.update(f.id, { coordinatorSessionId: "lead" });
		}
		if (change === "continuation") f.store.continueSession("worker", "successor");
		if (change === "detach") f.store.leave("worker");
		assert.notEqual(f.evaluate(saved).applicability, "current");
		await assert.rejects(
			f.record({ ...f.request, operationId: "new", expectedAllocationId: saved.id }),
			/stale|assignment|owner|definition|unowned/,
		);
		assert.deepEqual(await f.record(), saved, "exact retry recovers history, never renewed approval");
	});
}

for (const race of [
	"owner-aba",
	"assignment",
	"coordinator-aba",
	"member-aba",
	"context",
	"revocation",
	"submission",
] as const) {
	test(`${race} during retained reads is fenced before append`, async (t) => {
		const f = await fixture(t);
		await assert.rejects(
			f.record(f.request, "lead", {
				resolve: async (reference: DeliveryObservation["reference"]) => {
					const observed = await f.host.resolve(reference);
					if (race === "owner-aba") {
						f.store.releaseTask(f.id, f.task.id);
						f.store.claimTask(f.id, f.task.id, "worker", { sessionId: "lead" });
					}
					if (race === "assignment")
						f.store.updateTask(f.id, f.task.id, {
							assignment: {
								version: 1,
								expectedRevision: 1,
								intent: "New",
								scope: "Bounded",
								criteria: ["Sources"],
							},
						});
					if (race === "coordinator-aba") {
						f.store.update(f.id, { coordinatorSessionId: "other" });
						f.store.update(f.id, { coordinatorSessionId: "lead" });
					}
					if (race === "member-aba") {
						f.store.leave("other");
						f.store.join("other", f.id);
					}
					if (race === "context") f.store.writeBrief(f.id, "Changed", 1);
					if (race === "revocation") f.revoke();
					if (race === "submission")
						await f.store.submitDeliveryEvidence(
							f.id,
							f.task.id,
							"worker",
							{ ...f.submissionRequest, operationId: "new-source", expectedSubmissionId: f.submission.id },
							f.host.resolve,
						);
					return observed;
				},
			}),
		);
		assert.deepEqual(f.store.contributionAllocationHistory(f.id, f.task.id), []);
	});
}

test("missing/corrupt/partial retained refs and changed content stay unavailable without fallback", async (t) => {
	const f = await fixture(t);
	for (const overrides of [
		{
			resolve: async () => {
				throw new Error("missing/corrupt ref");
			},
		},
		{ resolve: async () => ({ ...f.request.sources[0], availability: "partial" }) },
		{ resolve: async () => ({ ...f.request.sources[0], sha256: "a".repeat(64) }) },
		{ resolve: async () => ({ ...f.request.sources[0], sourceOwnerSessionId: "other" }) },
	])
		await assert.rejects(f.record(f.request, "lead", overrides));
	const saved = await f.record();
	assert.equal(
		f.evaluate(saved, [{ ...f.request.sources[0]!, availability: "unavailable" }]).applicability,
		"unavailable",
	);
	assert.equal(f.evaluate(saved, [{ ...f.request.sources[0]!, sha256: "a".repeat(64) }]).applicability, "outdated");
});

test("supersession and withdrawal append with exact latest-ID CAS, never reactivating predecessors", async (t) => {
	const f = await fixture(t),
		first = await f.record();
	await assert.rejects(f.record({ ...f.request, operationId: "bad-cas" }), /revision conflict/);
	const second = await f.record({
		...f.request,
		operationId: "second",
		expectedAllocationId: first.id,
		reason: "Reassessed selected scope",
	});
	assert.equal(f.evaluate(first).applicability, "outdated");
	f.store.writeBrief(f.id, "New context", 1);
	const withdrawal = {
		version: 1,
		operationId: "withdraw",
		action: "withdraw",
		expectedAllocationId: second.id,
		reason: "Withdraw even after source/context changed",
	};
	const third = await f.record(withdrawal);
	assert.equal(f.evaluate(third).applicability, "outdated");
	assert.equal(f.evaluate(second).applicability, "outdated");
	assert.deepEqual(await f.record(withdrawal), third);
	await assert.rejects(
		f.record({ ...withdrawal, operationId: "again", expectedAllocationId: third.id }),
		/Only an allocation/,
	);
	assert.deepEqual(
		f.store.contributionAllocationHistory(f.id, f.task.id).map((r) => r.id),
		[first.id, second.id, third.id],
	);
	assert.deepEqual(f.store.contributionAllocationHistory(f.id, f.task.id, third.id, 1), [second]);
	assert.throws(() => f.store.contributionAllocationHistory(f.id, f.task.id, "unknown"));
	assert.throws(() => f.store.contributionAllocationHistory(f.id, f.task.id, undefined, 101));
});

test("current authorization precedes retry/lookup, with no former-coordinator privilege", async (t) => {
	const f = await fixture(t),
		saved = await f.record();
	await assert.rejects(f.record(f.request, "worker"), /coordinator/);
	f.store.update(f.id, { coordinatorSessionId: "other" });
	await assert.rejects(f.record(), /coordinator/);
	await assert.rejects(
		f.store.lookupContributionAllocation(f.id, f.task.id, "lead", f.request, f.authorize),
		/coordinator/,
	);
	await assert.rejects(f.record(f.request, "other"), /idempotency conflict/);
	f.store.update(f.id, { coordinatorSessionId: "lead" });
	assert.deepEqual(await f.store.lookupContributionAllocation(f.id, f.task.id, "lead", f.request, f.authorize), saved);
	f.revoke();
	await assert.rejects(f.record(), /host project denied/);
	await assert.rejects(
		f.store.lookupContributionAllocation(f.id, f.task.id, "lead", f.request, f.authorize),
		/host project denied/,
	);
});

test("exact operation conflicts cover changed task, action and payload; concurrent retries deduplicate", async (t) => {
	const f = await fixture(t);
	const [first, second] = await Promise.all([f.record(), f.record()]);
	assert.deepEqual(first, second);
	await assert.rejects(f.record({ ...f.request, reason: "Different" }), /idempotency conflict/);
	await assert.rejects(
		f.record({
			version: 1,
			operationId: f.request.operationId,
			action: "withdraw",
			expectedAllocationId: first.id,
			reason: "Changed action",
		}),
		/idempotency conflict/,
	);
	const other = f.store.addTask(f.id, { title: "Other" });
	await assert.rejects(
		f.store.lookupContributionAllocation(f.id, other.id, "lead", f.request, f.authorize),
		/idempotency conflict/,
	);
	assert.equal(
		await f.store.lookupContributionAllocation(
			f.id,
			f.task.id,
			"lead",
			{ ...f.request, operationId: "absent" },
			f.authorize,
		),
		undefined,
	);
	assert.equal(f.store.contributionAllocationHistory(f.id, f.task.id).length, 1);
});

test("writes, exact retries and present/absent lookup await durable; lost ACK reopens exact history", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "allocation-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const file = join(dir, "missions.sqlite"),
		f = await fixture(t, file);
	const durable = f.store.durable.bind(f.store);
	for (const operation of [
		() => f.record(),
		() => f.record(),
		() => f.store.lookupContributionAllocation(f.id, f.task.id, "lead", f.request, f.authorize),
		() =>
			f.store.lookupContributionAllocation(
				f.id,
				f.task.id,
				"lead",
				{ ...f.request, operationId: "absent" },
				f.authorize,
			),
	]) {
		let release!: () => void,
			entered!: () => void,
			acknowledged = false;
		const gate = new Promise<void>((done) => {
				release = done;
			}),
			start = new Promise<void>((done) => {
				entered = done;
			});
		const mock = t.mock.method(f.store, "durable", async () => {
			entered();
			await gate;
			await durable();
		});
		const pending = operation().then((r) => {
			acknowledged = true;
			return r;
		});
		await start;
		assert.equal(acknowledged, false);
		release();
		await pending;
		mock.mock.restore();
	}
	const saved = f.store.latestContributionAllocation(f.id, f.task.id)!;
	const lost = t.mock.method(f.store, "durable", async () => {
		await durable();
		throw new Error("lost ACK");
	});
	await assert.rejects(f.record(), /lost ACK/);
	lost.mock.restore();
	const disk = new DatabaseSync(file, { readOnly: true });
	assert.equal(disk.prepare("SELECT COUNT(*) n FROM task_contribution_allocations").get()!.n, 1);
	disk.close();
	f.close();
	const reopened = new MissionStore(file);
	t.after(() => reopened.close());
	assert.deepEqual(
		await reopened.recordContributionAllocation(f.id, f.task.id, "lead", f.request, {
			...f.host,
			resolve: async () => {
				throw new Error("source gone");
			},
		}),
		saved,
	);
	assert.deepEqual(
		await reopened.lookupContributionAllocation(f.id, f.task.id, "lead", f.request, f.authorize),
		saved,
	);
	const failed = t.mock.method(reopened, "durable", async () => {
		throw new Error("disk unavailable");
	});
	await assert.rejects(
		reopened.lookupContributionAllocation(f.id, f.task.id, "lead", f.request, f.authorize),
		/disk unavailable/,
	);
	await assert.rejects(
		reopened.recordContributionAllocation(f.id, f.task.id, "lead", f.request, f.host),
		/disk unavailable/,
	);
	failed.mock.restore();
});

test("new write lost ACK persists once; role revocation during durability denies returned result", async (t) => {
	const f = await fixture(t),
		durable = f.store.durable.bind(f.store);
	const lost = t.mock.method(f.store, "durable", async () => {
		await durable();
		throw new Error("lost ACK");
	});
	await assert.rejects(f.record(), /lost ACK/);
	lost.mock.restore();
	assert.equal(f.store.contributionAllocationHistory(f.id, f.task.id).length, 1);
	const saved = await f.record();
	const revoke = t.mock.method(f.store, "durable", async () => {
		await durable();
		f.store.update(f.id, { coordinatorSessionId: "other" });
	});
	await assert.rejects(
		f.store.lookupContributionAllocation(f.id, f.task.id, "lead", f.request, f.authorize),
		/coordinator/,
	);
	revoke.mock.restore();
	assert.equal(f.store.latestContributionAllocation(f.id, f.task.id)!.id, saved.id);
});

test("absent lookup is not an in-flight reservation; later exact append remains recoverable", async (t) => {
	const f = await fixture(t);
	let release!: () => void, entered!: () => void;
	const gate = new Promise<void>((done) => {
		release = done;
	});
	const start = new Promise<void>((done) => {
		entered = done;
	});
	const pending = f.record(f.request, "lead", {
		resolve: async (reference: DeliveryObservation["reference"]) => {
			entered();
			await gate;
			return f.host.resolve(reference);
		},
	});
	await start;
	assert.equal(await f.store.lookupContributionAllocation(f.id, f.task.id, "lead", f.request, f.authorize), undefined);
	release();
	const saved = await pending;
	assert.deepEqual(await f.store.lookupContributionAllocation(f.id, f.task.id, "lead", f.request, f.authorize), saved);
});

test("new concurrent allocation writers use latest-ID CAS, not last-write-wins", async (t) => {
	const f = await fixture(t);
	const results = await Promise.allSettled([f.record(), f.record({ ...f.request, operationId: "competing" })]);
	assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
	assert.equal(results.filter((r) => r.status === "rejected").length, 1);
	assert.equal(f.store.contributionAllocationHistory(f.id, f.task.id).length, 1);
});

test("legacy missions remain legacy; allocation cannot manufacture verified completion", async (t) => {
	const f = await fixture(t),
		legacy = f.store.create({ projectId: "p", title: "Legacy" });
	f.store.join("old", legacy.id);
	f.store.update(legacy.id, { coordinatorSessionId: "old" });
	const task = f.store.addTask(legacy.id, { title: "Legacy", sessionId: "old" });
	await assert.rejects(
		f.store.recordContributionAllocation(legacy.id, task.id, "old", f.request, f.host),
		/planningVersion/,
	);
	assert.deepEqual(f.store.contributionAllocationHistory(legacy.id, task.id), []);
});
