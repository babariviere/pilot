import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { type DeliveryObservation, deliveryDigest, evaluateDelivery } from "./mission-delivery-evidence.ts";
import {
	assertReviewOutput,
	evaluateMissionReview,
	type MissionReviewResult,
	type ReviewProfileWrite,
	type ReviewResultWrite,
	reviewCitation,
	reviewProducer,
	reviewProfileDefinition,
	reviewProfileDiagnostics,
	reviewProfileWrite,
	reviewResultWrite,
	unavailableReviewProducer,
} from "./mission-review-contract.ts";
import { optionalReviewSeeds } from "./mission-review-seeds.ts";
import { MissionStore } from "./missions.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
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
	const { id } = store.create({ projectId: "p", title: "Review", planningVersion: 1 });
	for (const s of ["lead", "worker", "other"]) store.join(s, id);
	store.update(id, { coordinatorSessionId: "lead" });
	const task = store.addTask(id, {
		title: "Report",
		sessionId: "worker",
		assignment: {
			version: 1,
			expectedRevision: 0,
			intent: "Explain sources",
			scope: "Bounded report",
			criteria: ["Trace claims"],
		},
	});
	store.writeBrief(id, "Approved", 0);
	let authorized = true;
	const authorize = () => {
		if (!authorized) throw new Error("host project authorization denied");
	};
	const profile: ReviewProfileWrite = {
		version: 1,
		operationId: "profile",
		profileId: "correctness",
		expectedRevision: 0,
		definition: optionalReviewSeeds().correctness!,
	};
	await store.saveReviewProfile(id, "lead", profile, authorize);
	const request: ReviewResultWrite = {
		version: 1,
		operationId: "result",
		profileId: "correctness",
		profileRevision: 1,
		expectedResultId: null,
		definitionRevision: store.sharedDefinitionRevision(task.id),
		expectedContextFence: store.reviewContextFence(id),
		assignment: task.assignment!,
		intent: "research",
		content: [{ kind: "brief", revision: 1 }],
		context: [],
		preferences: { unavailable: "Scoped preference store not implemented" },
		output: { state: "completed", outcome: "pass", reason: "No evidenced concerns within stated report coverage" },
		findings: [],
		resolutions: [],
		limitations: "No execution, independent review or acceptance established",
		confidence: "unavailable",
	};
	const host = {
		authorize,
		resolve: async (reference: DeliveryObservation["reference"]): Promise<DeliveryObservation> => ({
			reference,
			sourceOwnerSessionId: reference.kind === "brief" ? null : "worker",
			sha256: deliveryDigest(reference),
			availability: "retained",
		}),
		observeProducer: async () => unavailableReviewProducer(),
		validateCitations: async () => {}, // Service validates retained text ranges; store never reads source paths.
	};
	const record = (value: unknown = request, actor = "worker", overrides = {}) =>
		store.recordReviewResult(id, task.id, actor, value, { ...host, ...overrides });
	const evaluate = (
		result: MissionReviewResult,
		observations: DeliveryObservation[] | undefined = result.observations,
	) =>
		evaluateMissionReview(result, {
			task: store.task(id, task.id),
			definitionRevision: store.sharedDefinitionRevision(task.id),
			profileRevision: store.reviewProfile(id, result.request.profileId)?.revision ?? 0,
			latestResultId: store.latestReviewResult(id, task.id, result.request.profileId)?.id ?? null,
			contextFence: store.reviewContextFence(id),
			observations,
		});
	return {
		store,
		id,
		task,
		profile,
		request,
		host,
		record,
		evaluate,
		close,
		revoke: () => {
			authorized = false;
		},
		authorize,
	};
}

