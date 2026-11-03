import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { InsightsFindingDraft, InsightsReviewRecord } from "@pilot/protocol";
import type { InsightsAdmission } from "./insights-admission.ts";
import { parseInsightsBacklog } from "./insights-backlog.ts";
import { MissionStore } from "./missions.ts";

const sourceId = randomUUID();
const host = { hostId: "local", daemonId: "daemon", lineageId: "lineage" };
const draft: InsightsFindingDraft = {
	title: "Repeated context exploration",
	priority: "high",
	observation: "Two synthetic chats repeat the same searches.",
	uncertainty: "Repository state and monetary baseline are unknown.",
	proposedChange: "Propose a scoped deterministic check.",
	expectedBenefit: "Fewer repeated searches without removing safety checks.",
	targets: [{ projectId: "foreign-project", label: "Project workflow" }],
	implementationLinks: [],
	cost: {
		baseline: "unknown",
		assumptions: "Synthetic repeated search count only; pricing unavailable.",
		estimate: "Unknown monetary saving.",
		qualityRisks: "Keep safety and completion quality unchanged.",
		laterResult: "unknown",
	},
};
const evidence = () => ({
	key: randomUUID(),
	sessionId: sourceId,
	ref: `diagnostic-history:v1:${sourceId}:1`,
	observedAt: "2026-01-01T00:00:00.000Z",
	classification: "observed",
	summary: "Synthetic repetition; not a permission grant.",
});
const review = (): InsightsReviewRecord => ({
	status: "partial",
	windowStart: "2026-01-01T00:00:00.000Z",
	windowEnd: "2026-01-02T00:00:00.000Z",
	markdown: "Observed repetition. Repository state remains unverified.",
	checkpoints: [
		{
			sessionId: sourceId,
			streamId: null,
			before: 12,
			after: null,
			throughEntry: 2,
			coverage: "partial",
			gaps: ["Reader supplies no validated stream identity."],
		},
	],
	findingKeys: [],
	gaps: ["Bounded synthetic sample only."],
});

function fixture(file = ":memory:") {
	const store = new MissionStore(file);
	const mission = store.create({ title: "Review backlog", projectId: "p1", planningVersion: 1 });
	const foreign = store.create({ title: "Unrelated", projectId: "foreign-project" });
	const ordinary = store.addTask(mission.id, { title: "Ordinary coordination task" });
	let active = true;
	let validations = 0;
	const admission: InsightsAdmission = {
		binding: Object.freeze({
			schemaVersion: 1,
			grantId: randomUUID(),
			revision: 1,
			enabled: true,
			reportSessionId: randomUUID(),
			projectId: "p1",
			missionId: mission.id,
			host: Object.freeze(host),
		}),
		revalidate() {
			validations++;
			if (!active) throw new Error("Admission revoked");
		},
	};
	return {
		store,
		mission,
		foreign,
		ordinary,
		admission,
		revoke: () => {
			active = false;
		},
		validations: () => validations,
	};
}
const propose = (key = randomUUID()) => ({
	action: "propose",
	key,
	operationId: randomUUID(),
	expectedRevision: 0,
	draft,
	evidence: [evidence()],
});

