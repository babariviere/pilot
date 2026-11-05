import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import type { DurableOperation, ReviewerConsentDisclosure, WorkflowConfirmationPayload } from "@pilot/protocol";
import { openGates, reviewFixture } from "./critical-review.test-fixture.ts";
import { MissionStore } from "./missions.ts";
import { canonicalJSON, OperationJournal, payloadHash } from "./operation-journal.ts";
import { type InputDescriptor, prepareRetainedReviewInput } from "./retained-review-contract.ts";
import {
	retainedReviewLinkageDigest as digest,
	type RetainedReviewCallClaim,
	type RetainedReviewCompletionClaim,
	type RetainedReviewUsageClaim,
} from "./retained-review-linkage-contract.ts";
import type { RetainedRunAdmission, RetainedRunCompletion } from "./retained-review-run-disk.ts";
import { RetainedReviewRuns } from "./retained-review-runs.ts";
import { WorkflowConfirmations } from "./workflow-confirmations.ts";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
async function fixture(t: TestContext) {
	const f = await reviewFixture();
	const missionFile = join(f.home, "missions.sqlite");
	let missions = new MissionStore(missionFile);
	t.after(async () => {
		await missions.durable();
		missions.close();
		await f.close();
	});
	const m = missions.create({ projectId: "project", title: "Fake review only", brief: "Plan", planningVersion: 1 });
	missions.join("lead", m.id);
	missions.update(m.id, { coordinatorSessionId: "lead" });
	const origin = { hostId: "app", daemonId: "daemon", lineageId: "daemon-lineage" };
	const journal = new OperationJournal(join(f.home, "operations"), origin);
	let authorized = true,
		logicalTaskId: string | null = "logical-task",
		sends = 0;
	let config: ReviewerConsentDisclosure = {
		configurationRevision: "config",
		provider: "fake",
		model: "fake",
		account: "fake-account",
		terms: "Offline fixture, no transmission",
		dataScope: "exact-local-research-plan-revisions",
		retention: "raw-30-days-records-90-days-active-pins-excepted",
		expiresAt: Date.now() + 86_400_000,
		missionLimitMicros: 20_000_000,
		logicalTaskLimitMicros: 4_000_000,
		cumulativeAcrossRechecks: true,
		refillOnReplacement: false,
		paidFallback: false,
	};
	const confirmations = () =>
		new WorkflowConfirmations({
			store: missions,
			journal,
			authorize: () => {
				if (!authorized) throw new Error("Access revoked");
				return "fake-config";
			},
			consentConfiguration: () => config,
		});
	async function confirm(purpose: WorkflowConfirmationPayload["purpose"]) {
		const prepared = await confirmations().prepare(m.id, purpose);
		const payload = JSON.stringify({ purpose, ...prepared });
		const op: DurableOperation = {
			schemaVersion: 1,
			operationId: randomUUID(),
			producerId: randomUUID(),
			sequence: 1,
			origin,
			destination: origin,
			kind: purpose,
			targetId: m.id,
			payload,
			payloadHash: payloadHash(payload),
		};
		assert.equal(
			(await journal.execute(op, (op, entry) => confirmations().admit(op, entry.firstEntry))).state,
			"accepted",
		);
	}
	await confirm("workflow-approve");
	await confirm("review-consent");
	const rawApi = () =>
		new RetainedReviewRuns(f.store, missions, confirmations(), {
			hostId: "host",
			authorizeRun: () => {
				if (!authorized) throw new Error("Access revoked");
			},
			authorize: (target) => {
				if (
					!authorized ||
					target.missionId !== m.id ||
					target.projectId !== "project" ||
					target.coordinatorSessionId !== "lead"
				)
					throw new Error("Access/fence changed");
			},
			logicalTask: () => {
				if (!logicalTaskId) throw new Error("Accounting mapping unresolved");
				return logicalTaskId;
			},
			reopen: async (descriptor) => {
				const exact = await f.vault.readExact({
					manifestId: descriptor.manifest.id,
					manifestSha256: descriptor.manifest.sha256,
					blobs: descriptor.content.map((c) => ({
						blobId: c.blobId,
						sha256: c.originalSha256,
						length: c.originalBytes,
					})),
				});
				return prepareRetainedReviewInput(
					descriptor,
					exact.blobs.map(({ blobId, bytes }) => ({ blobId, bytes })),
				);
			},
		});
	const api = () => {
		const service = rawApi();
		return {
			admit: service.admit.bind(service),
			reserve: service.reserve.bind(service),
			claimSend: service.claimSend.bind(service),
			project: service.project.bind(service),
			revoke: service.revoke.bind(service),
			observeCall: (v: RetainedReviewCallClaim, channel = `${v.runId}-channel`) => service.observeCall(v, channel),
			usage: (v: RetainedReviewUsageClaim, channel = `${v.runId}-channel`) => service.usage(v, channel),
			complete: (v: RetainedReviewCompletionClaim, raw: Uint8Array | null, channel = `${v.runId}-channel`) =>
				service.complete(v, raw, channel),
			exited: (runId: string, observation: string, channel = `${runId}-channel`) =>
				service.exited(runId, observation, channel),
		};
	};
	async function admission(runId = "run", taskId = "task"): Promise<RetainedRunAdmission> {
		const entry = f.manifest.entries[0]!;
		const d: InputDescriptor = {
			version: 1,
			hostId: "host",
			daemonLineageId: "daemon-lineage",
			projectId: "project",
			missionId: m.id,
			taskId,
			runId,
			ownerSessionId: "worker",
			coordinatorSessionId: "lead",
			policyId: "policy",
			submissionId: "submission",
			allocationId: "allocation",
			definitionRevision: 1,
			assignment: {
				version: 1,
				revision: 1,
				intent: "Research",
				scope: "Plan",
				criteria: ["Accurate"],
				classification: {
					version: 1,
					effort: "small",
					difficulty: "routine",
					risk: "low",
					uncertainty: "known",
					scope: "bounded",
					role: "builder",
					deliveryKind: "research",
				},
			},
			contextFence: {
				briefRevision: 1,
				decisionEventId: 0,
				artifactEventId: 0,
				memberEventId: 0,
				coordinatorEventId: 0,
			},
			contextPackageSha256: sha("context"),
			profile: {
				profileId: "profile",
				revision: 1,
				definition: {
					version: 1,
					purpose: "Research",
					rubric: "Accuracy",
					applicableIntents: ["research"],
					modelSelection: { provider: "fake", model: "fake" },
					reasoningEffort: null,
					timeLimitMs: 1000,
					outputInterpretation: { kind: "pass-fail", pass: "No issues", fail: "Issues" },
				},
			},
			runtime: {
				buildSha256: sha("build"),
				configSha256: sha("config"),
				provider: "fake",
				model: "fake",
				promptVersion: "v1",
				toolSchemaVersion: "v1",
				outputSchemaVersion: 1,
			},
			manifest: f.manifest,
			content: [
				{
					reference: { kind: "brief", revision: 1 },
					part: "brief",
					artifactKind: null,
					referenceSha256: sha("reference"),
					sourceOwnerSessionId: null,
					blobId: entry.blobId,
					originalSha256: entry.sha256,
					originalBytes: entry.bytes,
				},
			],
		};
		const exact = await f.vault.readExact({
			manifestId: f.manifest.id,
			manifestSha256: f.manifest.sha256,
			blobs: [{ blobId: entry.blobId, sha256: entry.sha256, length: entry.bytes }],
		});
		const input = prepareRetainedReviewInput(
			d,
			exact.blobs.map(({ blobId, bytes }) => ({ blobId, bytes })),
		);
		const target = {
			version: 1 as const,
			kind: "retained-non-code" as const,
			targetId: `${runId}-target`,
			hostId: d.hostId,
			daemonLineageId: d.daemonLineageId,
			projectId: d.projectId,
			missionId: m.id,
			taskId,
			ownerSessionId: d.ownerSessionId,
			coordinatorSessionId: d.coordinatorSessionId,
			policyId: d.policyId,
			submissionId: d.submissionId,
			allocationId: d.allocationId,
			definitionRevision: 1,
			assignment: d.assignment,
			contextFence: d.contextFence,
			inputSha256: input.inputSha256,
			profileSha256: input.profileSha256,
			contextSha256: input.contextSha256,
			runtimeSha256: input.runtimeSha256,
			manifestId: f.manifest.id,
			manifestSha256: f.manifest.sha256,
			profileId: d.profile.profileId,
			profileRevision: 1,
			contextPackageSha256: d.contextPackageSha256,
		};
		return {
			version: 1,
			target,
			input,
			logicalTaskId: logicalTaskId!,
			effort: "medium",
			consent: (await confirmations().current(m.id, true)).record!,
			binding: {
				version: 1,
				kind: "retained-run-binding",
				runId,
				targetId: target.targetId,
				targetSha256: digest("target", target),
				admissionId: `${runId}-admission`,
				lineageId: `${runId}-lineage`,
				evidenceId: f.manifest.id,
				contextId: "context",
				configObservationId: "config",
				channelGeneration: `${runId}-channel`,
				inputSha256: input.inputSha256,
				profileSha256: input.profileSha256,
				contextSha256: input.contextSha256,
				runtimeSha256: input.runtimeSha256,
				provider: "fake",
				model: "fake",
				account: {
					kind: "claimed",
					bindingId: "fake-account",
					billing: "api",
					configSha256: d.runtime.configSha256,
				},
				authorLineage: { kind: "unknown" },
			},
		};
	}
	const request = (a: RetainedRunAdmission, callId = `${a.binding.runId}-call`, generatedTokens = 1000) =>
		f.request(a.binding.runId, callId, { approvalId: a.binding.admissionId, generatedTokens });
	const call = (a: RetainedRunAdmission, callId = `${a.binding.runId}-call`): RetainedReviewCallClaim => ({
		version: 1,
		kind: "retained-call",
		observationId: `${callId}-stop`,
		runId: a.binding.runId,
		callId,
		bindingSha256: digest("binding", a.binding),
		stop: { kind: "observed", source: "synthetic", exactReason: "stop\n\u0000é" },
	});
	const completion = (a: RetainedRunAdmission): RetainedReviewCompletionClaim => ({
		version: 1,
		kind: "retained-completion",
		completionId: `${a.binding.runId}-completion`,
		runId: a.binding.runId,
		bindingSha256: digest("binding", a.binding),
		terminalCallId: `${a.binding.runId}-call`,
		hostTermination: { kind: "unknown" },
		raw: { kind: "unknown" },
		usageAtCompletion: { kind: "unknown" },
	});
	const usage = (a: RetainedRunAdmission): RetainedReviewUsageClaim => ({
		version: 1,
		kind: "retained-usage",
		observationId: `${a.binding.runId}-usage`,
		runId: a.binding.runId,
		callId: `${a.binding.runId}-call`,
		bindingSha256: digest("binding", a.binding),
		receiptSource: "synthetic",
		receiptIdentity: `${a.binding.runId}-receipt`,
		rateSha256: sha(canonicalJSON(f.rate)),
		billing: "api",
		input: 1,
		generated: 1,
		durationMs: 1,
	});
	async function send(a: RetainedRunAdmission, generatedTokens = 1000) {
		await api().admit(a, openGates);
		await api().reserve(request(a, undefined, generatedTokens));
		await api().claimSend(a.binding.runId, `${a.binding.runId}-call`, openGates);
		sends++; // Isolated fake provider. No runtime/auth/provider SDK is imported.
		await api().observeCall(call(a));
	}
	return {
		f,
		api,
		admission,
		request,
		call,
		completion,
		usage,
		send,
		confirm,
		get sends() {
			return sends;
		},
		get missions() {
			return missions;
		},
		get config() {
			return config;
		},
		set config(v) {
			config = v;
		},
		set authorized(v: boolean) {
			authorized = v;
		},
		set logicalTaskId(v: string | null) {
			logicalTaskId = v;
		},
		restart: async () => {
			await missions.durable();
			missions.close();
			missions = new MissionStore(missionFile);
			await f.restart();
		},
	};
}