test("optional seeds are isolated definitions with explicit missing configuration, not mandatory runs", async (t) => {
	const seeds = optionalReviewSeeds();
	assert.deepEqual(Object.keys(seeds), ["correctness", "security", "maintainability", "human-attention"]);
	for (const p of Object.values(seeds)) {
		assert.deepEqual(reviewProfileDefinition(p), p);
		assert.ok("unavailable" in p.modelSelection);
		assert.equal(p.reasoningEffort, null);
		assert.equal(p.timeLimitMs, null);
		assert.match(p.rubric, /net introduced or worsened/);
	}
	const slop = seeds.maintainability!.rubric;
	for (const phrase of [
		"implicit coupling",
		"layer-first",
		"duplication",
		"illegal states",
		"god files",
		"shotgun surgery",
		"layering violations",
		"pass-through wrappers",
		"validation away",
		"overly defensive",
		"legitimate adapters",
		"trust boundaries",
		"shared infrastructure",
		"independent rules",
		"I/O/durability recovery",
		"No line/file-count",
		"existing audit baseline",
	])
		assert.ok(slop.includes(phrase), phrase);
	seeds.correctness!.rubric = "changed copy";
	assert.notEqual(optionalReviewSeeds().correctness!.rubric, seeds.correctness!.rubric);
	const f = await fixture(t);
	assert.equal(f.store.reviewProfile(f.id, "security"), undefined);
	assert.deepEqual(f.store.reviewHistory(f.id, f.task.id), []);
});