test("stable finding keys deduplicate atomically, append evidence, CAS and preserve ordinary tasks", async (t) => {
	const f = fixture();
	t.after(() => f.store.close());
	const request = propose();
	const first = (await f.store.insights.call(f.admission, request)) as { taskId: string; revision: number };
	assert.deepEqual(await f.store.insights.call(f.admission, request), first);
	await assert.rejects(
		f.store.insights.call(f.admission, { ...request, operationId: randomUUID() }),
		/revision changed/,
	);
	const amend = {
		...request,
		action: "amend",
		expectedRevision: 1,
		operationId: randomUUID(),
		evidence: [...request.evidence, evidence()],
	};
	const results = await Promise.allSettled([
		f.store.insights.call(f.admission, amend),
		f.store.insights.call(f.admission, { ...amend, operationId: randomUUID() }),
	]);
	assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
	const page = (await f.store.insights.call(f.admission, { action: "evidence", key: request.key })) as {
		items: unknown[];
	};
	assert.equal(page.items.length, 2);
	assert.equal(f.store.tasks(f.mission.id).length, 2);
	assert.equal(f.store.tasks(f.foreign.id).length, 0);
	assert.equal(f.store.task(f.mission.id, f.ordinary.id).title, "Ordinary coordination task");
	assert.equal(f.store.task(f.mission.id, first.taskId).status, "todo");
	assert.match(f.store.task(f.mission.id, first.taskId).body!, /Tracking only/);
	assert.ok(f.validations() >= 3);
	await assert.rejects(
		f.store.insights.call(f.admission, { ...amend, operationId: request.operationId }),
		/Operation ID/,
	);
	const receipt = await f.store.insights.call(f.admission, { action: "receipt", operationId: request.operationId });
	assert.deepEqual(receipt, { state: "committed", receipt: first });
	assert.deepEqual(await f.store.insights.call(f.admission, { action: "receipt", operationId: "lost-unknown" }), {
		state: "unknown",
	});
});

test("evidence keys are immutable and failed appends roll back all evidence and revisions", async (t) => {
	const f = fixture();
	t.after(() => f.store.close());
	const p = propose();
	await f.store.insights.call(f.admission, p);
	await assert.rejects(
		f.store.insights.call(f.admission, {
			...p,
			action: "amend",
			operationId: randomUUID(),
			expectedRevision: 1,
			evidence: [evidence(), { ...p.evidence[0], summary: "replace prior evidence" }],
		}),
		/immutable/,
	);
	const page = (await f.store.insights.call(f.admission, { action: "evidence", key: p.key })) as { items: unknown[] };
	assert.equal(page.items.length, 1);
	const item = (await f.store.insights.call(f.admission, { action: "get", kind: "finding", key: p.key })) as {
		revision: number;
	};
	assert.equal(item.revision, 1);
});