test("real-ledger fake send binds current consent, exact target/input/account; duplicate and conflicting callbacks", async (t) => {
	const f = await fixture(t),
		a = await f.admission();
	await f.send(a);
	await assert.rejects(f.api().claimSend("run", "run-call", openGates), /replay/);
	assert.equal(f.sends, 1);
	const raw = Buffer.from("\uFEFForiginal raw report\n");
	const c: RetainedReviewCompletionClaim = {
		...f.completion(a),
		raw: { kind: "bytes", bytesRef: "report", sha256: sha(raw), length: raw.length },
	};
	await f.api().complete(c, raw);
	await f.api().complete(c, raw);
	const exact = await f.f.store.rpc<RetainedRunCompletion>("retainedCompletion", { runId: "run" });
	assert.deepEqual(Buffer.from(exact.rawBase64!, "base64"), raw);
	await f.api().usage(f.usage(a));
	await f.api().usage(f.usage(a));
	assert.deepEqual(await f.f.store.rpc("retainedCompletion", { runId: "run" }), exact);
	const projection = await f.api().project("run", "projection");
	assert.deepEqual(await f.api().project("run", "projection"), projection);
	assert.equal(projection.producer.rawSha256, sha(raw));
	assert.equal(projection.target.taskId, a.target.taskId);
	assert.equal(projection.consentOperationId, a.consent.operationId);
	await assert.rejects(f.api().project("run", "another-operation"), /conflict/);
	await assert.rejects(f.api().complete({ ...c, completionId: "other" }, raw), /conflict/);
	await assert.rejects(f.api().project("run", "projection"), /quarantined/);
	assert.equal(f.sends, 1);
});

