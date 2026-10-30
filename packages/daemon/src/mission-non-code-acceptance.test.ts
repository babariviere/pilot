import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import type { MissionClassification } from "@pilot/protocol";
import { type DeliveryObservation, deliveryDigest } from "./mission-delivery-evidence.ts";
import { type NonCodePolicyWrite, nonCodePolicyWrite } from "./mission-non-code-acceptance.ts";
import { MissionStore } from "./missions.ts";

const classification: MissionClassification = {
	version: 1,
	effort: "small",
	difficulty: "routine",
	risk: "low",
	uncertainty: "known",
	scope: "bounded",
	role: "explorer",
	deliveryKind: "research",
};
function gate() {
	let release!: () => void;
	const promise = new Promise<void>((done) => {
		release = done;
	});
	return { promise, release };
}
async function fixture(t: TestContext, file = ":memory:") {
	const store = new MissionStore(file);
	let closed = false,
		authorized = true,
		reads = 0,
		actorEpoch = 0;
	const close = () => {
		if (!closed) {
			store.close();
			closed = true;
		}
	};
	t.after(close);
	const { id } = store.create({ projectId: "p", title: "Policy", planningVersion: 1 });
	for (const s of ["lead", "worker", "other"]) store.join(s, id);
	store.update(id, { coordinatorSessionId: "lead" });
	const task = store.addTask(id, {
		title: "Report",
		sessionId: "worker",
		assignment: {
			version: 1,
			expectedRevision: 0,
			expectedDefinitionRevision: 0,
			intent: "Report",
			scope: "Bounded",
			criteria: ["Sources"],
			classification,
		},
	});
	store.writeBrief(id, "PRIVATE SOURCE", 0);
	const profileWrite = {
		version: 1,
		operationId: "profile",
		profileId: "design",
		expectedRevision: 0,
		definition: {
			version: 1,
			purpose: "Design review",
			rubric: "PRIVATE RUBRIC",
			applicableIntents: ["research"],
			modelSelection: { unavailable: "No executor" },
			reasoningEffort: null,
			timeLimitMs: null,
			outputInterpretation: { kind: "pass-fail", pass: "No findings", fail: "Findings" },
		},
	};
	const authorize = () => {
		if (!authorized) throw new Error("host project denied");
	};
	const profile = await store.saveReviewProfile(id, "lead", profileWrite, authorize);
	const host = {
		authorize,
		resolve: async (reference: DeliveryObservation["reference"]): Promise<DeliveryObservation> => {
			reads++;
			return { reference, sourceOwnerSessionId: null, sha256: deliveryDigest(reference), availability: "retained" };
		},
		validateSources: (_observations: DeliveryObservation[]) => {},
		actorFence: () => ({ actorEpoch }),
	};
	const request: NonCodePolicyWrite = {
		version: 1,
		operationId: "policy",
		expectedPolicyId: null,
		kind: "non-code",
		assignment: task.assignment!,
		ownerSessionId: "worker",
		definitionRevision: store.sharedDefinitionRevision(task.id),
		expectedContextFence: store.allocationContextFence(id),
		destinations: [{ kind: "brief", revision: 1 }],
		checks: [{ checkId: "diagram-validation", configVersion: "v1" }],
		reviews: [
			{
				kind: "independent-agent",
				profileId: "design",
				profileRevision: 1,
				scrutiny: "targeted",
				provenance: "host-proven-producer-and-independence",
			},
		],
		authorityClaim: null,
	};
	const save = (value: unknown = request, actor = "lead", overrides = {}) =>
		store.saveNonCodeAcceptancePolicy(id, task.id, actor, value, { ...host, ...overrides });
	const lookup = (value: unknown = request, actor = "lead") =>
		store.lookupNonCodeAcceptancePolicy(id, task.id, actor, value, authorize);
	const evaluate = (overrides = {}) => store.evaluateNonCodeAcceptance(id, task.id, "lead", { ...host, ...overrides });
	return {
		store,
		id,
		task,
		request,
		host,
		save,
		lookup,
		evaluate,
		profile,
		profileWrite,
		close,
		reads: () => reads,
		revoke: () => {
			authorized = false;
		},
		changeActorMetadata: () => {
			actorEpoch++;
		},
	};
}

