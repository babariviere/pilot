import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type {
	DurableOperation,
	ReviewDispositionPayload,
	ReviewerConsentDisclosure,
	WorkflowConfirmationPayload,
} from "@pilot/protocol";
import { ServiceUnavailable } from "./errors.ts";
import { MissionStore } from "./missions.ts";
import { OperationConflict, OperationJournal, payloadHash } from "./operation-journal.ts";
import { ProjectStore } from "./projects.ts";
import { type QualifiedReviewDispositionSource, WorkflowConfirmations } from "./workflow-confirmations.ts";

const host = { hostId: "app", daemonId: "host", lineageId: "lineage" };
function operation(kind: string, targetId: string, value: unknown): DurableOperation {
	const payload = JSON.stringify(value);
	return {
		schemaVersion: 1,
		operationId: randomUUID(),
		producerId: randomUUID(),
		sequence: 1,
		origin: host,
		destination: host,
		kind,
		targetId,
		payload,
		payloadHash: payloadHash(payload),
	};
}
const disclosure = (): ReviewerConsentDisclosure => ({
	configurationRevision: "config-1",
	provider: "faux",
	model: "offline",
	account: "test-account",
	terms: "test terms, no transmission",
	dataScope: "exact-local-research-plan-revisions",
	retention: "raw-30-days-records-90-days-active-pins-excepted",
	expiresAt: Date.now() + 3_600_000,
	missionLimitMicros: 20_000_000,
	logicalTaskLimitMicros: 4_000_000,
	cumulativeAcrossRechecks: true,
	refillOnReplacement: false,
	paidFallback: false,
});
async function fixture(t: TestContext, disk = false) {
	const home = await mkdtemp(join(tmpdir(), "workflow-confirmation-"));
	const file = disk ? join(home, "missions.sqlite") : ":memory:";
	let store = new MissionStore(file);
	const { id } = store.create({ projectId: "project", title: "Plan", brief: "Exact saved plan", planningVersion: 1 });
	store.join("lead", id);
	store.update(id, { coordinatorSessionId: "lead" });
	let journal = new OperationJournal(join(home, "operations"), host);
	let config = disclosure();
	let configurationDigest = "project-config-1";
	let authorized = true;
	let source: QualifiedReviewDispositionSource | undefined;
	const service = () =>
		new WorkflowConfirmations({
			store,
			journal,
			authorize: (projectId, coordinator) => {
				assert.equal(projectId, "project");
				assert.equal(coordinator, "lead");
				if (!authorized) throw new Error("Project access unavailable");
				return configurationDigest;
			},
			consentConfiguration: () => config,
			dispositions: source,
		});
	t.after(async () => {
		await store.durable();
		store.close();
		await rm(home, { recursive: true, force: true });
	});
	const f = {
		id,
		home,
		get store() {
			return store;
		},
		get journal() {
			return journal;
		},
		get config() {
			return config;
		},
		set config(value) {
			config = value;
		},
		set source(value: QualifiedReviewDispositionSource | undefined) {
			source = value;
		},
		set authorized(value: boolean) {
			authorized = value;
		},
		set configurationDigest(value: string) {
			configurationDigest = value;
		},
		service,
		async prepare(kind: WorkflowConfirmationPayload["purpose"] = "workflow-approve") {
			const p = await service().prepare(id, kind);
			return operation(kind, id, { purpose: kind, ...p });
		},
		run(op: DurableOperation) {
			return journal.execute(op, (op, entry) => service().admit(op, entry.firstEntry));
		},
		async reopen() {
			await store.durable();
			if (disk) {
				store.close();
				store = new MissionStore(file);
			}
			journal = new OperationJournal(join(home, "operations"), host);
			await journal.recover((op) => service().admit(op));
		},
	};
	return f;
}