test("crash after claim never replays send; unknown usage and physical capacity survive restart", async (t) => {
	const f = await fixture(t),
		a = await f.admission();
	await f.send(a);
	await f.restart();
	await assert.rejects(f.api().claimSend("run", "run-call", openGates), /replay|closed/);
	await assert.rejects(f.api().admit(a, openGates), /closed/);
	const b = await f.admission("recheck");
	await assert.rejects(f.api().admit(b, openGates), /Physical/);
	await f.api().usage(f.usage(a)); // Late exact receipt reconciles, without dispatch.
	await f.api().exited("run", "joined-old-executor");
	await f.api().exited("run", "joined-old-executor");
	await assert.rejects(f.api().exited("run", "different-exit"), /conflict/);
	await f.api().admit(b, openGates);
	await assert.rejects(f.api().complete(f.completion(a), null), /closed/);
	assert.equal(f.sends, 1);
});

test("late usage append survives a crash before settlement; conflicting/corroborating receipts never refund twice", async (t) => {
	const f = await fixture(t),
		a = await f.admission();
	await f.send(a);
	await f.api().complete(f.completion(a), null);
	const usage = f.usage(a);
	await f.f.store.rpc("retainedObserve", {
		kind: "usage",
		value: usage,
		channelGeneration: a.binding.channelGeneration,
	}); // Crash point between stores/steps.
	await f.restart();
	await f.api().usage(usage);
	await f.api().usage({ ...usage, observationId: "corroboration", receiptIdentity: "second-receipt" });
	await assert.rejects(
		f.api().usage({ ...usage, observationId: "conflicting", receiptIdentity: "third", generated: 0 }),
		/conflict/,
	);
	await assert.rejects(f.api().project("run", "projection"), /quarantined/);
	assert.equal(f.sends, 1);
});