test("model operations cannot confirm lifecycle or execute finding tasks", async (t) => {
	const f = fixture();
	t.after(() => f.store.close());
	const p = propose();
	const result = (await f.store.insights.call(f.admission, p)) as { taskId: string };
	for (const action of [
		"approve",
		"confirmLifecycle",
		"start",
		"complete",
		"repair",
		"task",
		"decide",
		"brief",
		"send",
		"claim",
		"archive",
	]) {
		await assert.rejects(f.store.insights.call(f.admission, { action, key: p.key }), /Unknown/);
	}
	for (const field of [
		"missionId",
		"projectId",
		"sessionId",
		"lifecycle",
		"authority",
		"approval",
		"status",
		"taskId",
	]) {
		await assert.rejects(f.store.insights.call(f.admission, { ...p, [field]: "forged" }), /Unknown/);
	}
	assert.throws(() => f.store.updateTask(f.mission.id, result.taskId, { status: "done" }), /Finding tracking/);
	assert.throws(() => f.store.updateTask(f.mission.id, result.taskId, { sessionId: "worker" }), /Finding tracking/);
	assert.throws(() => f.store.prepareTaskStart(f.mission.id, [result.taskId]), /Finding tracking/);
	f.store.join("worker", f.mission.id);
	assert.throws(() => f.store.claimTask(f.mission.id, result.taskId, "worker", {}), /Finding tracking/);
	assert.throws(() => f.store.removeTask(f.mission.id, result.taskId), /Finding tracking/);
	assert.throws(() => f.store.releaseTask(f.mission.id, result.taskId), /Finding tracking/);
	assert.throws(() => f.store.groupTasks(f.mission.id, [result.taskId], "Implementation"), /Finding tracking/);
	assert.throws(
		() =>
			f.store.taskModel(f.mission.id, "p1", result.taskId, {
				preferredModel: "test/offline",
				preferredThinking: null,
			}),
		/Finding tracking/,
	);
	assert.throws(() => f.store.completeTask(f.mission.id, result.taskId, "worker", {}), /Finding tracking/);
	assert.throws(() => f.store.saveNonCodeDelivery(f.mission.id, result.taskId, "worker", {}), /Finding tracking/);
	await assert.rejects(
		f.store.submitDeliveryEvidence(f.mission.id, result.taskId, "worker", {}, async () => {
			throw new Error("unreachable");
		}),
		/Finding tracking/,
	);
	await assert.rejects(f.store.judgeDeliveryEvidence(f.mission.id, result.taskId, "worker", {}), /Finding tracking/);
	await assert.rejects(
		f.store.recordReviewResult(
			f.mission.id,
			result.taskId,
			"worker",
			{},
			{
				authorize() {},
				async resolve() {
					throw new Error("unreachable");
				},
				async observeProducer() {
					throw new Error("unreachable");
				},
				async validateCitations() {
					throw new Error("unreachable");
				},
			},
		),
		/Finding tracking/,
	);
	assert.throws(
		() => f.store.projectSharedProgress({ task: { taskId: result.taskId } } as never, "done"),
		/Finding tracking/,
	);
	assert.throws(
		() =>
			f.store.applyPullRequestBinding({
				id: randomUUID(),
				sessionId: "worker",
				missionId: f.mission.id,
				taskId: result.taskId,
				url: "https://github.com/example/repo/pull/1",
				bound: true,
				previousSessionIds: [],
				actor: {},
			}),
		/Finding tracking/,
	);
	assert.throws(
		() => f.store.recordTaskStart(f.mission.id, result.taskId, "test/offline", "high"),
		/Finding tracking/,
	);
	assert.throws(
		() => f.store.addResource(f.mission.id, { taskId: result.taskId, url: "https://github.com/example/repo/pull/1" }),
		/Finding tracking/,
	);
	await assert.rejects(
		f.store.insights.call(f.admission, {
			action: "amend",
			key: f.ordinary.id,
			operationId: randomUUID(),
			expectedRevision: 0,
			draft,
			evidence: [],
		}),
		/existing finding/,
	);
});

test("host user confirmations distinguish shipped from verified; later claims grant no authority", async (t) => {
	const f = fixture();
	t.after(() => f.store.close());
	const p = propose();
	const first = (await f.store.insights.call(f.admission, p)) as { taskId: string };
	await assert.rejects(
		f.store.insights.confirmLifecycle(f.admission, p.key, 1, "verified", randomUUID()),
		/Only shipped/,
	);
	await f.store.insights.confirmLifecycle(f.admission, p.key, 1, "approved", "user-approve");
	await assert.rejects(
		f.store.insights.call(f.admission, {
			...p,
			action: "amend",
			expectedRevision: 2,
			operationId: randomUUID(),
			draft: { ...draft, proposedChange: "Replace the approved scope" },
		}),
		/frozen/,
	);
	await f.store.insights.confirmLifecycle(f.admission, p.key, 2, "in_progress", "user-progress");
	await f.store.insights.confirmLifecycle(f.admission, p.key, 3, "shipped", "user-shipped");
	assert.equal(f.store.task(f.mission.id, first.taskId).status, "done");
	let item = (await f.store.insights.call(f.admission, { action: "get", kind: "finding", key: p.key })) as {
		lifecycle: string;
	};
	assert.equal(item.lifecycle, "shipped");
	await f.store.insights.call(f.admission, {
		...p,
		action: "amend",
		expectedRevision: 4,
		operationId: randomUUID(),
		draft: {
			...draft,
			implementationLinks: ["https://example.test/commit/1"],
			cost: { ...draft.cost!, laterResult: "Model claims savings of $100, unverified." },
		},
		evidence: [evidence()],
	});
	item = (await f.store.insights.call(f.admission, { action: "get", kind: "finding", key: p.key })) as {
		lifecycle: string;
	};
	assert.equal(item.lifecycle, "shipped");
	await f.store.insights.confirmLifecycle(f.admission, p.key, 5, "verified", "user-benefit");
	const history = (await f.store.insights.call(f.admission, { action: "history", kind: "finding", key: p.key })) as {
		items: Array<{ lifecycle: string; authority: string | null }>;
	};
	assert.deepEqual(
		history.items.map((i) => i.lifecycle),
		["proposed", "approved", "in_progress", "shipped", "shipped", "verified"],
	);
	assert.equal(history.items.at(-1)!.authority, "explicit_user_confirmation");
});