for (const state of ["pending", "completed", "failed-to-run", "timed-out", "inconclusive"] as const) {
	test(`${state} is execution state, distinct from outcome and applicability`, async (t) => {
		const f = await fixture(t);
		const output =
			state === "completed"
				? { state, outcome: "fail" as const, reason: "Reported concerns" }
				: { state, reason: "Inspectable execution reason" };
		const saved = await f.record({ ...f.request, output });
		assert.deepEqual(saved.request.output, output);
		assert.equal(f.evaluate(saved).applicability, "current");
		assert.equal(f.evaluate(saved).liveSourceFreshness, "unavailable");
		assert.equal(f.evaluate(saved).eligibility, "unavailable");
		assert.equal(saved.independence, "unavailable");
		assert.equal(saved.humanAuthorship, "unavailable");
		assert.equal(saved.producer.kind, "unavailable");
		assert.equal(saved.recorderSessionId, "worker");
		assert.equal(f.store.task(f.id, f.task.id).status, "todo");
	});
}
test("versioned profiles interpret pass/fail or attention without gate or classification changes", async (t) => {
	const f = await fixture(t);
	const first = await f.record();
	const changed = {
		...f.profile,
		operationId: "attention-profile",
		expectedRevision: 1,
		definition: optionalReviewSeeds()["human-attention"]!,
	};
	const secondProfile = await f.store.saveReviewProfile(f.id, "lead", changed, f.authorize);
	assert.equal(secondProfile.revision, 2);
	assert.equal(
		f.store.reviewProfile(f.id, "correctness", 1)!.request.definition.outputInterpretation.kind,
		"pass-fail",
	);
	assert.equal(f.evaluate(first).applicability, "outdated");
	for (const outcome of ["low", "medium", "high"] as const) {
		const latest = f.store.latestReviewResult(f.id, f.task.id, "correctness")!;
		const result = await f.record({
			...f.request,
			operationId: outcome,
			profileRevision: 2,
			expectedResultId: latest.id,
			output: { state: "completed", outcome, reason: "Human judgement assessment, not a probability" },
		});
		assert.equal(f.evaluate(result).applicability, "current");
		assert.equal(f.evaluate(latest).applicability, "outdated");
	}
	await assert.rejects(f.record({ ...f.request, operationId: "old-profile" }), /profile superseded/);
	await assert.rejects(
		f.store.saveReviewProfile(f.id, "lead", { ...changed, operationId: "bad-cas" }, f.authorize),
		/revision conflict/,
	);
	assert.deepEqual(
		await f.store.saveReviewProfile(f.id, "lead", f.profile, f.authorize),
		f.store.reviewProfile(f.id, "correctness", 1),
	);
});
test("strict schemas reject unknown versions, invented proof and incompatible output variants", async (t) => {
	const f = await fixture(t);
	for (const key of [
		"actor",
		"producer",
		"model",
		"independent",
		"humanAuthorship",
		"role",
		"passing",
		"acceptance",
		"currentSource",
		"observations",
	])
		assert.throws(() => reviewResultWrite({ ...f.request, [key]: true }), /fields/);
	for (const change of [
		{ version: 2 },
		{ profileRevision: 0 },
		{ definitionRevision: 0 },
		{ confidence: 0.99 },
		{ output: { state: "outdated", reason: "history" } },
		{ output: { state: "timed-out", outcome: "pass", reason: "bad" } },
		{ content: [{ kind: "file", path: "/tmp/secret" }] },
		{ context: [{ kind: "artifact", artifactId: "a", revision: "latest" }] },
		{ preferences: { available: true } },
		{ expectedResultId: undefined },
		{ intent: "unknown" },
	])
		assert.throws(() => reviewResultWrite({ ...f.request, ...change }));
	for (const change of [
		{ version: 2 },
		{ reasoningEffort: "" },
		{ timeLimitMs: Infinity },
		{ timeLimitMs: 0 },
		{ applicableIntents: ["code", "code"] },
		{ modelSelection: { provider: "fixture" } },
		{ outputInterpretation: { kind: "pass-fail", pass: "yes" } },
	])
		assert.throws(() => reviewProfileDefinition({ ...f.profile.definition, ...change }));
	assert.throws(() => reviewProfileWrite({ ...f.profile, authority: true }), /fields/);
	assert.throws(() => reviewProducer({ kind: "observed-human", subjectId: "user" }), /fields|variant/);
	assert.throws(
		() =>
			assertReviewOutput(f.profile.definition, {
				...f.request,
				output: { state: "completed", outcome: "high", reason: "wrong schema" },
			}),
		/interpretation/,
	);
	assert.throws(() =>
		reviewCitation({
			kind: "code",
			snapshotId: "a".repeat(64),
			side: "after",
			path: "../secret",
			sha256: "b".repeat(64),
			start: 0,
			end: 1,
		}),
	);
});
test("non-code findings cite pinned content and keep baseline separate from introduced debt", async (t) => {
	const f = await fixture(t);
	const finding = {
		id: "f",
		title: "Untraceable claim",
		trigger: "Reader follows uncited conclusion",
		cost: "Reader cannot reproduce the conclusion",
		basis: "introduced",
		severity: "medium",
		evidence: [
			{
				kind: "content",
				reference: { kind: "brief", revision: 1 },
				explanation: "The cited conclusion has no supporting source",
			},
		],
		counterevidence: "No source in the retained report; external source coverage unknown",
	};
	const result = await f.record({
		...f.request,
		output: { state: "completed", outcome: "fail", reason: "Evidenced concern" },
		findings: [finding],
	});
	assert.equal(result.request.findings[0]!.evidence[0]!.kind, "content");
	assert.throws(
		() => assertReviewOutput(f.profile.definition, { ...result.request, output: f.request.output }),
		/Pass cannot hide/,
	);
	assert.doesNotThrow(() =>
		assertReviewOutput(f.profile.definition, {
			...result.request,
			output: f.request.output,
			findings: [{ ...result.request.findings[0]!, basis: "existing-baseline" }],
		}),
	);
	assert.throws(() => reviewResultWrite({ ...result.request, findings: [{ ...finding, cost: "" }] }), /text/);
	assert.throws(() => reviewResultWrite({ ...result.request, findings: [{ ...finding, evidence: [] }] }), /list/);
	assert.throws(
		() =>
			reviewResultWrite({
				...result.request,
				findings: [
					{
						...finding,
						evidence: [
							{ kind: "content", reference: { kind: "brief", revision: 2 }, explanation: "other source" },
						],
					},
				],
			}),
		/identity/,
	);
	await assert.rejects(
		f.record({
			...f.request,
			operationId: "resolve-no-proof",
			expectedResultId: result.id,
			resolutions: [
				{
					resultId: result.id,
					findingId: "f",
					assessment: "resolved",
					triggeringPathReason: "Line deleted",
					evidence: [],
				},
			],
		}),
		/list/,
	);
	const resolved = await f.record({
		...f.request,
		operationId: "resolve",
		expectedResultId: result.id,
		resolutions: [
			{
				resultId: result.id,
				findingId: "f",
				assessment: "resolved",
				triggeringPathReason: "The source is supplied elsewhere along the conclusion's retained evidence path",
				evidence: finding.evidence,
			},
		],
	});
	assert.equal(resolved.request.resolutions[0]!.assessment, "resolved");
	assert.equal(f.store.reviewResult(f.id, result.id)!.request.findings.length, 1);
	await assert.rejects(
		f.record({
			...f.request,
			operationId: "unknown-finding",
			expectedResultId: resolved.id,
			resolutions: [{ ...resolved.request.resolutions[0], findingId: "missing" }],
		}),
		/retained finding/,
	);
});
test("current trusted authorization precedes exact retry lookup and mutable reads", async (t) => {
	const f = await fixture(t);
	const saved = await f.record();
	await assert.rejects(f.record(f.request, "other"), /current coordinator or task owner/);
	await assert.rejects(f.store.saveReviewProfile(f.id, "worker", f.profile, f.authorize), /coordinator/);
	f.store.releaseTask(f.id, f.task.id);
	await assert.rejects(f.record(), /current coordinator or task owner/);
	f.store.claimTask(f.id, f.task.id, "worker", { sessionId: "lead" });
	assert.deepEqual(
		await f.record(f.request, "worker", {
			resolve: async () => {
				throw new Error("source gone");
			},
		}),
		saved,
	);
	f.revoke();
	const internal = f.store as unknown as { reviewRetry(...args: unknown[]): unknown };
	const lookup = t.mock.method(internal, "reviewRetry", () => {
		throw new Error("should not look up source");
	});
	await assert.rejects(f.record(), /host project authorization denied/);
	await assert.rejects(
		f.store.saveReviewProfile(f.id, "lead", f.profile, f.authorize),
		/host project authorization denied/,
	);
	assert.equal(lookup.mock.callCount(), 0);
});
test("exact retries conflict on changed payload, actor, task and action", async (t) => {
	const f = await fixture(t);
	const saved = await f.record();
	await assert.rejects(f.record({ ...f.request, limitations: "changed" }), /idempotency conflict/);
	await assert.rejects(f.record(f.request, "lead"), /idempotency conflict/);
	await assert.rejects(
		f.store.saveReviewProfile(f.id, "lead", { ...f.profile, operationId: f.request.operationId }, f.authorize),
		/idempotency conflict/,
	);
	const another = f.store.addTask(f.id, {
		title: "Other",
		sessionId: "worker",
		assignment: { version: 1, expectedRevision: 0, intent: "Other", scope: "Other", criteria: ["Other"] },
	});
	await assert.rejects(
		f.store.recordReviewResult(f.id, another.id, "worker", f.request, f.host),
		/idempotency conflict/,
	);
	assert.deepEqual(f.store.reviewHistory(f.id, f.task.id), [saved]);
});
test("source/context supersession and ownership ABA never resurrect old applicability", async (t) => {
	const f = await fixture(t),
		saved = await f.record();
	const altered = structuredClone(saved.observations);
	altered[0]!.sha256 = "c".repeat(64);
	assert.equal(f.evaluate(saved, altered).applicability, "outdated");
	assert.equal(
		evaluateMissionReview(saved, {
			task: f.task,
			definitionRevision: saved.request.definitionRevision,
			profileRevision: 1,
			latestResultId: saved.id,
			contextFence: saved.contextFence,
		}).applicability,
		"unavailable",
	);
	f.store.releaseTask(f.id, f.task.id);
	f.store.claimTask(f.id, f.task.id, "worker", { sessionId: "lead" });
	assert.equal(f.evaluate(saved).applicability, "outdated");
	await assert.rejects(
		f.record({ ...f.request, operationId: "aba", expectedResultId: saved.id }),
		/definition is stale/,
	);
	const fresh = await f.record({
		...f.request,
		operationId: "new-tenure",
		expectedResultId: saved.id,
		definitionRevision: f.store.sharedDefinitionRevision(f.task.id),
	});
	assert.equal(f.evaluate(fresh).applicability, "current");
	f.store.writeBrief(f.id, "Changed context", 1);
	assert.equal(f.evaluate(fresh).applicability, "outdated");
	assert.equal(f.store.reviewResult(f.id, saved.id)!.request.output.state, "completed");
});
test("artifact/context pin and custodian membership ABA invalidates even identical retained bytes", async (t) => {
	const f = await fixture(t);
	const ref = { kind: "artifact" as const, artifactId: "guidance", revision: 1 };
	const link = {
		artifactId: "guidance",
		sessionId: "other",
		title: "Guidance",
		kind: "html" as const,
		revision: 1,
		taskId: f.task.id,
	};
	f.store.linkArtifact(f.id, link);
	const host = {
		...f.host,
		resolve: async (r: DeliveryObservation["reference"]): Promise<DeliveryObservation> => ({
			reference: r,
			sourceOwnerSessionId: r.kind === "artifact" ? "other" : null,
			sha256: deliveryDigest(r),
			availability: "retained",
		}),
	};
	const first = await f.record(
		{
			...f.request,
			expectedContextFence: f.store.reviewContextFence(f.id),
			context: [ref],
			preferences: { references: [ref] },
		},
		"worker",
		host,
	);
	assert.equal(f.evaluate(first).applicability, "current");
	f.store.unlinkArtifact(f.id, "guidance", {}, f.task.id);
	f.store.linkArtifact(f.id, link);
	assert.equal(f.evaluate(first).applicability, "outdated");
	const second = await f.record(
		{
			...f.request,
			operationId: "same-bytes",
			expectedResultId: first.id,
			expectedContextFence: f.store.reviewContextFence(f.id),
			context: [ref],
		},
		"worker",
		host,
	);
	f.store.leave("other");
	f.store.join("other", f.id);
	assert.equal(f.evaluate(second).applicability, "outdated");
});
test("asynchronous reads recheck source/context ABA, assignment ABA, profile and trusted access", async (t) => {
	for (const change of ["assignment", "context", "profile", "authorization"] as const) {
		const f = await fixture(t),
			entered = deferred(),
			release = deferred();
		const pending = f.record(f.request, "worker", {
			resolve: async (ref: DeliveryObservation["reference"]) => {
				entered.resolve();
				await release.promise;
				return f.host.resolve(ref);
			},
		});
		await entered.promise;
		if (change === "assignment") {
			f.store.releaseTask(f.id, f.task.id);
			f.store.claimTask(f.id, f.task.id, "worker", { sessionId: "lead" });
		}
		if (change === "context") {
			f.store.join("new", f.id);
			f.store.leave("new");
		}
		if (change === "profile")
			await f.store.saveReviewProfile(
				f.id,
				"lead",
				{ ...f.profile, operationId: "edit", expectedRevision: 1 },
				f.authorize,
			);
		if (change === "authorization") f.revoke();
		release.resolve();
		await assert.rejects(pending, /stale|changed|superseded|authorization denied/);
		assert.deepEqual(f.store.reviewHistory(f.id, f.task.id), []);
	}
});
test("concurrent identical operations deduplicate; competing result revisions conflict", async (t) => {
	const f = await fixture(t);
	const [a, b] = await Promise.all([f.record(), f.record()]);
	assert.equal(a.id, b.id);
	const outcomes = await Promise.allSettled([
		f.record({ ...f.request, operationId: "next1", expectedResultId: a.id }),
		f.record({ ...f.request, operationId: "next2", expectedResultId: a.id }),
	]);
	assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
	assert.equal(f.store.reviewHistory(f.id, f.task.id).length, 2);
});
test("durable ACK and exact retry barriers, failed persistence and lost ACK reopen", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-review-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const file = join(dir, "missions.sqlite"),
		f = await fixture(t, file);
	const durable = f.store.durable.bind(f.store);
	const entered = deferred(),
		release = deferred();
	const barrier = t.mock.method(f.store, "durable", async () => {
		entered.resolve();
		await release.promise;
		await durable();
	});
	let acknowledged = false;
	const pending = f.record().then((r) => {
		acknowledged = true;
		return r;
	});
	await entered.promise;
	assert.equal(acknowledged, false);
	release.resolve();
	const saved = await pending;
	barrier.mock.restore();
	const lost = t.mock.method(f.store, "durable", async () => {
		await durable();
		throw new Error("lost ACK");
	});
	await assert.rejects(f.record(), /lost ACK/);
	await assert.rejects(f.store.saveReviewProfile(f.id, "lead", f.profile, f.authorize), /lost ACK/);
	lost.mock.restore();
	const disk = new DatabaseSync(file, { readOnly: true });
	assert.equal(disk.prepare("SELECT COUNT(*) n FROM mission_review_records").get()!.n, 2);
	disk.close();
	f.close();
	const reopened = new MissionStore(file);
	t.after(() => reopened.close());
	const host = {
		...f.host,
		resolve: async () => {
			throw new Error("source gone");
		},
	};
	assert.deepEqual(await reopened.recordReviewResult(f.id, f.task.id, "worker", f.request, host), saved);
	assert.equal(reopened.reviewProfile(f.id, "correctness")!.revision, 1);
	const blocked = t.mock.method(reopened, "durable", async () => {
		throw new Error("disk unavailable");
	});
	await assert.rejects(reopened.recordReviewResult(f.id, f.task.id, "worker", f.request, host), /disk unavailable/);
	blocked.mock.restore();
});
test("legacy completion and #18 evidence remain separate, with unavailable gates unchanged", async (t) => {
	const f = await fixture(t);
	await f.record();
	assert.deepEqual(f.store.deliveryEvidence(f.id, f.task.id), []);
	const submission = await f.store.submitDeliveryEvidence(
		f.id,
		f.task.id,
		"worker",
		{
			version: 1,
			operationId: "delivery",
			expectedSubmissionId: null,
			definitionRevision: f.request.definitionRevision,
			assignment: f.request.assignment,
			kind: "research",
			claim: "Report",
			limitations: "Unverified",
			evidence: f.request.content,
			coverage: [[0]],
		},
		f.host.resolve,
	);
	const delivery = evaluateDelivery(
		f.task,
		"lead",
		[submission],
		submission.observations,
		f.request.definitionRevision,
	);
	assert.equal(delivery.verification.independentReview, "unavailable");
	assert.equal(delivery.eligibility, "unavailable");
	assert.equal(f.store.completion(f.id, f.task.id), undefined);
	assert.equal(f.store.nonCodeDelivery(f.id, f.task.id), undefined);
	const legacy = f.store.create({ projectId: "p", title: "Legacy" });
	f.store.join("old", legacy.id);
	const task = f.store.addTask(legacy.id, { title: "Legacy", sessionId: "old" });
	await assert.rejects(f.store.recordReviewResult(legacy.id, task.id, "old", f.request, f.host), /planningVersion/);
	const receipt = { commit: "a".repeat(40), checks: "Claimed", issues: "" };
	assert.deepEqual(f.store.completeTask(legacy.id, task.id, "old", receipt), receipt);
	assert.equal(f.store.reviewHistory(legacy.id, task.id).length, 0);
});