test("passive host package binds saved contents and named bounded coordinator without granting authority", async (t) => {
	const f = await fixture(t);
	const before = f.store.events(f.id);
	const op = await f.prepare();
	const value = JSON.parse(op.payload) as WorkflowConfirmationPayload;
	assert.equal(value.package.brief.markdown, "Exact saved plan");
	assert.equal(value.package.delegation.coordinatorSessionId, "lead");
	assert.equal(value.package.delegation.force, false);
	assert.equal(value.expectedPriorOperationId, null);
	assert.deepEqual(f.store.events(f.id), before);
	assert.equal((await f.service().current(f.id)).state, "missing");
	assert.equal(await f.journal.lookup(op), undefined);
	assert.equal((await f.run(op)).state, "accepted");
	assert.equal((await f.service().current(f.id)).state, "applicable");
});

test("strict purpose/full payload binding rejects actor claims, tampering, nested extras and kind spoof", async (t) => {
	const f = await fixture(t);
	const original = JSON.parse((await f.prepare()).payload);
	for (const value of [
		{ ...original, actor: "user" },
		{ ...original, capability: "native" },
		{ ...original, purpose: "review-consent" },
		{ ...original, package: { ...original.package, actor: "user" } },
		{ ...original, package: { ...original.package, brief: { ...original.package.brief, markdown: "Other" } } },
		{ ...original, package: { ...original.package, delegation: { ...original.package.delegation, force: true } } },
		{ ...original, expectedPriorOperationId: 1 },
	])
		assert.equal((await f.run(operation("workflow-approve", f.id, value))).state, "rejected");
	assert.equal((await f.run(operation("workflow-revoke", f.id, original))).state, "rejected");
	assert.equal((await f.run(operation("workflow-approve", "other-mission", original))).state, "rejected");
	assert.equal((await f.service().current(f.id)).state, "missing");
});

test("stale brief, configuration and coordinator ABA packages cannot be confirmed", async (t) => {
	const f = await fixture(t);
	const oldBrief = await f.prepare();
	f.store.writeBrief(f.id, "Changed", 1);
	assert.equal((await f.run(oldBrief)).state, "rejected");
	const config = await f.prepare();
	f.configurationDigest = "project-config-2";
	assert.equal((await f.run(config)).state, "rejected");
	const aba = await f.prepare();
	f.store.join("alternate", f.id);
	f.store.update(f.id, { coordinatorSessionId: "alternate" });
	f.store.update(f.id, { coordinatorSessionId: "lead" });
	assert.equal((await f.run(aba)).state, "rejected");
	const membership = await f.prepare();
	f.store.leave("alternate");
	f.store.join("alternate", f.id);
	assert.equal((await f.run(membership)).state, "rejected");
});

test("held entry checkpoint cannot turn an old package into a current approval", async (t) => {
	const f = await fixture(t);
	const op = await f.prepare();
	const original = f.journal.checkpoint.bind(f.journal);
	t.mock.method(f.journal, "checkpoint", async (op: DurableOperation, result: unknown) => {
		await original(op, result);
		f.store.writeBrief(f.id, "Changed during the await", 1);
	});
	assert.equal((await f.run(op)).state, "rejected");
	assert.equal(f.store.workflowConfirmations.latest(f.id, false), undefined);
});

test("task owner A-to-B-to-A and definition revisions invalidate the captured package", async (t) => {
	const f = await fixture(t);
	f.store.join("worker", f.id);
	f.store.join("other", f.id);
	const assignment = {
		version: 1 as const,
		expectedRevision: 0,
		intent: "Check exact owner",
		scope: "Local fixture",
		criteria: ["Preserve fences"],
	};
	const task = f.store.addTask(f.id, { title: "Work", sessionId: "worker", assignment });
	const op = await f.prepare();
	f.store.updateTask(f.id, task.id, { sessionId: "other", assignment: { ...assignment, expectedRevision: 1 } });
	f.store.updateTask(f.id, task.id, { sessionId: "worker", assignment: { ...assignment, expectedRevision: 2 } });
	assert.equal(f.store.task(f.id, task.id).sessionId, "worker");
	assert.equal((await f.run(op)).state, "rejected");
});