test("strict full shape, identities, bounds, dense arrays and untrusted flags", async (t) => {
	const f = await fixture(t);
	for (const key of Object.keys(f.request)) {
		const v = { ...f.request } as Record<string, unknown>;
		delete v[key];
		assert.throws(() => nonCodePolicyWrite(v), key);
	}
	for (const key of ["actorSessionId", "approved", "force", "checksPassed", "human", "independent", "observations"])
		assert.throws(() => nonCodePolicyWrite({ ...f.request, [key]: true }));
	for (const kind of ["code", "mixed", "unknown", "research", "native-ui"])
		assert.throws(() => nonCodePolicyWrite({ ...f.request, kind }));
	for (const v of [
		null,
		[],
		{},
		{ ...f.request, version: 2 },
		{ ...f.request, operationId: "x".repeat(129) },
		{ ...f.request, operationId: "../source" },
		{ ...f.request, definitionRevision: Number.MAX_SAFE_INTEGER + 1 },
		{ ...f.request, definitionRevision: 0 },
		{ ...f.request, expectedPolicyId: undefined },
		{ ...f.request, expectedContextFence: { ...f.request.expectedContextFence, memberEventId: -1 } },
		{ ...f.request, expectedContextFence: { ...f.request.expectedContextFence, approved: true } },
	])
		assert.throws(() => nonCodePolicyWrite(v));
	for (const key of ["destinations", "checks", "reviews"] as const) {
		for (const value of [
			[],
			Array(1),
			Array.from({ length: 21 }, () => f.request[key][0]),
			[f.request[key][0], f.request[key][0]],
		])
			assert.throws(() => nonCodePolicyWrite({ ...f.request, [key]: value }));
	}
	for (const ref of [
		{ kind: "snapshot", snapshotId: "a".repeat(64) },
		{ kind: "url", url: "https://example.test" },
		{ kind: "artifact", artifactId: "a", revision: "latest" },
		{ kind: "path", path: "/source" },
		{ kind: "brief", revision: 0 },
		{ kind: "brief", revision: 1, source: "injected" },
	])
		assert.throws(() => nonCodePolicyWrite({ ...f.request, destinations: [ref] }));
	assert.throws(() =>
		nonCodePolicyWrite({
			...f.request,
			checks: [
				{ checkId: "same", configVersion: "a" },
				{ checkId: "same", configVersion: "b" },
			],
		}),
	);
	assert.throws(() =>
		nonCodePolicyWrite({
			...f.request,
			reviews: [f.request.reviews[0], { ...f.request.reviews[0], scrutiny: "full" }],
		}),
	);
	assert.throws(() => nonCodePolicyWrite({ ...f.request, reviews: [{ ...f.request.reviews[0], independent: true }] }));
	assert.throws(() =>
		nonCodePolicyWrite({
			...f.request,
			authorityClaim: { source: "message", decisionId: "d", decisionEventId: 0, sha256: "a".repeat(64) },
		}),
	);
	assert.throws(() =>
		nonCodePolicyWrite({
			...f.request,
			authorityClaim: { source: "mission-decision", decisionId: "d", decisionEventId: 0, sha256: "A".repeat(64) },
		}),
	);
	const parsed = nonCodePolicyWrite(f.request);
	f.request.checks[0]!.configVersion = "mutated";
	assert.equal(parsed.checks[0]!.configVersion, "v1");
});

test("classification is intent only; Balanced minimums and force OFF cannot be weakened", async (t) => {
	const f = await fixture(t);
	for (const c of [
		undefined,
		{ ...classification, deliveryKind: "code" },
		{ ...classification, deliveryKind: "native-ui" },
		{ ...classification, deliveryKind: "unknown" },
	])
		assert.throws(() =>
			nonCodePolicyWrite({ ...f.request, assignment: { ...f.request.assignment, classification: c } }),
		);
	const t2 = {
		...f.request,
		assignment: { ...f.request.assignment, classification: { ...classification, difficulty: "substantive" } },
	};
	assert.throws(() => nonCodePolicyWrite(t2), /Balanced/);
	assert.doesNotThrow(() => nonCodePolicyWrite({ ...t2, reviews: [{ ...f.request.reviews[0], scrutiny: "full" }] }));
	const t3 = {
		...f.request,
		assignment: { ...f.request.assignment, classification: { ...classification, uncertainty: "unknown" } },
	};
	assert.throws(
		() => nonCodePolicyWrite({ ...t3, reviews: [{ ...f.request.reviews[0], scrutiny: "specialist" }] }),
		/Balanced/,
	);
	assert.doesNotThrow(() =>
		nonCodePolicyWrite({
			...t3,
			reviews: [
				{ ...f.request.reviews[0], scrutiny: "specialist" },
				{ kind: "human", profileId: "human", profileRevision: 1, provenance: "trusted-human-origin" },
			],
		}),
	);
	assert.equal((await f.evaluate()).force, "off");
});

