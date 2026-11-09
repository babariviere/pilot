import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type {
	ChangeLandingResult,
	DurableOperation,
	NativeReviewCaptureStatus,
	NativeReviewSnapshot,
	ReviewDispositionPayload,
	ReviewDispositionTarget,
} from "@pilot/protocol";
import { dispositionTarget, HumanReviews } from "./human-reviews.ts";
import { LandedChanges } from "./landed-changes.ts";
import { MissionStore } from "./missions.ts";
import { canonicalJSON, payloadHash } from "./operation-journal.ts";
import { ReviewRequests } from "./review-requests.ts";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function snapshot(n = 1): NativeReviewSnapshot {
	return {
		snapshotId: hash(`snapshot${n}`),
		workerId: "worker",
		enrollmentTaskIds: [],
		enrollmentProjectId: "project",
		capturedAt: n,
		status: "complete",
		omissions: [],
		before: [],
		after: [],
		changes: [],
		diff: { sha256: hash("patch"), bytes: 5 },
		creation: {
			kind: "workspace-created",
			changeId: "k".repeat(32),
			commitId: "a".repeat(40),
			operationId: "a".repeat(128),
		},
		request: {
			requestId: `capture${n}`,
			repositoryId: "b".repeat(64),
			changeId: "k".repeat(32),
			operationId: "a".repeat(128),
			base: { changeId: "l".repeat(32), commitId: "c".repeat(40) },
			head: { changeId: "k".repeat(32), commitId: n.toString(16).padStart(40, "0") },
			scope: { kind: "layer" },
			source: "committed",
		},
	};
}
const proof = (s: NativeReviewSnapshot): ChangeLandingResult => ({
	status: "observed",
	observedAt: 1234,
	repository: "github.com/octo/repo",
	defaultRef: "main",
	targetCommitId: "d".repeat(40),
	integratedCommitId: s.request.head.commitId,
	producer: { kind: "default-branch-containment" },
});
async function fixture(t: TestContext, disk = false) {
	const dir = await mkdtemp(join(tmpdir(), "landed-changes-"));
	const file = disk ? join(dir, "missions.sqlite") : ":memory:";
	let store = new MissionStore(file),
		allowed = true,
		custody = 1;
	const snapshots = new Map([[snapshot().snapshotId, snapshot()]]);
	const state = {
		capture: { pending: 0, failed: 0 } as NativeReviewCaptureStatus | undefined,
		unavailable: undefined as string | undefined,
		observe: async (s: NativeReviewSnapshot): Promise<ChangeLandingResult> => proof(s),
		calls: 0,
		duringFeedback: undefined as (() => void | Promise<void>) | undefined,
		feedbackReady: false,
		denied: new Set<string>(),
	};
	const authorize = () => {
		const revision = custody;
		const revalidate = () => {
			if (!allowed || custody !== revision) throw new Error("Access changed");
		};
		revalidate();
		return { revalidate };
	};
	const get = async (id: string) => {
		authorize();
		const s = snapshots.get(id);
		if (!s || state.denied.has(id)) throw new Error("Unavailable capture");
		return structuredClone(s);
	};
	const comparison = (s: NativeReviewSnapshot) => ({
		snapshotId: s.snapshotId,
		sequence: s.capturedAt,
		capturedAt: s.capturedAt,
		status: s.status,
		request: structuredClone(s.request),
	});
	const qualify = async (target: ReviewDispositionTarget) => {
		const access = authorize(),
			s = await get(target.snapshotId);
		assert.deepEqual(dispositionTarget("project", s), target);
		return {
			snapshot: s,
			fence: `custody${custody}`,
			revalidate: access.revalidate,
			read: async () => new Uint8Array(),
		};
	};
	const feedback = () =>
		new HumanReviews({
			store: store.humanReviews,
			qualify,
			prerequisites: async () => ({
				state: state.feedbackReady ? "passed" : "unavailable",
				identity: "checks",
				revalidate() {},
			}),
			requirement: () => ({ state: "not_requested", identity: "optional" }),
		});
	const requests = () =>
		new ReviewRequests({
			store: store.reviewRequests,
			authorize,
			qualify: async (target) => ({
				...(await qualify(target)),
				comparison: comparison(await get(target.snapshotId)),
			}),
		});
	const feed = () =>
		new LandedChanges({
			projectId: "project",
			store: store.changeLandings,
			authorize,
			reader: {
				retainedHistory: async (id) => {
					const access = authorize(),
						s = await get(id);
					return { snapshot: s, comparison: comparison(s), revalidate: access.revalidate };
				},
				list: async (after) =>
					state.unavailable
						? { comparisons: [], next: null, unavailable: state.unavailable }
						: {
								comparisons: [...snapshots.values()]
									.filter((s) => s.capturedAt > after)
									.slice(0, 20)
									.map(comparison),
								next: snapshots.size > after + 20 ? after + 20 : null,
								capture: state.capture,
							},
			},
			feedback: {
				history: async (target, after) => {
					const rows = await feedback().history(target, after);
					await state.duringFeedback?.();
					return rows;
				},
			},
			requests: store.reviewRequests,
			observe: async (s) => {
				state.calls++;
				return state.observe(s);
			},
			reported: (target) => ({
				status: "reported",
				claims: [{ taskId: "task", commit: target.headCommitId, recordedAt: 1 }],
			}),
		});
	const submit = async (disposition: ReviewDispositionPayload["disposition"], s = snapshot()) => {
		const request = await feedback().prepare({
			purpose: "review-disposition",
			targets: [dispositionTarget("project", s)],
			disposition,
			body: "Exact feedback",
			expectedPriorRecordId: null,
			packageDigest: "0".repeat(64),
		});
		const payload = canonicalJSON(request),
			host = { hostId: "daemon", daemonId: "host", lineageId: "lineage" };
		const op: DurableOperation = {
			schemaVersion: 1,
			operationId: randomUUID(),
			producerId: "native-app",
			sequence: 1,
			origin: host,
			destination: host,
			kind: "review-disposition",
			targetId: request.packageDigest,
			payload,
			payloadHash: payloadHash(payload),
		};
		return feedback().record(op, request);
	};
	t.after(async () => {
		await store.durable();
		store.close();
		await rm(dir, { recursive: true, force: true });
	});
	return {
		snapshots,
		state,
		feed,
		submit,
		requests,
		get store() {
			return store;
		},
		revoke() {
			custody++;
		},
		deny() {
			allowed = false;
		},
		async reopen() {
			await store.durable();
			store.close();
			store = new MissionStore(file);
		},
	};
}