test("exact operation dedupe, immutable conflict and expected prior CAS do not carry authority forward", async (t) => {
	const f = await fixture(t);
	const first = await f.prepare(),
		stalePrior = await f.prepare();
	const accepted = await f.run(first);
	assert.equal(accepted.state, "accepted");
	assert.deepEqual(await f.run(first), accepted);
	assert.deepEqual(await f.journal.lookup(first), accepted, "lost ACK lookup is passive");
	assert.equal((await f.run(stalePrior)).state, "rejected");
	const changed = operation(first.kind, first.targetId, { purpose: "workflow-revoke" });
	await assert.rejects(f.run({ ...changed, operationId: first.operationId }), OperationConflict);
	await assert.rejects(f.run({ ...first, kind: "workflow-revoke" }), OperationConflict);
	f.store.writeBrief(f.id, "Revision two", 1);
	assert.equal((await f.service().current(f.id)).state, "stale");
	assert.deepEqual(await f.run(first), accepted);
	assert.equal((await f.service().current(f.id)).state, "stale");
});

test("revocation is append-only, exact prior CAS and historical ACK never renew a revoked approval", async (t) => {
	const f = await fixture(t);
	const approval = await f.prepare();
	await f.run(approval);
	const revoke = await f.prepare("workflow-revoke"),
		stale = await f.prepare("workflow-revoke");
	assert.equal((await f.run(revoke)).state, "accepted");
	assert.equal((await f.service().current(f.id)).state, "revoked");
	assert.equal((await f.run(stale)).state, "rejected");
	assert.equal((await f.run(approval)).state, "accepted");
	assert.equal((await f.service().current(f.id)).state, "revoked");
	assert.ok(f.store.workflowConfirmations.lookup(approval));
	assert.ok(f.store.workflowConfirmations.lookup(revoke));
});

test("consent requires current approval and exact disclosed account/model/terms and fixed cumulative limits", async (t) => {
	const f = await fixture(t);
	await assert.rejects(f.prepare("review-consent"), /current exact workflow approval/);
	await f.run(await f.prepare());
	const consent = await f.prepare("review-consent");
	const disclosureInPackage = JSON.parse(consent.payload).package.disclosure;
	assert.equal(disclosureInPackage.missionLimitMicros, 20_000_000);
	assert.equal(disclosureInPackage.logicalTaskLimitMicros, 4_000_000);
	assert.equal(disclosureInPackage.refillOnReplacement, false);
	f.config = { ...f.config, model: "changed" };
	assert.equal((await f.run(consent)).state, "rejected");
	for (const patch of [
		{ account: "" },
		{ terms: "" },
		{ paidFallback: true },
		{ missionLimitMicros: 21_000_000 },
		{ logicalTaskLimitMicros: 5_000_000 },
		{ refillOnReplacement: true },
		{ expiresAt: 1 },
	]) {
		const old = f.config;
		f.config = { ...old, ...patch } as ReviewerConsentDisclosure;
		await assert.rejects(f.prepare("review-consent"));
		f.config = old;
	}
	assert.equal((await f.run(await f.prepare("review-consent"))).state, "accepted");
	assert.equal((await f.service().current(f.id, true)).state, "applicable");
	await f.run(await f.prepare("workflow-revoke"));
	assert.equal((await f.service().current(f.id, true)).state, "stale");
	assert.equal((await f.run(await f.prepare("review-consent-revoke"))).state, "accepted");
	assert.equal((await f.service().current(f.id, true)).state, "revoked");
});