test("T3 human requirement remains unavailable, and maximum schemas retain Unicode bounds", async (t) => {
	const f = await fixture(t);
	const maximum = nonCodePolicyWrite({
		...f.request,
		operationId: "i".repeat(128),
		assignment: {
			...f.request.assignment,
			intent: "😀".repeat(1000),
			scope: "😀".repeat(4000),
			criteria: Array.from({ length: 20 }, () => "😀".repeat(1000)),
		},
		checks: Array.from({ length: 20 }, (_, i) => ({ checkId: `check-${i}`, configVersion: "v1" })),
		destinations: Array.from({ length: 20 }, (_, i) => ({ kind: "brief", revision: i + 1 })),
		reviews: Array.from({ length: 20 }, (_, i) => ({ ...f.request.reviews[0], profileId: `profile-${i}` })),
	});
	assert.equal(maximum.assignment.criteria.length, 20);
	assert.throws(() =>
		nonCodePolicyWrite({ ...maximum, assignment: { ...maximum.assignment, intent: "😀".repeat(1001) } }),
	);
	assert.throws(() =>
		nonCodePolicyWrite({ ...maximum, assignment: { ...maximum.assignment, scope: "😀".repeat(4001) } }),
	);
	const changed = f.store.updateTask(f.id, f.task.id, {
		assignment: {
			version: 1,
			expectedRevision: 1,
			expectedDefinitionRevision: f.store.sharedDefinitionRevision(f.task.id),
			intent: "Report",
			scope: "Bounded",
			criteria: ["Sources"],
			classification: { ...classification, risk: "unknown" },
		},
	});
	await f.save({
		...f.request,
		assignment: changed.assignment!,
		definitionRevision: f.store.sharedDefinitionRevision(f.task.id),
		reviews: [
			{ ...f.request.reviews[0], scrutiny: "specialist" },
			{ kind: "human", profileId: "design", profileRevision: 1, provenance: "trusted-human-origin" },
		],
	});
	const e = await f.evaluate();
	assert.equal(e.eligible, false);
	assert.equal(e.force, "off");
	assert.ok(e.requirements.some((r) => r.code === "trusted-human-origin-unavailable"));
});

test("policy append/history/CAS and explain never grant authority or change existing journals", async (t) => {
	const f = await fixture(t);
	const missing = await f.evaluate();
	assert.equal(missing.eligible, false);
	assert.ok(missing.requirements.some((r) => r.code === "check-requirements-missing"));
	const saved = await f.save();
	assert.equal(saved.authority.state, "unavailable");
	const e = await f.evaluate();
	assert.equal(e.eligible, false);
	assert.equal(e.policyApplicability, "current");
	assert.equal(e.inputs.policyId, saved.id);
	for (const code of [
		"authority-not-configured",
		"check-execution-and-config-unavailable",
		"review-result-missing",
		"review-producer-and-independence-unavailable",
		"code-free-inventory",
		"contribution-reconciliation",
		"live-source-freshness",
		"source-stability",
		"destination-observer",
		"finding-resolution",
		"executable-acceptance-seam",
	])
		assert.ok(
			e.requirements.some((r) => r.code === code),
			code,
		);
	assert.ok(!JSON.stringify(e).includes("PRIVATE"));
	const second = await f.save({ ...f.request, operationId: "second", expectedPolicyId: saved.id });
	assert.deepEqual(
		f.store.nonCodeAcceptancePolicyHistory(f.id, f.task.id).map((r) => r.id),
		[saved.id, second.id],
	);
	assert.deepEqual(f.store.nonCodeAcceptancePolicyHistory(f.id, f.task.id, second.id, 1), [saved]);
	assert.throws(() => f.store.nonCodeAcceptancePolicyHistory(f.id, f.task.id, "missing"));
	assert.throws(() => f.store.nonCodeAcceptancePolicyHistory(f.id, f.task.id, undefined, 101));
	await assert.rejects(f.save({ ...f.request, operationId: "stale" }), /revision conflict/);
	assert.equal(f.store.task(f.id, f.task.id).status, "todo");
	assert.equal(f.store.completion(f.id, f.task.id), undefined);
	assert.equal(f.store.nonCodeDelivery(f.id, f.task.id), undefined);
	assert.equal(f.store.retiredMember("worker"), false);
	assert.deepEqual(f.store.currentDeliveryEvidence(f.id, f.task.id), []);
	assert.equal(f.store.latestContributionAllocation(f.id, f.task.id), undefined);
	assert.deepEqual(f.store.reviewHistory(f.id, f.task.id), []);
});