test("profile writes and exact result retries both await the durability barrier", async (t) => {
	const f = await fixture(t),
		saved = await f.record();
	for (const action of [
		() => f.record(),
		() =>
			f.store.saveReviewProfile(
				f.id,
				"lead",
				{ ...f.profile, operationId: "profile-next", expectedRevision: 1 },
				f.authorize,
			),
	]) {
		const entered = deferred(),
			release = deferred();
		const barrier = t.mock.method(f.store, "durable", async () => {
			entered.resolve();
			await release.promise;
		});
		let acknowledged = false;
		const pending = action().then((record) => {
			acknowledged = true;
			return record;
		});
		await entered.promise;
		assert.equal(acknowledged, false);
		release.resolve();
		await pending;
		barrier.mock.restore();
	}
	assert.equal(f.store.reviewHistory(f.id, f.task.id).length, 1);
	assert.equal(f.evaluate(saved).applicability, "outdated");
});

test("history pagination preserves superseded records and indexed current results", async (t) => {
	const f = await fixture(t);
	let previous: string | null = null;
	for (let i = 0; i < 102; i++)
		previous = (await f.record({ ...f.request, operationId: `review-${i}`, expectedResultId: previous })).id;
	const page = f.store.reviewHistory(f.id, f.task.id);
	assert.equal(page.length, 100);
	assert.equal(f.store.reviewHistory(f.id, f.task.id, page[0]!.id).length, 2);
	assert.equal(f.store.latestReviewResult(f.id, f.task.id, "correctness")!.id, previous);
	assert.throws(() => f.store.reviewHistory(f.id, f.task.id, "missing"), /cursor/);
	assert.throws(() => f.store.reviewHistory(f.id, f.task.id, undefined, 101), /limit/);
});