test("consent renewals preserve history and mission-end expiry; missing real configuration refuses", async (t) => {
	const f = await fixture(t);
	await f.run(await f.prepare());
	const first = await f.prepare("review-consent");
	await f.run(first);
	const next = await f.prepare("review-consent");
	await f.run(next);
	assert.ok(f.store.workflowConfirmations.lookup(first));
	assert.ok(f.store.workflowConfirmations.lookup(next));
	assert.equal(JSON.parse(next.payload).expectedPriorOperationId, first.operationId);
	f.store.update(f.id, { status: "done" });
	assert.equal((await f.service().current(f.id, true)).state, "expired");
	f.store.update(f.id, { status: "active" });
	await f.run(await f.prepare());
	const unavailable = new WorkflowConfirmations({
		store: f.store,
		journal: f.journal,
		authorize: () => "project-config-1",
	});
	await assert.rejects(unavailable.prepare(f.id, "review-consent"), /configuration is unavailable/);
});

for (const entered of [false, true])
	test(`restart ${entered ? "after checkpoint" : "after reservation"} before effect remains Unknown, not new authority`, async (t) => {
		const f = await fixture(t, true);
		const op = await f.prepare();
		await f.journal.reserve(op);
		if (entered)
			await f.journal.checkpoint(op, {
				stage: "workflow-effect-entered",
				purpose: op.kind,
				payloadHash: op.payloadHash,
			});
		await f.reopen();
		assert.equal((await f.journal.lookup(op))?.state, "pending");
		assert.equal((await f.run(op)).state, "pending", "duplicate POST is also lookup-only");
		assert.equal((await f.service().current(f.id)).state, "missing");
	});

test("restart after durable effect but before accepted receipt recovers exact history despite current revocation", async (t) => {
	const f = await fixture(t, true);
	const approval = await f.prepare();
	const pending = await f.journal.execute(approval, async (op, entry) => {
		await f.service().admit(op, entry.firstEntry);
		throw new Error("lost final ACK");
	});
	assert.equal(pending.state, "pending");
	await f.run(await f.prepare("workflow-revoke"));
	await f.reopen();
	assert.equal((await f.journal.lookup(approval))?.state, "accepted");
	assert.equal((await f.service().current(f.id)).state, "revoked");
});

test("restart with an entered revocation but no exact effect cannot resurrect the prior matching grant", async (t) => {
	const f = await fixture(t, true);
	await f.run(await f.prepare());
	const heldApproval = await f.prepare();
	const revoke = await f.prepare("workflow-revoke");
	await f.journal.reserve(revoke);
	await f.journal.checkpoint(revoke, {
		stage: "workflow-effect-entered",
		purpose: revoke.kind,
		payloadHash: revoke.payloadHash,
	});
	await f.reopen();
	assert.equal((await f.service().current(f.id)).state, "unknown");
	assert.equal((await f.journal.lookup(revoke))?.state, "pending");
	assert.equal((await f.run(heldApproval)).state, "rejected");
	await assert.rejects(f.prepare(), /revocation is uncertain/);
	assert.equal((await f.service().current(f.id)).state, "unknown");
});

test("failed durability leaves positive authority unusable and cannot publish an accepted receipt", async (t) => {
	const f = await fixture(t);
	const approval = await f.prepare();
	const fault = t.mock.method(f.store, "durable", async () => {
		throw new ServiceUnavailable("disk failed");
	});
	assert.equal((await f.run(approval)).state, "pending");
	assert.ok(f.store.workflowConfirmations.lookup(approval), "in-memory effect is not a durable receipt");
	await assert.rejects(f.service().current(f.id), /disk failed/);
	assert.equal((await f.run(approval)).state, "pending");
	fault.mock.restore();
	await f.reopen();
	assert.equal((await f.journal.lookup(approval))?.state, "accepted");
});