test("matching decision digest and conservative event fence remain unavailable authority", async (t) => {
	const f = await fixture(t);
	const decision = f.store.addDecision(f.id, "PRIVATE DECISION", { sessionId: "lead" });
	const request = {
		...f.request,
		expectedContextFence: f.store.allocationContextFence(f.id),
		authorityClaim: {
			source: "mission-decision" as const,
			decisionId: decision.id,
			sha256: deliveryDigest(decision),
			decisionEventId: f.store.allocationContextFence(f.id).decisionEventId,
		},
	};
	const saved = await f.save(request);
	assert.equal(saved.authority.code, "trusted-approval-source-unavailable");
	assert.equal((await f.evaluate()).authority.code, "trusted-approval-source-unavailable");
	f.store.addDecision(f.id, "Unrelated", { sessionId: "lead" });
	assert.equal((await f.evaluate()).authority.code, "authority-reference-changed");
	assert.deepEqual(await f.lookup(request), saved);
	const missing = await f.save({
		...request,
		operationId: "missing-authority",
		expectedPolicyId: saved.id,
		expectedContextFence: f.store.allocationContextFence(f.id),
		authorityClaim: { ...request.authorityClaim, decisionId: "missing" },
	});
	assert.equal(missing.authority.code, "authority-reference-unavailable");
});

test("current actor admission precedes historical lookup, retry and absent lookup", async (t) => {
	const f = await fixture(t),
		saved = await f.save();
	await assert.rejects(f.save(f.request, "worker"), /coordinator/);
	await assert.rejects(f.lookup(f.request, "worker"), /coordinator/);
	f.store.update(f.id, { coordinatorSessionId: "other" });
	await assert.rejects(f.lookup(), /coordinator/);
	await assert.rejects(f.save(), /coordinator/);
	await assert.rejects(f.lookup({ ...f.request, operationId: "absent" }), /coordinator/);
	await assert.rejects(f.lookup(f.request, "other"), /idempotency/);
	f.store.update(f.id, { coordinatorSessionId: "lead" });
	assert.deepEqual(await f.lookup(), saved);
	f.revoke();
	await assert.rejects(f.lookup(), /host project denied/);
	await assert.rejects(f.save(), /host project denied/);
	await assert.rejects(f.evaluate(), /host project denied/);
});

for (const change of [
	"owner-aba",
	"owner-replaced",
	"assignment",
	"classification",
	"brief",
	"member-aba",
	"coordinator-aba",
	"profile",
	"pin",
] as const) {
	test(`${change}: old request retry is metadata recovery, new append refuses changed fences`, async (t) => {
		const f = await fixture(t),
			saved = await f.save();
		if (change.startsWith("owner")) {
			f.store.releaseTask(f.id, f.task.id);
			f.store.claimTask(f.id, f.task.id, change === "owner-aba" ? "worker" : "other", { sessionId: "lead" });
		}
		if (change === "assignment" || change === "classification")
			f.store.updateTask(f.id, f.task.id, {
				assignment: {
					version: 1,
					expectedRevision: 1,
					expectedDefinitionRevision: f.store.sharedDefinitionRevision(f.task.id),
					intent: change === "assignment" ? "New" : "Report",
					scope: "Bounded",
					criteria: ["Sources"],
					classification: { ...classification, effort: change === "classification" ? "large" : "small" },
				},
			});
		if (change === "brief" || change === "pin") f.store.writeBrief(f.id, "Changed", 1);
		if (change === "member-aba") {
			f.store.leave("other");
			f.store.join("other", f.id);
		}
		if (change === "coordinator-aba") {
			f.store.update(f.id, { coordinatorSessionId: "other" });
			f.store.update(f.id, { coordinatorSessionId: "lead" });
		}
		if (change === "profile")
			await f.store.saveReviewProfile(
				f.id,
				"lead",
				{ ...f.profileWrite, operationId: "new-profile", expectedRevision: 1 },
				f.host.authorize,
			);
		const reads = f.reads();
		assert.deepEqual(await f.save(), saved);
		assert.deepEqual(await f.lookup(), saved);
		assert.equal(f.reads(), reads, "retry must not re-resolve revoked content");
		await assert.rejects(
			f.save({ ...f.request, operationId: "new", expectedPolicyId: saved.id }),
			/stale|changed|profile|assignment/,
		);
		assert.notEqual((await f.evaluate()).policyApplicability, "current");
	});
}

