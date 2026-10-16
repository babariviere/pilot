import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { CriticalReviewRecord } from "@pilot/protocol";
import { CriticalReviewStore } from "./critical-review-store.ts";
import { ReviewStore } from "./reviews.ts";

const base = { schemaVersion: 1, projectId: "project", hostId: "host", sourceIds: ["source"], createdAt: 100 } as const;
const allowance = { moneyMicros: 1_000_000, inputTokens: 32_000, generatedTokens: 6000, durationMs: 120_000 };
const citation = { manifestId: "evidence", blobId: "blob", start: 0, end: 10 };
const records: CriticalReviewRecord[] = [
	{
		...base,
		sourceIds: ["source"],
		id: "target",
		kind: "target",
		snapshot: {
			kind: "session",
			sessionId: "session",
			attemptId: "attempt",
			lineageId: "lineage",
			boundary: 1,
			treeDigest: "digest",
		},
	},
	{
		...base,
		sourceIds: ["source"],
		id: "evidence",
		kind: "evidence",
		sealed: true,
		sha256: "a".repeat(64),
		entries: [],
		omissions: [],
		complete: false,
	},
	{
		...base,
		sourceIds: ["source"],
		id: "context",
		kind: "context",
		policyVersion: "v1",
		challenge: "balanced",
		sources: [{ citation, basis: "preference", approvalId: "approval" }],
		missing: [],
		conflicts: [],
	},
	{
		...base,
		sourceIds: ["source"],
		id: "run",
		kind: "run",
		targetId: "target",
		evidenceId: "evidence",
		contextId: "context",
		state: "queued",
		effort: "session",
		modelId: "fake",
		policyVersion: "v1",
		limits: [],
	},
	{
		...base,
		sourceIds: ["source"],
		id: "approval",
		kind: "approval",
		ownerId: "owner",
		runId: "run",
		targetId: "target",
		evidenceId: "evidence",
		action: "app_allowance",
		providerId: "fake",
		modelId: "fake",
		billing: "api",
		allowance,
		expiresAt: 1000,
	},
	{
		...base,
		sourceIds: ["source"],
		id: "reservation",
		kind: "reservation",
		runId: "run",
		approvalId: "approval",
		callId: "call",
		rateId: "rate",
		phase: "analysis",
		reserved: allowance,
	},
	{
		...base,
		sourceIds: ["source"],
		id: "finding",
		kind: "finding",
		runId: "run",
		severity: "high",
		confidence: "medium",
		title: "Finding",
		trigger: "trigger",
		expected: "expected",
		actual: "actual",
		consequence: "consequence",
		evidence: [citation],
		counterevidence: [],
		basis: "requirement",
		verification: "not_reverified",
	},
	{
		...base,
		sourceIds: ["source"],
		id: "disposition",
		kind: "disposition",
		findingId: "finding",
		ownerId: "owner",
		value: "questioned",
	},
];

test("separate versioned records round-trip, immutable/idempotent across restart", async () => {
	const home = await mkdtemp(join(tmpdir(), "critical-review-"));
	const file = join(home, "critical", "records.sqlite");
	let store = new CriticalReviewStore(file, () => 100);
	try {
		for (const record of records) {
			assert.deepEqual(await store.put(record), record);
			assert.deepEqual(await store.put(record), record);
		}
		await assert.rejects(store.put({ ...records[0]!, createdAt: 101 }), /Immutable/);
		await assert.rejects(
			store.put({ ...records[0]!, schemaVersion: 2 } as unknown as CriticalReviewRecord),
			/version/,
		);
		await assert.rejects(store.list("target", "", 101), /page/);
		assert.equal((await stat(file)).mode & 0o777, 0o600);
		await store.close();
		store = new CriticalReviewStore(file, () => 100);
		for (const record of records) assert.deepEqual(await store.get(record.kind, record.id), record);
		assert.deepEqual(await store.list("finding"), [records[6]]);
		const marks = new ReviewStore(home);
		assert.equal(marks.isUnread("session", 100), true);
		marks.mark([{ sessionId: "session", outcomeAt: 100 }]);
		await marks.flush();
		assert.equal(marks.isUnread("session", 100), false);
		assert.deepEqual(await store.get("finding", "finding"), records[6]);
	} finally {
		await store.close();
		await rm(home, { recursive: true, force: true });
	}
});

test("empty legacy database migrates idempotently; future versions fail closed", async () => {
	const home = await mkdtemp(join(tmpdir(), "critical-migration-"));
	const file = join(home, "records.sqlite");
	try {
		new DatabaseSync(file).close();
		for (let i = 0; i < 2; i++) {
			const store = new CriticalReviewStore(file);
			assert.deepEqual(await store.list("run"), []);
			await store.close();
		}
		const db = new DatabaseSync(file);
		assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 3);
		db.exec("PRAGMA user_version=99");
		db.close();
		const future = new CriticalReviewStore(file);
		await assert.rejects(future.list("run"), /Unsupported/);
		await future.close().catch(() => {});
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