test("entered consent without its exact row stays Unknown despite a matching current consent package", async (t) => {
	const f = await fixture(t, true);
	await f.run(await f.prepare());
	const op = await f.prepare("review-consent");
	await f.journal.reserve(op);
	await f.journal.checkpoint(op, { stage: "workflow-effect-entered", purpose: op.kind, payloadHash: op.payloadHash });
	await f.reopen();
	assert.deepEqual(JSON.parse((await f.prepare("review-consent")).payload).package, JSON.parse(op.payload).package);
	assert.equal((await f.journal.lookup(op))?.state, "pending");
	assert.equal((await f.run(op)).state, "pending");
	assert.equal(f.store.workflowConfirmations.latest(f.id, true), undefined);
});

test("revocation blocks immediately on failed durability, while its receipt remains pending", async (t) => {
	const f = await fixture(t);
	await f.run(await f.prepare());
	const revoke = await f.prepare("workflow-revoke");
	const fault = t.mock.method(f.store, "durable", async () => {
		throw new Error("disk failed");
	});
	assert.equal((await f.run(revoke)).state, "pending");
	assert.equal((await f.service().current(f.id)).state, "revoked");
	fault.mock.restore();
});

test("failed checkpoint and unreadable exact lookup never create or reconstruct an effect", async (t) => {
	const f = await fixture(t);
	const op = await f.prepare();
	const fault = t.mock.method(f.journal, "checkpoint", async () => {
		throw new Error("journal disk failed");
	});
	assert.equal((await f.run(op)).state, "pending");
	assert.equal(f.store.workflowConfirmations.latest(f.id, false), undefined);
	fault.mock.restore();
	await f.journal.checkpoint(op, { stage: "workflow-effect-entered", purpose: op.kind, payloadHash: op.payloadHash });
	const unreadable = t.mock.method(f.store.workflowConfirmations, "lookup", () => {
		throw new Error("store unreadable");
	});
	assert.equal((await f.run(op)).state, "pending");
	unreadable.mock.restore();
	assert.equal((await f.run(op)).state, "pending");
	assert.equal(f.store.workflowConfirmations.latest(f.id, false), undefined);
});

const reviewRequest = (): ReviewDispositionPayload => ({
	purpose: "review-disposition",
	disposition: "approve",
	body: "",
	expectedPriorRecordId: null,
	packageDigest: "a".repeat(64),
	targets: [
		{
			projectId: "project",
			sessionId: "worker",
			snapshotId: "b".repeat(64),
			repositoryId: "c".repeat(64),
			changeId: "k".repeat(32),
			baseCommitId: "d".repeat(40),
			headCommitId: "e".repeat(40),
			layer: "layer",
			diffSha256: "f".repeat(64),
			comparisonDigest: "1".repeat(64),
		},
	],
});
test("missing durable feedback producer refuses every disposition without creating a duplicate feedback store", async (t) => {
	const f = await fixture(t);
	for (const disposition of ["comment", "request_changes", "approve"] as const) {
		const p = { ...reviewRequest(), disposition, body: "Exact selected revision only" };
		const r = await f.run(operation("review-disposition", p.packageDigest, p));
		assert.equal(r.state, "rejected");
		assert.match(r.reason!, /feedback source is unavailable/);
	}
});
test("test-only producer binds exact selections and refuses unavailable checks/agent review before Approve", async (t) => {
	const f = await fixture(t);
	let passed = false,
		changed = false,
		writes = 0;
	const records = new Map<string, { recordId: string }>();
	f.source = {
		prepare: async (p) => (changed ? { ...p, targets: [{ ...p.targets[0]!, headCommitId: "2".repeat(40) }] } : p),
		prerequisites: async () => (passed ? "passed" : "unavailable"),
		record: async (op) => {
			writes++;
			const r = { recordId: op.operationId };
			records.set(op.operationId, r);
			return r;
		},
		lookup: async (op) => records.get(op.operationId),
	};
	const p = reviewRequest();
	assert.equal((await f.run(operation("review-disposition", p.packageDigest, p))).state, "rejected");
	assert.equal(writes, 0);
	passed = true;
	changed = true;
	assert.equal((await f.run(operation("review-disposition", p.packageDigest, p))).state, "rejected");
	changed = false;
	for (const spoof of [
		{ ...p, missionId: f.id },
		{ ...p, actor: "user" },
		{ ...p, targets: [{ ...p.targets[0], taskId: "guessed" }] },
		{ ...p, targets: [p.targets[0], p.targets[0]] },
	])
		assert.equal((await f.run(operation("review-disposition", p.packageDigest, spoof))).state, "rejected");
	const op = operation("review-disposition", p.packageDigest, p);
	assert.equal((await f.run(op)).state, "accepted");
	assert.equal((await f.run(op)).state, "accepted");
	assert.equal(writes, 1);
	const missing = operation("review-disposition", p.packageDigest, p);
	await f.journal.reserve(missing);
	await f.journal.checkpoint(missing, {
		stage: "workflow-effect-entered",
		purpose: missing.kind,
		payloadHash: missing.payloadHash,
	});
	assert.equal((await f.run(missing)).state, "pending");
	assert.equal(writes, 1);
});