test("native UI evidence uses retained artifact citations, not fabricated code citations", async (t) => {
	const f = await fixture(t);
	f.store.linkArtifact(f.id, {
		artifactId: "capture",
		sessionId: "worker",
		title: "Native capture fixture",
		kind: "html",
		revision: 1,
		taskId: f.task.id,
	});
	const reference = { kind: "artifact" as const, artifactId: "capture", revision: 1 };
	const saved = await f.record({
		...f.request,
		intent: "native-ui",
		content: [reference],
		expectedContextFence: f.store.reviewContextFence(f.id),
		output: { state: "completed", outcome: "fail", reason: "Capture shows obstructed control" },
		findings: [
			{
				id: "capture",
				title: "Control obscured",
				trigger: "Open sheet",
				cost: "User cannot reach confirmation",
				basis: "introduced",
				severity: "medium",
				evidence: [{ kind: "content", reference, explanation: "Pinned native capture fixture" }],
				counterevidence: "Interaction behavior is not established by a still image",
			},
		],
	});
	assert.equal(saved.request.intent, "native-ui");
	assert.equal(f.evaluate(saved).applicability, "current");
	assert.equal(f.evaluate(saved).acceptance, "unavailable");
	assert.throws(() => reviewResultWrite({ ...saved.request, intent: "code" }), /exact comparisons/);
});