test("report/checkpoint receipts and stream-aware revisions survive restart without claiming coverage", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "insights-backlog-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const file = join(dir, "missions.sqlite");
	const f = fixture(file);
	const p = propose();
	const first = await f.store.insights.call(f.admission, p);
	const checkpoint = {
		action: "save_checkpoint",
		key: randomUUID(),
		expectedRevision: 0,
		operationId: "checkpoint-1",
		record: review(),
	};
	const report = {
		action: "save_report",
		key: randomUUID(),
		expectedRevision: 0,
		operationId: "report-1",
		record: { ...review(), findingKeys: [p.key] },
	};
	await f.store.insights.call(f.admission, checkpoint);
	const saved = await f.store.insights.call(f.admission, report);
	await f.store.insights.confirmLifecycle(f.admission, p.key, 1, "deferred", "user-defer");
	f.store.close();
	const store = new MissionStore(file);
	t.after(() => store.close());
	assert.deepEqual(await store.insights.call(f.admission, report), saved);
	assert.deepEqual(await store.insights.call(f.admission, { action: "receipt", operationId: p.operationId }), {
		state: "committed",
		receipt: first,
	});
	const point = (await store.insights.call(f.admission, {
		action: "get",
		kind: "checkpoint",
		key: checkpoint.key,
	})) as { payload: InsightsReviewRecord & { authority: string } };
	assert.equal(point.payload.checkpoints[0]!.streamId, null);
	assert.equal(point.payload.authority, "review_claim_only");
	const history = (await store.insights.call(f.admission, { action: "history", kind: "finding", key: p.key })) as {
		items: unknown[];
	};
	assert.equal(history.items.length, 2);
	assert.equal(
		((await store.insights.call(f.admission, { action: "evidence", key: p.key })) as { items: unknown[] }).items
			.length,
		1,
	);
	const record = review();
	record.checkpoints[0]!.gaps = [];
	await assert.rejects(
		store.insights.call(f.admission, { ...checkpoint, expectedRevision: 1, operationId: "unsafe-advance", record }),
		/stream/,
	);
	record.checkpoints[0]!.streamId = "new-stream";
	await assert.rejects(
		store.insights.call(f.admission, { ...checkpoint, expectedRevision: 1, operationId: "unsafe-reset", record }),
		/stream/,
	);
	record.checkpoints[0]!.gaps = ["Explicit bounded rescan after changed stream."];
	await store.insights.call(f.admission, { ...checkpoint, expectedRevision: 1, operationId: "rescan", record });
	assert.equal(
		(
			(await store.insights.call(f.admission, { action: "history", kind: "checkpoint", key: checkpoint.key })) as {
				items: unknown[];
			}
		).items.length,
		2,
	);
});

test("transaction admission and post-durability disclosure are independently fenced", async (t) => {
	const f = fixture();
	t.after(() => f.store.close());
	const p = propose();
	let checks = 0;
	const revoked: InsightsAdmission = {
		binding: f.admission.binding,
		revalidate() {
			if (++checks >= 2) throw new Error("revoked in transaction");
		},
	};
	await assert.rejects(f.store.insights.call(revoked, p), /revoked/);
	assert.equal(f.store.tasks(f.mission.id).length, 1);
	let release!: () => void;
	const held = new Promise<void>((r) => {
		release = r;
	});
	t.mock.method(f.store, "durable", () => held);
	const writing = f.store.insights.call(f.admission, p);
	f.revoke();
	release();
	await assert.rejects(writing, /revoked/);
	assert.equal(
		f.store.tasks(f.mission.id).length,
		2,
		"commit may persist after revocation, but no result is disclosed",
	);
	await assert.rejects(f.store.insights.call(f.admission, { action: "get", kind: "finding", key: p.key }), /revoked/);
});