test("quarantined usage replay cannot settle an append-only receipt or refund conservative usage", async (t) => {
	const f = await fixture(t),
		a = await f.admission();
	await f.send(a);
	await f.api().complete(f.completion(a), null);
	const ledger = () => {
		const db = new DatabaseSync(f.f.file, { readOnly: true });
		try {
			return {
				...db
					.prepare(`SELECT c.state,c.money,c.input,c.generated,c.duration,r.conflict
			 FROM review_calls c JOIN review_retained_runs r ON r.run_id=c.run_id WHERE c.call_id=?`)
					.get("run-call"),
			};
		} finally {
			db.close();
		}
	};
	const conservative = ledger();
	assert.equal(conservative.state, "uncertain");
	assert.equal(conservative.money, 6000);
	const u1 = f.usage(a);
	await f.f.store.rpc("retainedObserve", { kind: "usage", value: u1, channelGeneration: a.binding.channelGeneration });
	assert.deepEqual(ledger(), conservative); // U1 is durable, but its settlement has not entered.
	await assert.rejects(
		f.api().usage({ ...u1, observationId: "conflicting-u2", receiptIdentity: "u2", generated: 0 }),
		/conflict/,
	);
	const quarantined = { ...conservative, conflict: 1 };
	assert.deepEqual(ledger(), quarantined);
	await assert.rejects(f.api().usage(u1), /quarantined/);
	assert.deepEqual(ledger(), quarantined);
	await assert.rejects(f.api().observeCall(f.call(a)), /quarantined/);
	await assert.rejects(f.api().complete(f.completion(a), null), /quarantined/);
	assert.deepEqual(ledger(), quarantined);
	await f.restart();
	assert.deepEqual(ledger(), quarantined); // Recovery must not settle the saved U1 either.
	await assert.rejects(f.api().usage(u1), /quarantined/);
	assert.deepEqual(ledger(), quarantined);
	assert.equal(f.sends, 1);
});