test("reported, landed, reviewed, approved and deferred remain separate facts", async (t) => {
	const f = await fixture(t),
		s = snapshot();
	const before = await f.feed().open(s.snapshotId);
	assert.equal(before.reported.status, "reported");
	assert.deepEqual(before.landing.records, []);
	assert.equal(f.state.calls, 0);
	const comment = await f.submit("comment");
	const suggested = await f.requests().suggest(
		{ kind: "native-user" },
		{
			operationId: randomUUID(),
			target: before.target,
			title: "Review this comparison",
			reason: "Optional review",
			replacesRequestId: null,
			replacesExpectedRevision: null,
		},
	);
	await f.requests().transition({ kind: "native-user" }, "snooze", {
		operationId: randomUUID(),
		requestId: suggested.requestId,
		expectedRevision: 1,
		reason: "Later",
	});
	const landed = await f.feed().observe("observe-1", s.snapshotId);
	const opened = await f.feed().open(s.snapshotId);
	assert.deepEqual(opened.target, before.target);
	assert.deepEqual(opened.snapshot, s);
	assert.deepEqual(opened.landing.records, [landed]);
	assert.equal(opened.reviews.records[0]!.record.id, comment.recordId);
	assert.equal(opened.reviews.records[0]!.record.confirmed.disposition, "comment");
	assert.equal(opened.attention.records[0]!.state, "snoozed");
	assert.equal(opened.attention.records[0]!.revision, 2);
	assert.equal(opened.approval, "not-evaluated");
	assert.equal(opened.acceptance, "not-evaluated");
	assert.equal(f.state.calls, 1);
	assert.equal((await f.feed().page()).scope, "retained-comparisons-only");
});