for (const race of [
	"owner-aba",
	"classification",
	"member-aba",
	"coordinator-aba",
	"profile",
	"pin",
	"revocation",
] as const) {
	test(`${race} during reads is rechecked inside append transaction`, async (t) => {
		const f = await fixture(t);
		await assert.rejects(
			f.save(f.request, "lead", {
				resolve: async (ref: DeliveryObservation["reference"]) => {
					const observation = await f.host.resolve(ref);
					if (race === "owner-aba") {
						f.store.releaseTask(f.id, f.task.id);
						f.store.claimTask(f.id, f.task.id, "worker", { sessionId: "lead" });
					}
					if (race === "classification")
						f.store.updateTask(f.id, f.task.id, {
							assignment: {
								version: 1,
								expectedRevision: 1,
								expectedDefinitionRevision: f.store.sharedDefinitionRevision(f.task.id),
								intent: "Report",
								scope: "Bounded",
								criteria: ["Sources"],
								classification: { ...classification, effort: "large" },
							},
						});
					if (race === "member-aba") {
						f.store.leave("other");
						f.store.join("other", f.id);
					}
					if (race === "coordinator-aba") {
						f.store.update(f.id, { coordinatorSessionId: "other" });
						f.store.update(f.id, { coordinatorSessionId: "lead" });
					}
					if (race === "profile")
						await f.store.saveReviewProfile(
							f.id,
							"lead",
							{ ...f.profileWrite, operationId: "profile-race", expectedRevision: 1 },
							f.host.authorize,
						);
					if (race === "pin") f.store.writeBrief(f.id, "Changed", 1);
					if (race === "revocation") f.revoke();
					return observation;
				},
			}),
		);
		assert.deepEqual(f.store.nonCodeAcceptancePolicyHistory(f.id, f.task.id), []);
	});
}

test("requests are deep-owned across async resolution", async (t) => {
	const f = await fixture(t),
		mutable = structuredClone(f.request),
		entered = gate(),
		hold = gate();
	const pending = f.save(mutable, "lead", {
		resolve: async (r: DeliveryObservation["reference"]) => {
			entered.release();
			await hold.promise;
			return f.host.resolve(r);
		},
	});
	await entered.promise;
	mutable.operationId = "changed";
	mutable.assignment.criteria[0] = "changed";
	mutable.checks[0]!.configVersion = "changed";
	mutable.destinations[0]!.revision = 999;
	hold.release();
	assert.deepEqual((await pending).request, f.request);
});

test("full payload/task/actor conflicts, same-op concurrent dedup and competing latest-ID CAS", async (t) => {
	const f = await fixture(t),
		[a, b] = await Promise.all([f.save(), f.save()]);
	assert.deepEqual(a, b);
	for (const mutation of [
		{ checks: [{ checkId: "other", configVersion: "v1" }] },
		{ expectedPolicyId: a.id },
		{ authorityClaim: { source: "mission-decision", decisionId: "d", decisionEventId: 0, sha256: "a".repeat(64) } },
		{ reviews: [{ ...f.request.reviews[0], scrutiny: "full" }] },
	])
		await assert.rejects(f.save({ ...f.request, ...mutation }), /idempotency/);
	const other = f.store.addTask(f.id, { title: "Other" });
	await assert.rejects(
		f.store.lookupNonCodeAcceptancePolicy(f.id, other.id, "lead", f.request, f.host.authorize),
		/idempotency/,
	);
	const writers = await Promise.allSettled([
		f.save({ ...f.request, operationId: "writer-a", expectedPolicyId: a.id }),
		f.save({ ...f.request, operationId: "writer-b", expectedPolicyId: a.id }),
	]);
	assert.equal(writers.filter((r) => r.status === "fulfilled").length, 1);
	assert.equal(writers.filter((r) => r.status === "rejected").length, 1);
	assert.equal(f.store.nonCodeAcceptancePolicyHistory(f.id, f.task.id).length, 2);
});