test("project configuration edits/reverts carry a persisted host-owned ABA fence", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "workflow-project-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const projects = new ProjectStore(home);
	await projects.load();
	const p = await projects.create({ name: "A", path: home });
	const b = await projects.update(p.id, { name: "B" });
	const a = await projects.update(p.id, { name: "A" });
	assert.notEqual(b.workflowGeneration, a.workflowGeneration);
	const reopened = new ProjectStore(home);
	await reopened.load();
	assert.equal(reopened.require(p.id).workflowGeneration, a.workflowGeneration);
});

test("test-only durable feedback lookup settles a lost ACK without repeating record or current prerequisite reads", async (t) => {
	const f = await fixture(t);
	const records = new Map<string, { recordId: string }>();
	let writes = 0,
		obsolete = false;
	f.source = {
		prepare: async (p) => {
			assert.equal(obsolete, false);
			return p;
		},
		prerequisites: async () => {
			assert.equal(obsolete, false);
			return "passed";
		},
		record: async (op) => {
			writes++;
			records.set(op.operationId, { recordId: op.operationId });
			throw new ServiceUnavailable("producer ACK lost after durable write");
		},
		lookup: async (op) => records.get(op.operationId),
	};
	const p = reviewRequest(),
		op = operation("review-disposition", p.packageDigest, p);
	assert.equal((await f.run(op)).state, "pending");
	obsolete = true;
	await f.reopen();
	assert.equal((await f.journal.lookup(op))?.state, "accepted");
	assert.equal(writes, 1);
});

test("a source cannot mutate the immutable confirmed selection by modifying its prepare input", async (t) => {
	const f = await fixture(t);
	f.source = {
		prepare: async (p) => {
			p.targets[0]!.headCommitId = "2".repeat(40);
			return p;
		},
		prerequisites: async () => "passed",
		record: async () => assert.fail("Changed selections must never reach persistence"),
		lookup: async () => undefined,
	};
	const p = reviewRequest();
	assert.equal((await f.run(operation("review-disposition", p.packageDigest, p))).state, "rejected");
	assert.equal(p.targets[0]!.headCommitId, "e".repeat(40));
});

test("missing prerequisite producer refuses Approve while early comments still reach the feedback producer", async (t) => {
	const f = await fixture(t);
	let writes = 0;
	f.source = {
		prepare: async (p) => p,
		record: async (op) => {
			writes++;
			return { recordId: op.operationId };
		},
		lookup: async () => undefined,
	};
	const p = reviewRequest();
	const approval = await f.run(operation("review-disposition", p.packageDigest, p));
	assert.equal(approval.state, "rejected");
	assert.match(approval.reason!, /checks and agent review have not passed/);
	assert.equal(writes, 0);
	assert.equal(
		(
			await f.run(
				operation("review-disposition", p.packageDigest, { ...p, disposition: "comment", body: "Early comment" }),
			)
		).state,
		"accepted",
	);
	assert.equal(writes, 1);
});