test("reopen preserves approvals and terminal requests without restoring authority", async (t) => {
	const f = await fixture(t),
		s = snapshot(),
		target = dispositionTarget("project", s);
	f.state.feedbackReady = true;
	await f.submit("approve");
	f.state.feedbackReady = false;
	const a = await f.requests().suggest(
		{ kind: "native-user" },
		{
			operationId: randomUUID(),
			target,
			title: "Review",
			reason: "Optional",
			replacesRequestId: null,
			replacesExpectedRevision: null,
		},
	);
	await f.requests().transition({ kind: "native-user" }, "withdraw", {
		operationId: randomUUID(),
		requestId: a.requestId,
		expectedRevision: 1,
		reason: "Withdrawn",
	});
	for (let i = 0; i < 2; i++) {
		const opened = await f.feed().open(s.snapshotId);
		assert.equal(opened.reviews.records[0]!.record.confirmed.disposition, "approve");
		assert.equal(opened.attention.records[0]!.state, "withdrawn");
		assert.equal(opened.approval, "not-evaluated");
	}
	await assert.rejects(f.submit("approve"), /checks|review|unavailable/i);
	await assert.rejects(
		f.requests().transition({ kind: "native-user" }, "resume", {
			operationId: randomUUID(),
			requestId: a.requestId,
			expectedRevision: 2,
			reason: "No revival",
		}),
	);
	const newer = snapshot(2);
	f.snapshots.set(newer.snapshotId, newer);
	const opened = await f.feed().open(newer.snapshotId);
	assert.deepEqual(opened.reviews.records, []);
	assert.deepEqual(opened.attention.records, []);
});

test("unavailable capture is not empty; enrollment is not a complete inventory", async (t) => {
	const f = await fixture(t);
	f.state.unavailable = "Not captured";
	assert.equal((await f.feed().page()).status, "unavailable");
	f.state.unavailable = undefined;
	f.snapshots.clear();
	f.state.capture = undefined;
	assert.equal((await f.feed().page()).status, "unavailable");
	for (const capture of [
		{ pending: 0, failed: 0, unavailable: "not-enabled" as const },
		{ pending: 1, failed: 0 },
		{ pending: 0, failed: 1 },
	]) {
		f.state.capture = capture;
		assert.equal((await f.feed().page()).status, "unavailable");
	}
	f.state.capture = { pending: 0, failed: 0 };
	assert.equal((await f.feed().page()).status, "available");
	const s = snapshot();
	f.snapshots.set(s.snapshotId, s);
	s.status = "unavailable";
	s.diff = null;
	assert.deepEqual((await f.feed().page()).changes, [{ snapshotId: s.snapshotId, sequence: 1, unavailable: true }]);
	await assert.rejects(f.feed().open(s.snapshotId), /patch unavailable/i);
	s.status = "complete";
	s.diff = { sha256: hash("empty"), bytes: 0 };
	assert.deepEqual((await f.feed().open(s.snapshotId)).snapshot.changes, []);
});

test("observations survive restart; exact retries never probe another target", async (t) => {
	const f = await fixture(t, true),
		s = snapshot();
	const first = await f.feed().observe("exact-observation", s.snapshotId);
	await f.reopen();
	f.state.observe = async () => {
		throw new Error("Must not reobserve");
	};
	assert.deepEqual(await f.feed().observe("exact-observation", s.snapshotId), first);
	assert.equal(f.state.calls, 1);
	assert.deepEqual((await f.feed().open(s.snapshotId)).landing.records, [first]);
	const newer = snapshot(2);
	f.snapshots.set(newer.snapshotId, newer);
	await assert.rejects(f.feed().observe("exact-observation", newer.snapshotId), /identity changed/);
	assert.deepEqual((await f.feed().open(newer.snapshotId)).landing.records, []);
});

test("unknown, stale and negative observations never erase historical landing", async (t) => {
	const f = await fixture(t),
		s = snapshot();
	await f.feed().observe("observed", s.snapshotId);
	const observations: ChangeLandingResult[] = [
		{ status: "unknown", reason: "Offline" },
		{ status: "stale", reason: "Moved" },
		{ ...proof(s), status: "not-contained" } as ChangeLandingResult,
	];
	for (const [n, result] of observations.entries()) {
		f.state.observe = async () => result;
		await f.feed().observe(`negative${n}`, s.snapshotId);
	}
	assert.deepEqual(
		(await f.feed().open(s.snapshotId)).landing.records.map((r) => r.result.status),
		["observed", "unknown", "stale", "not-contained"],
	);
	const row = (await f.feed().page()).changes[0]!;
	assert.ok("comparison" in row);
	assert.equal(row.landing!.result.status, "not-contained");
	assert.equal(row.observedLanding!.result.status, "observed");
});

test("failed durability acknowledgement recovers the exact record without a new probe", async (t) => {
	const f = await fixture(t, true),
		s = snapshot();
	const durable = f.store.changeLandings.durable.bind(f.store.changeLandings);
	const failure = t.mock.method(f.store.changeLandings, "durable", async () => {
		throw new Error("Lost durability ACK");
	});
	await assert.rejects(f.feed().observe("lost-ack", s.snapshotId), /Lost durability ACK/);
	failure.mock.restore();
	await durable();
	await f.reopen();
	assert.equal((await f.feed().observe("lost-ack", s.snapshotId)).result.status, "observed");
	assert.equal(f.state.calls, 1);
});