test("closed parsing rejects widened authority, malformed nested records, costs without assumptions and sparse arrays", () => {
	const p = propose();
	for (const extra of [{ authority: "user" }, { lifecycle: "verified" }, { permissions: ["write"] }])
		assert.throws(() => parseInsightsBacklog({ ...p, draft: { ...draft, ...extra } }), /Unknown/);
	assert.throws(
		() => parseInsightsBacklog({ ...p, draft: { ...draft, cost: { ...draft.cost, assumptions: "" } } }),
		/Invalid/,
	);
	assert.throws(() => parseInsightsBacklog({ ...p, evidence: new Array(1) }), /dense/);
	const ev = [evidence()];
	Object.defineProperty(ev, "4294967295", { value: evidence(), enumerable: true });
	assert.throws(() => parseInsightsBacklog({ ...p, evidence: ev }), /dense/);
	assert.throws(() => parseInsightsBacklog({ action: "list", kind: "finding", limit: 100 }), /integer/);
});

test("bounded evidence/history pages retain append-only data beyond one page", async (t) => {
	const f = fixture();
	t.after(() => f.store.close());
	const p = propose();
	await f.store.insights.call(f.admission, p);
	await f.store.insights.call(f.admission, {
		...p,
		action: "amend",
		expectedRevision: 1,
		operationId: "many-evidence",
		evidence: Array.from({ length: 20 }, evidence),
	});
	const page = (await f.store.insights.call(f.admission, { action: "evidence", key: p.key, limit: 20 })) as {
		items: unknown[];
		nextCursor: number;
	};
	assert.equal(page.items.length, 20);
	const next = (await f.store.insights.call(f.admission, {
		action: "evidence",
		key: p.key,
		cursor: page.nextCursor,
		limit: 20,
	})) as { items: unknown[]; nextCursor: null };
	assert.equal(next.items.length, 1);
	assert.equal(next.nextCursor, null);
});

test("UTF-8 request and response bounds include large report history and qualified hosts", async (t) => {
	const f = fixture();
	t.after(() => f.store.close());
	const admission: InsightsAdmission = {
		...f.admission,
		binding: {
			...f.admission.binding,
			host: { hostId: "h".repeat(128), daemonId: "d".repeat(128), lineageId: "l".repeat(128) },
		},
	};
	const key = randomUUID();
	const record = {
		...review(),
		markdown: "😀".repeat(8000),
		checkpoints: [],
		gaps: Array.from({ length: 20 }, () => "€".repeat(500)),
	};
	const request = { action: "save_report", key, expectedRevision: 0, operationId: "large-report", record };
	await assert.rejects(
		f.store.insights.call(admission, { ...request, record: { ...record, markdown: "€".repeat(16000) } }),
		/64 KB/,
	);
	await f.store.insights.call(admission, request);
	await f.store.insights.call(admission, { ...request, operationId: "large-report-2", expectedRevision: 1 });
	const current = await f.store.insights.call(admission, { action: "get", kind: "report", key });
	assert.ok(Buffer.byteLength(JSON.stringify(current)) <= 64 * 1024);
	const first = (await f.store.insights.call(admission, { action: "history", kind: "report", key })) as {
		items: unknown[];
		nextCursor: number;
	};
	assert.equal(first.items.length, 1);
	assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 64 * 1024);
	const second = (await f.store.insights.call(admission, {
		action: "history",
		kind: "report",
		key,
		cursor: first.nextCursor,
	})) as { items: unknown[]; nextCursor: null };
	assert.equal(second.items.length, 1);
	assert.equal(second.nextCursor, null);
	assert.ok(Buffer.byteLength(JSON.stringify(second)) <= 64 * 1024);
});