test("absent lookup is not a reservation against a delayed append", async (t) => {
	const f = await fixture(t),
		entered = gate(),
		hold = gate();
	const pending = f.save(f.request, "lead", {
		resolve: async (r: DeliveryObservation["reference"]) => {
			entered.release();
			await hold.promise;
			return f.host.resolve(r);
		},
	});
	await entered.promise;
	assert.equal(await f.lookup(), undefined);
	hold.release();
	const saved = await pending;
	assert.deepEqual(await f.lookup(), saved);
});

test("write/retry/present/absent/explain await durable and reauthorize after it", async (t) => {
	const f = await fixture(t),
		durable = f.store.durable.bind(f.store);
	for (const operation of [
		() => f.save(),
		() => f.save(),
		() => f.lookup(),
		() => f.lookup({ ...f.request, operationId: "absent" }),
		() => f.evaluate(),
	]) {
		const entered = gate(),
			hold = gate();
		let ack = false;
		const mock = t.mock.method(f.store, "durable", async () => {
			entered.release();
			await hold.promise;
			await durable();
		});
		const pending = operation().then((r) => {
			ack = true;
			return r;
		});
		await entered.promise;
		assert.equal(ack, false);
		hold.release();
		await pending;
		mock.mock.restore();
	}
	for (const operation of [
		() => f.save(),
		() => f.lookup(),
		() => f.lookup({ ...f.request, operationId: "absent" }),
		() => f.evaluate(),
	]) {
		const mock = t.mock.method(f.store, "durable", async () => {
			await durable();
			f.store.update(f.id, { coordinatorSessionId: "other" });
		});
		await assert.rejects(operation(), /coordinator/);
		mock.mock.restore();
		f.store.update(f.id, { coordinatorSessionId: "lead" });
	}
});

test("lost ACK/reopen/exact recovery and persistent lookup failures never assert absence", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "non-code-policy-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const file = join(dir, "missions.sqlite"),
		f = await fixture(t, file),
		durable = f.store.durable.bind(f.store);
	const lost = t.mock.method(f.store, "durable", async () => {
		await durable();
		throw new Error("lost ACK");
	});
	await assert.rejects(f.save(), /lost ACK/);
	lost.mock.restore();
	const saved = f.store.latestNonCodeAcceptancePolicy(f.id, f.task.id)!;
	const disk = new DatabaseSync(file, { readOnly: true });
	assert.equal(disk.prepare("SELECT COUNT(*) n FROM task_non_code_acceptance_policies").get()!.n, 1);
	disk.close();
	f.close();
	const reopened = new MissionStore(file);
	t.after(() => reopened.close());
	const host = {
		...f.host,
		resolve: async () => {
			throw new Error("revoked source must not be read");
		},
	};
	assert.deepEqual(await reopened.saveNonCodeAcceptancePolicy(f.id, f.task.id, "lead", f.request, host), saved);
	assert.deepEqual(
		await reopened.lookupNonCodeAcceptancePolicy(f.id, f.task.id, "lead", f.request, host.authorize),
		saved,
	);
	const failed = t.mock.method(reopened, "durable", async () => {
		throw new Error("storage failure");
	});
	for (const request of [f.request, { ...f.request, operationId: "absent" }])
		await assert.rejects(
			reopened.lookupNonCodeAcceptancePolicy(f.id, f.task.id, "lead", request, host.authorize),
			/storage failure/,
		);
	await assert.rejects(
		reopened.saveNonCodeAcceptancePolicy(f.id, f.task.id, "lead", f.request, host),
		/storage failure/,
	);
	failed.mock.restore();
});

test("resolver failures and corrupt identities remain unavailable, no source leaks", async (t) => {
	const f = await fixture(t);
	for (const resolve of [
		async () => {
			throw new Error("SECRET SOURCE");
		},
		async (r: DeliveryObservation["reference"]) => ({ ...(await f.host.resolve(r)), sha256: "bad" }),
		async (r: DeliveryObservation["reference"]) => ({ ...(await f.host.resolve(r)), availability: "partial" }),
	])
		await assert.rejects(f.save(f.request, "lead", { resolve }));
	await f.save();
	const e = await f.evaluate({
		resolve: async () => {
			throw new Error("SECRET SOURCE");
		},
	});
	assert.equal(e.policyApplicability, "unavailable");
	assert.ok(!JSON.stringify(e).includes("SECRET"));
	assert.equal(e.eligible, false);
});