test("late valid usage still settles identically after revocation without sending again", async (t) => {
	const f = await fixture(t),
		a = await f.admission();
	await f.send(a);
	await f.api().revoke("run");
	const usage = f.usage(a);
	await f.api().usage(usage);
	await f.api().usage(usage);
	const db = new DatabaseSync(f.f.file, { readOnly: true });
	try {
		assert.deepEqual(
			{
				...db
					.prepare("SELECT state,money,input,generated,duration FROM review_calls WHERE call_id=?")
					.get("run-call"),
			},
			{ state: "settled", money: 6, input: 1, generated: 1, duration: 1 },
		);
	} finally {
		db.close();
	}
	await assert.rejects(f.api().claimSend("run", "run-call", openGates), /replay|closed/);
	assert.equal(f.sends, 1);
});

test("cumulative task total spans targets/rechecks/replacement aliases/renewed consent and uncertain usage", async (t) => {
	const f = await fixture(t);
	await f.f.accounting.verifyRate({ ...f.f.rate, id: "costly", generatedMicrosPerMillion: 1_000_000_000 });
	const a = await f.admission();
	await f.api().admit(a, openGates);
	await f.api().reserve({ ...f.request(a, "run-call", 3000), rateId: "costly" });
	await f.api().claimSend("run", "run-call", openGates);
	await f.api().observeCall(f.call(a));
	await f.api().complete(f.completion(a), null);
	await f.api().exited("run", "joined");
	await f.confirm("review-consent");
	const b = await f.admission("recheck", "replacement-task");
	await f.api().admit(b, openGates);
	await assert.rejects(f.api().reserve({ ...f.request(b, "expensive", 1000), rateId: "costly" }), /Cumulative/);
	await f.api().reserve({ ...f.request(b, "within", 998), rateId: "costly" });
	assert.equal((await f.f.store.get("target", b.target.targetId))!.snapshot.kind, "retained-non-code");
	f.logicalTaskId = "new-entitlement";
	await assert.rejects(f.api().admit(await f.admission("reset", "replacement-task"), openGates), /unresolved/);
});

test("mission lifetime ceiling remains after rolling shared charges age out", async (t) => {
	const f = await fixture(t);
	const rate = { ...f.f.rate, id: "costly", generatedMicrosPerMillion: 1_000_000_000 };
	await f.f.accounting.verifyRate(rate);
	for (let i = 0; i < 5; i++) {
		f.logicalTaskId = `logical-${i}`;
		const a = await f.admission(`run-${i}`, `task-${i}`);
		await f.api().admit(a, openGates);
		await f.api().reserve({ ...f.request(a, `${a.binding.runId}-call`, 3999), rateId: "costly", inputTokens: 1000 });
		await f.api().claimSend(a.binding.runId, `${a.binding.runId}-call`, openGates);
		await f.api().observeCall(f.call(a));
		await f.api().usage({
			...f.usage(a),
			rateSha256: sha(canonicalJSON(rate)),
			input: 1000,
			generated: 3999,
			durationMs: 1000,
		});
		await f.api().complete(f.completion(a), null);
		await f.api().exited(a.binding.runId, `joined-${i}`);
	}
	f.f.advance(86_400_001);
	await f.restart();
	f.logicalTaskId = "sixth";
	const a = await f.admission("sixth", "sixth-task");
	await f.api().admit(a, openGates);
	await assert.rejects(f.api().reserve(f.request(a, "beyond-total")), /Cumulative/);
});

test("projection durability races deny return, recover exact reference, and never copy a report into mission results", async (t) => {
	const f = await fixture(t),
		a = await f.admission();
	await f.send(a);
	await f.api().complete(f.completion(a), null);
	const projections = f.missions.retainedReviewProjections;
	const record = projections.record.bind(projections);
	projections.record = async (...args) => {
		const value = await record(...args);
		f.authorized = false; // Revocation after the mission-store durable ACK, before critical-store readback.
		return value;
	};
	await assert.rejects(f.api().project("run", "projection"), /Access\/fence changed/);
	f.authorized = true;
	await f.restart();
	const result = await f.api().project("run", "projection");
	assert.equal(result.kind, "retained-run-reference");
	assert.equal(Object.hasOwn(result, "outcome"), false);
	assert.equal(f.sends, 1);
});