test("a changed attention revision refuses history instead of returning stale deferral", async (t) => {
	const f = await fixture(t),
		s = snapshot();
	const request = await f.requests().suggest(
		{ kind: "native-user" },
		{
			operationId: randomUUID(),
			target: dispositionTarget("project", s),
			title: "Review",
			reason: "Optional",
			replacesRequestId: null,
			replacesExpectedRevision: null,
		},
	);
	f.state.duringFeedback = async () => {
		await f.requests().transition({ kind: "native-user" }, "snooze", {
			operationId: randomUUID(),
			requestId: request.requestId,
			expectedRevision: 1,
			reason: "Later",
		});
	};
	await assert.rejects(f.feed().open(s.snapshotId), /changed during read/);
	f.state.duringFeedback = undefined;
	assert.equal((await f.feed().open(s.snapshotId)).attention.records[0]!.state, "snoozed");
});

test("source fences recheck after asynchronous reads and observation", async (t) => {
	const f = await fixture(t),
		s = snapshot();
	f.state.observe = async (s) => {
		f.revoke();
		return proof(s);
	};
	await assert.rejects(f.feed().observe("revoked", s.snapshotId), /Access changed/);
	assert.equal(f.store.changeLandings.latest(dispositionTarget("project", s)), null);
	f.state.duringFeedback = () => f.revoke();
	await assert.rejects(f.feed().open(s.snapshotId), /Access changed/);
	f.state.duringFeedback = undefined;
	f.state.denied.add(s.snapshotId);
	assert.deepEqual((await f.feed().page()).changes, [{ snapshotId: s.snapshotId, sequence: 1, unavailable: true }]);
	await assert.rejects(f.feed().open(s.snapshotId), /Unavailable capture/);
	f.deny();
	await assert.rejects(f.feed().page(), /Access changed/);
});

test("working-copy and wrong-revision evidence cannot become observed landing", async (t) => {
	const f = await fixture(t),
		s = f.snapshots.get(snapshot().snapshotId)!;
	s.request.source = "working-copy";
	const workingTarget = dispositionTarget("project", s);
	assert.equal((await f.feed().observe("working", s.snapshotId)).result.status, "unknown");
	assert.equal(f.state.calls, 0);
	s.request.source = "committed";
	f.state.observe = async () => proof(snapshot(2));
	await assert.rejects(f.feed().observe("wrong", s.snapshotId), /does not match/);
	assert.equal(f.store.changeLandings.history(workingTarget).records.length, 1);
	assert.equal(f.store.changeLandings.history(dispositionTarget("project", s)).records.length, 0);
});

test("landing and comparison pages preserve stable cursors", async (t) => {
	const f = await fixture(t),
		s = snapshot();
	for (let n = 0; n < 22; n++) await f.feed().observe(`observation${n}`, s.snapshotId);
	const first = await f.feed().open(s.snapshotId);
	assert.equal(first.landing.records.length, 20);
	assert.ok(first.landing.next);
	const second = await f.feed().open(s.snapshotId, first.landing.next);
	assert.equal(second.landing.records.length, 2);
	assert.equal(second.landing.next, null);
	assert.equal(new Set([...first.landing.records, ...second.landing.records].map((r) => r.observationId)).size, 22);
	for (let n = 2; n <= 22; n++) {
		const s = snapshot(n);
		f.snapshots.set(s.snapshotId, s);
	}
	const page = await f.feed().page();
	assert.equal(page.changes.length, 20);
	assert.equal(page.next, 20);
	assert.equal((await f.feed().page(page.next)).changes.length, 2);
	await assert.rejects(f.feed().page(-1), /cursor/);
	await assert.rejects(f.feed().open(s.snapshotId, NaN), /cursor/);
});

test("store and durability failures refuse a page rather than masquerading as unavailable source", async (t) => {
	const f = await fixture(t);
	const failure = t.mock.method(f.store.changeLandings, "latest", () => {
		throw new Error("Store failure");
	});
	await assert.rejects(f.feed().page(), /Store failure/);
	failure.mock.restore();
	t.mock.method(f.store.changeLandings, "durable", async () => {
		throw new Error("Barrier failure");
	});
	await assert.rejects(f.feed().page(), /Barrier failure/);
});