for (const point of ["reads", "durable"] as const) {
	test(`explain compares complete input tuple after ${point}, including late journal changes`, async (t) => {
		const f = await fixture(t);
		await f.save();
		const mutate = async () => {
			await f.store.submitDeliveryEvidence(
				f.id,
				f.task.id,
				"worker",
				{
					version: 1,
					operationId: "late-submission",
					expectedSubmissionId: null,
					definitionRevision: f.request.definitionRevision,
					assignment: f.request.assignment,
					kind: "research",
					claim: "Done",
					limitations: "Reported",
					evidence: f.request.destinations,
					coverage: [[0]],
				},
				f.host.resolve,
			);
		};
		let mock: ReturnType<typeof t.mock.method> | undefined;
		if (point === "durable") {
			const original = f.store.durable.bind(f.store);
			mock = t.mock.method(f.store, "durable", async () => {
				mock!.mock.restore();
				await original();
				await mutate();
			});
		}
		const e = await f.evaluate(
			point === "reads"
				? {
						resolve: async (r: DeliveryObservation["reference"]) => {
							const o = await f.host.resolve(r);
							await mutate();
							return o;
						},
					}
				: {},
		);
		mock?.mock.restore();
		assert.equal(e.policyApplicability, "outdated");
		assert.equal(e.eligible, false);
		assert.ok(e.changedInputs);
		assert.equal(e.changedInputs.before.submissionId, null);
		assert.ok(e.changedInputs.after.submissionId);
		assert.equal(e.inputs.submissionId, null);
	});
}

test("explain fences host actor metadata changes and profile/result latest IDs", async (t) => {
	const f = await fixture(t);
	await f.save();
	const changed = await f.evaluate({
		resolve: async (r: DeliveryObservation["reference"]) => {
			f.changeActorMetadata();
			await f.store.saveReviewProfile(
				f.id,
				"lead",
				{ ...f.profileWrite, operationId: "profile-new", expectedRevision: 1 },
				f.host.authorize,
			);
			return f.host.resolve(r);
		},
	});
	assert.equal(changed.policyApplicability, "outdated");
	assert.ok(changed.changedInputs);
	assert.notEqual(
		changed.changedInputs.before.reviews[0]!.profileRecordId,
		changed.changedInputs.after.reviews[0]!.profileRecordId,
	);
	assert.notDeepEqual(changed.changedInputs.actorMetadata.before, changed.changedInputs.actorMetadata.after);
});

test("legacy refusal does not activate completion, and old legacy receipt behavior remains", async (t) => {
	const f = await fixture(t),
		legacy = f.store.create({ projectId: "p", title: "Legacy" });
	f.store.join("legacy-lead", legacy.id);
	f.store.update(legacy.id, { coordinatorSessionId: "legacy-lead" });
	const task = f.store.addTask(legacy.id, { title: "Legacy", sessionId: "legacy-lead" });
	await assert.rejects(
		f.store.saveNonCodeAcceptancePolicy(legacy.id, task.id, "legacy-lead", f.request, f.host),
		/planningVersion/,
	);
	await assert.rejects(
		f.store.lookupNonCodeAcceptancePolicy(legacy.id, task.id, "legacy-lead", f.request, f.host.authorize),
		/planningVersion/,
	);
	await assert.rejects(
		f.store.evaluateNonCodeAcceptance(legacy.id, task.id, "legacy-lead", f.host),
		/planningVersion/,
	);
	f.store.completeTask(legacy.id, task.id, "legacy-lead", { commit: "a".repeat(40), checks: "Reported", issues: "" });
	assert.equal(f.store.task(legacy.id, task.id).status, "done");
	assert.deepEqual(f.store.nonCodeAcceptancePolicyHistory(legacy.id, task.id), []);
});