test("callback binding/rate/receipt identity conflicts, provider overruns and source expiry fail closed", async (t) => {
	const f = await fixture(t),
		a = await f.admission();
	await f.send(a);
	await assert.rejects(f.api().observeCall({ ...f.call(a), runId: "other-run" }), /Unknown/);
	await assert.rejects(f.api().observeCall(f.call(a), "wrong-channel"), /channel mismatch/);
	await assert.rejects(f.api().usage(f.usage(a), "wrong-channel"), /channel mismatch/);
	await assert.rejects(f.api().complete(f.completion(a), null, "wrong-channel"), /channel mismatch/);
	await assert.rejects(f.api().usage({ ...f.usage(a), rateSha256: sha("wrong-rate") }), /rate/);
	await assert.rejects(
		f.f.accounting.settle("run-call", { inputTokens: 0, generatedTokens: 0, durationMs: 0 }),
		/journal/,
	);
	await f.api().usage({ ...f.usage(a), generated: 1001 }); // Overrun stays charged and fences every later call.
	await f.api().complete(f.completion(a), null);
	await f.api().exited("run", "joined");
	const b = await f.admission("new-run");
	await f.api().admit(b, openGates);
	await assert.rejects(f.api().reserve(f.request(b)), /overrun/);
	await f.f.store.rpc("expire", { now: 31 * 86_400_000 });
	await assert.rejects(f.api().project("run", "projection"), /unavailable/);
	await assert.rejects(f.api().complete(f.completion(a), null), /unavailable/);
});

test("ledger finish cannot free physical ownership for a session or another retained task", async (t) => {
	const f = await fixture(t),
		a = await f.admission();
	await f.send(a);
	await f.api().complete(f.completion(a), null);
	f.logicalTaskId = "second-task";
	const b = await f.admission("second", "second-task");
	await f.api().admit(b, openGates);
	await f.f.run("session", "session");
	await assert.rejects(f.f.accounting.admit("session", "session-approval", "session", openGates), /Physical/);
	await f.api().exited("run", "joined");
	await f.f.accounting.admit("session", "session-approval", "session", openGates);
});

test("missing/currently revoked/stale consent, account/config mismatch, erasure and unknown lineage refuse", async (t) => {
	const f = await fixture(t),
		a = await f.admission();
	const wrong = structuredClone(a);
	const foreign = structuredClone(a);
	foreign.target = { ...foreign.target, hostId: "foreign-host" };
	await assert.rejects(f.api().admit(foreign, openGates), /cross-host transfer/);
	wrong.binding = { ...wrong.binding, account: { kind: "unknown" } };
	await assert.rejects(f.api().admit(wrong, openGates), /mismatch/);
	const config = structuredClone(a);
	config.binding = { ...config.binding, configObservationId: "other" };
	await assert.rejects(f.api().admit(config, openGates), /mismatch/);
	f.logicalTaskId = null;
	await assert.rejects(f.api().admit(a, openGates), /unresolved/);
	f.logicalTaskId = a.logicalTaskId;
	await f.send(a);
	await f.api().complete(f.completion(a), null);
	f.authorized = false;
	await assert.rejects(f.api().project("run", "projection"), /revoked/);
	f.authorized = true;
	await f.confirm("review-consent-revoke");
	await assert.rejects(f.api().project("run", "projection"), /consent/);
	await assert.rejects(f.api().reserve(f.request(a, "after-revoke")), /consent/);
	await f.confirm("review-consent");
	await assert.rejects(f.api().project("run", "projection"), /consent/); // New consent never retargets old runs.
	await f.api().revoke("run");
	await f.f.store.rpc("eraseSource", { source: "source" });
	await assert.rejects(f.api().complete(f.completion(a), null), /unavailable/);
	await assert.rejects(f.api().usage(f.usage(a)), /unavailable/);
	assert.equal(f.sends, 1);
});

test("host integration remains uninstalled, no provider/executor/transport consumers", async () => {
	const root = new URL("./", import.meta.url);
	for (const path of await readdir(root, { recursive: true })) {
		if (!path.endsWith(".ts") || path.endsWith(".test.ts") || path === "retained-review-runs.ts") continue;
		assert.doesNotMatch(
			await readFile(new URL(path, root), "utf8"),
			/from ["'][^"']*retained-review-runs(?:\.ts)?["']/,
			path,
		);
	}
});