test("stale context cannot be silently stamped onto newly recorded output", async (t) => {
	const f = await fixture(t);
	f.store.writeBrief(f.id, "New context", 1);
	await assert.rejects(f.record(), /context fence is stale/);
	assert.deepEqual(f.store.reviewHistory(f.id, f.task.id), []);
	for (const availability of ["partial", "unavailable"] as const) {
		const result = await f.record(
			{
				...f.request,
				operationId: availability,
				expectedContextFence: f.store.reviewContextFence(f.id),
				expectedResultId: f.store.latestReviewResult(f.id, f.task.id, "correctness")?.id ?? null,
				content: [{ kind: "snapshot", snapshotId: "a".repeat(64) }],
				intent: "code",
				output: { state: "completed", outcome: "pass", reason: "Claim within incomplete coverage" },
			},
			"worker",
			{
				resolve: async (reference: DeliveryObservation["reference"]): Promise<DeliveryObservation> => ({
					reference,
					sourceOwnerSessionId: "worker",
					sha256: "a".repeat(64),
					availability,
				}),
			},
		);
		assert.equal(f.evaluate(result).applicability, "unavailable");
		assert.equal(f.evaluate(result).eligibility, "unavailable");
	}
});
test("#4 catalog diagnostics never invent mappings, suitability or availability", async (t) => {
	const f = await fixture(t);
	const task = {
		...f.task,
		assignment: {
			...f.task.assignment!,
			classification: {
				version: 1 as const,
				effort: "medium" as const,
				difficulty: "routine" as const,
				risk: "low" as const,
				uncertainty: "known" as const,
				scope: "bounded" as const,
				role: "builder" as const,
				deliveryKind: "research" as const,
			},
		},
	};
	const definition = {
		...f.profile.definition,
		modelSelection: { provider: "fixture", model: "reviewer" },
		reasoningEffort: "high",
		timeLimitMs: 30000,
	};
	const allowed = {
		models: [{ id: "fixture/reviewer", provider: "fixture", name: "Synthetic", thinkingLevels: ["high"] }],
	};
	const context = { now: 100, assessments: [], availability: [] };
	const unassessed = reviewProfileDiagnostics(definition, task, allowed, context);
	assert.equal(unassessed.status, "unavailable");
	assert.equal(unassessed.recommendation!.candidates[0]!.suitability, "unassessed");
	assert.equal(unassessed.recommendation!.candidates[0]!.availability, "unknown");
	const configured = reviewProfileDiagnostics(definition, task, allowed, {
		now: 100,
		assessments: [
			{
				model: "fixture/reviewer",
				needs: ["bounded-work", "independent-review"],
				provenance: "Synthetic reviewer assessment",
				reason: "Targeted review only",
			},
		],
		availability: [
			{
				model: "fixture/reviewer",
				status: "available",
				source: "provider-observation",
				provenance: "Synthetic provider",
				observedAt: 90,
				expiresAt: 110,
			},
		],
	});
	assert.equal(configured.status, "configured");
	assert.equal(reviewProfileDiagnostics(definition, task, { models: [] }, context).status, "unavailable");
	assert.equal(
		reviewProfileDiagnostics({ ...definition, reasoningEffort: "unsupported" }, task, allowed, context).status,
		"unavailable",
	);
	assert.equal(task.assignment.classification.role, "builder");
});