test("SQL append failure rolls back; a post-commit durability failure remains exactly recoverable", async (t) => {
	const f = await fixture(t);
	// biome-ignore lint/complexity/useLiteralKeys: Inject an actual SQL insertion failure at the private journal boundary.
	const run = f.store["run"].bind(f.store);
	const writer = f.store as unknown as { run: typeof run };
	const failure = t.mock.method(writer, "run", (...[sql, ...args]: Parameters<typeof run>) => {
		if (sql.startsWith("INSERT INTO task_non_code_acceptance_policies")) throw new Error("SQLite insert failed");
		return run(sql, ...args);
	});
	await assert.rejects(f.save(), /SQLite insert failed/);
	failure.mock.restore();
	assert.deepEqual(f.store.nonCodeAcceptancePolicyHistory(f.id, f.task.id), []);
	const durableFailure = t.mock.method(f.store, "durable", async () => {
		throw new Error("replica unavailable");
	});
	await assert.rejects(f.save(), /replica unavailable/);
	const record = f.store.latestNonCodeAcceptancePolicy(f.id, f.task.id)!;
	assert.ok(record);
	await assert.rejects(f.lookup(), /replica unavailable/);
	durableFailure.mock.restore();
	assert.deepEqual(await f.lookup(), record);
	assert.deepEqual(await f.save(), record);
});

for (const change of [
	"policy",
	"judgement",
	"allocation",
	"review-result",
	"owner-aba",
	"classification",
	"member-aba",
] as const) {
	test(`explain explicitly identifies ${change} tuple changes during durability`, async (t) => {
		const f = await fixture(t),
			policy = await f.save();
		const submission = await f.store.submitDeliveryEvidence(
			f.id,
			f.task.id,
			"worker",
			{
				version: 1,
				operationId: "before-submission",
				expectedSubmissionId: null,
				definitionRevision: f.request.definitionRevision,
				assignment: f.request.assignment,
				kind: "research",
				claim: "Done",
				limitations: "Reported",
				evidence: f.request.destinations,
				coverage: [[0]],
			},
			f.host.resolve,
		);
		const durable = f.store.durable.bind(f.store);
		const mock = t.mock.method(f.store, "durable", async () => {
			mock.mock.restore();
			await durable();
			if (change === "policy")
				await f.save({ ...f.request, operationId: "late-policy", expectedPolicyId: policy.id });
			if (change === "judgement")
				await f.store.judgeDeliveryEvidence(f.id, f.task.id, "lead", {
					version: 1,
					operationId: "late-judge",
					expectedJudgementId: null,
					submissionId: submission.id,
					decision: "approve",
					reason: "Reported",
				});
			if (change === "allocation")
				await f.store.recordContributionAllocation(
					f.id,
					f.task.id,
					"lead",
					{
						version: 1,
						operationId: "late-allocation",
						expectedAllocationId: null,
						action: "allocate",
						submissionId: submission.id,
						assignment: f.request.assignment,
						ownerSessionId: "worker",
						definitionRevision: f.request.definitionRevision,
						expectedContextFence: f.request.expectedContextFence,
						sources: submission.observations,
						reason: "Selected",
					},
					f.host,
				);
			if (change === "review-result")
				await f.store.recordReviewResult(
					f.id,
					f.task.id,
					"lead",
					{
						version: 1,
						operationId: "late-review",
						profileId: "design",
						profileRevision: 1,
						expectedResultId: null,
						assignment: f.request.assignment,
						definitionRevision: f.request.definitionRevision,
						expectedContextFence: f.store.reviewContextFence(f.id),
						intent: "research",
						content: f.request.destinations,
						context: [],
						preferences: { unavailable: "None" },
						output: { state: "completed", outcome: "pass", reason: "Reported" },
						findings: [],
						resolutions: [],
						limitations: "Unverified",
						confidence: "high",
					},
					{
						...f.host,
						observeProducer: async () => ({ kind: "unavailable", reason: "No provenance" }),
						validateCitations: async () => {},
					},
				);
			if (change === "owner-aba") {
				f.store.releaseTask(f.id, f.task.id);
				f.store.claimTask(f.id, f.task.id, "worker", { sessionId: "lead" });
			}
			if (change === "classification")
				f.store.updateTask(f.id, f.task.id, {
					assignment: {
						version: 1,
						expectedRevision: 1,
						expectedDefinitionRevision: f.store.sharedDefinitionRevision(f.task.id),
						intent: "Report",
						scope: "Bounded",
						criteria: ["Sources"],
						classification: { ...classification, deliveryKind: "code" },
					},
				});
			if (change === "member-aba") {
				f.store.leave("other");
				f.store.join("other", f.id);
			}
		});
		const e = await f.evaluate();
		assert.equal(e.eligible, false);
		assert.equal(e.policyApplicability, "outdated");
		assert.ok(e.changedInputs);
		assert.notDeepEqual(e.changedInputs.before, e.changedInputs.after);
		assert.deepEqual(e.inputs, e.changedInputs.before);
	});
}