test("consent time expiry refuses use without extending the captured allowance", async (t) => {
	const f = await fixture(t);
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	f.config = { ...f.config, expiresAt: now + 1000 };
	await f.run(await f.prepare());
	await f.run(await f.prepare("review-consent"));
	assert.equal((await f.service().current(f.id, true)).state, "applicable");
	now += 1000;
	assert.equal((await f.service().current(f.id, true)).state, "expired");
	await assert.rejects(f.prepare("review-consent"), /disclosure or cumulative allowance/);
});

function deferred() {
	let resolve!: () => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

/** Holds a snapshot of the first journal read, after current()'s store barrier completed. */
function holdCurrentJournalRead(t: TestContext, journal: OperationJournal) {
	const entered = deferred();
	const release = deferred();
	let first = true;
	const read = journal.targetReceipts.bind(journal);
	t.mock.method(journal, "targetReceipts", async (kind: string, targetId: string) => {
		const snapshot = await read(kind, targetId);
		if (first) {
			first = false;
			entered.resolve();
			await release.promise;
		}
		return snapshot;
	});
	t.after(() => release.resolve());
	return { entered: entered.promise, release: () => release.resolve() };
}

for (const consent of [false, true])
	for (const existing of [false, true])
		for (const failure of [false, true]) {
			test(`${consent ? "consent" : "approval"} currentness cannot select a ${existing ? "replacement" : "first"} row after its barrier with ${failure ? "failed" : "held"} saving`, async (t) => {
				const f = await fixture(t);
				if (consent || existing) await f.run(await f.prepare());
				if (consent && existing) await f.run(await f.prepare("review-consent"));
				const next = await f.prepare(consent ? "review-consent" : "workflow-approve");
				const before = f.store.workflowConfirmations.latest(f.id, consent)?.operationId;
				const journal = holdCurrentJournalRead(t, f.journal);
				const current = f.service().current(f.id, consent);
				await journal.entered;
				// Future durable() calls deliberately exclude the already-completed current() barrier.
				const saving = deferred(),
					saved = deferred();
				const save = t.mock.method(f.store, "durable", () => {
					saving.resolve();
					return saved.promise;
				});
				const attempt = f.run(next);
				try {
					await saving.promise;
					assert.notEqual(f.store.workflowConfirmations.latest(f.id, consent)?.operationId, before);
					assert.equal(f.store.workflowConfirmations.latest(f.id, consent)?.operationId, next.operationId);
					if (failure) {
						saved.reject(new Error("save introduced after barrier failed"));
						assert.equal((await attempt).state, "pending");
					} else {
						assert.equal((await f.journal.lookup(next))?.state, "pending", "the new save has not settled");
					}
					journal.release();
					assert.deepEqual(await current, { state: "unknown" }, "no positive row or payload outside the barrier");
				} finally {
					saved.resolve();
					journal.release();
					await attempt;
					save.mock.restore();
				}
				if (!failure)
					assert.equal(
						(await f.service().current(f.id, consent)).state,
						"applicable",
						"a fresh barrier can cover the new row",
					);
			});
		}

test("consent currentness also pins its observed workflow authority across the durability barrier", async (t) => {
	const f = await fixture(t);
	await f.run(await f.prepare());
	await f.run(await f.prepare("review-consent"));
	const next = await f.prepare();
	const journal = holdCurrentJournalRead(t, f.journal);
	const current = f.service().current(f.id, true);
	await journal.entered;
	const saving = deferred(),
		saved = deferred();
	const save = t.mock.method(f.store, "durable", () => {
		saving.resolve();
		return saved.promise;
	});
	const attempt = f.run(next);
	try {
		await saving.promise;
		journal.release();
		assert.deepEqual(await current, { state: "unknown" });
	} finally {
		saved.resolve();
		journal.release();
		await attempt;
		save.mock.restore();
	}
});
