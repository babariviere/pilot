import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { NativeReviewSnapshot, ReviewRequestSuggestion } from "@pilot/protocol";
import { dispositionTarget, HumanReviews } from "./human-reviews.ts";
import { MissionStore } from "./missions.ts";
import { canonicalJSON, payloadHash } from "./operation-journal.ts";
import type { ReviewRequestActor } from "./review-request-store.ts";
import { ReviewRequests } from "./review-requests.ts";

const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const native: ReviewRequestActor = { kind: "native-user" };
const coordinator: ReviewRequestActor = { kind: "coordinator", sessionId: "lead", missionId: "mission" };
function snapshot(n = 1, sessionId = "worker"): NativeReviewSnapshot {
	return {
		snapshotId: hash(`${n}-${sessionId}`),
		workerId: sessionId,
		enrollmentTaskIds: [],
		capturedAt: n,
		creation: {
			changeId: "k".repeat(32),
			commitId: "a".repeat(40),
			operationId: "a".repeat(128),
			kind: "workspace-created",
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
		status: "complete",
		omissions: [],
		before: [],
		after: [],
		changes: [],
		diff: { sha256: hash("patch"), bytes: 5 },
	};
}
async function fixture(t: TestContext, disk = false) {
	const root = await mkdtemp(join(tmpdir(), "review-requests-")),
		file = disk ? join(root, "missions.sqlite") : ":memory:";
	let store = new MissionStore(file),
		allowed = true,
		authority = 1,
		custody = 1;
	let duringQualify: (() => void) | undefined;
	const snapshots = new Map<string, NativeReviewSnapshot>();
	const qualify = async (target: ReturnType<typeof dispositionTarget>) => {
		const observed = custody;
		const s = snapshots.get(target.snapshotId);
		if (!s) throw new Error("Exact retained source unavailable");
		duringQualify?.();
		const revalidate = () => {
			if (!allowed || observed !== custody) throw new Error("Custody unavailable");
		};
		revalidate();
		return {
			snapshot: structuredClone(s),
			fence: `${observed}`,
			revalidate,
			read: async () => new Uint8Array(),
			comparison: {
				snapshotId: s.snapshotId,
				sequence: 100 + s.capturedAt,
				capturedAt: s.capturedAt,
				request: s.request,
				status: s.status,
			},
		};
	};
	const source = () =>
		new ReviewRequests({
			store: store.reviewRequests,
			qualify,
			authorize(actor, target) {
				const observed = authority;
				const revalidate = () => {
					if (!allowed || observed !== authority) throw new Error("Authority changed");
					if (
						actor.kind === "coordinator" &&
						(actor.sessionId !== "lead" || actor.missionId !== "mission" || target.sessionId !== "worker")
					)
						throw new Error("Not current same-mission coordinator/member");
				};
				revalidate();
				return { revalidate };
			},
		});
	const add = (n = 1, sessionId = "worker") => {
		const s = snapshot(n, sessionId);
		snapshots.set(s.snapshotId, s);
		return dispositionTarget("project", s);
	};
	const suggestion = (n = 1, sessionId = "worker"): ReviewRequestSuggestion => ({
		operationId: randomUUID(),
		target: add(n, sessionId),
		title: "Look at ordering",
		reason: "Optional feedback requested",
		replacesRequestId: null,
		replacesExpectedRevision: null,
	});
	t.after(async () => {
		await store.durable();
		store.close();
		await rm(root, { recursive: true, force: true });
	});
	return {
		get store() {
			return store;
		},
		source,
		suggestion,
		snapshots,
		qualify,
		allow(v: boolean) {
			allowed = v;
		},
		revokeAuthority() {
			authority++;
		},
		revokeCustody() {
			custody++;
		},
		during(v?: () => void) {
			duringQualify = v;
		},
		async reopen() {
			await store.durable();
			store.close();
			store = new MissionStore(file);
		},
	};
}
const transition = (requestId: string, expectedRevision: number) => ({
	operationId: randomUUID(),
	requestId,
	expectedRevision,
	reason: "Explicit action",
});

test("only explicit suggestions produce a durable queue; exact retry/dedup survives reopen and lost reply", async (t) => {
	const f = await fixture(t, true),
		input = f.suggestion();
	assert.deepEqual(await f.source().page(), { requests: [], next: null });
	assert.equal(f.store.reviewRequests.requirement(input.target).state, "not_requested");
	const [a, b] = await Promise.all([f.source().suggest(native, input), f.source().suggest(native, input)]);
	assert.deepEqual(a, b);
	assert.deepEqual(a.actor, native);
	assert.equal(a.payloadHash, payloadHash(canonicalJSON({ action: "suggest", ...input })));
	assert.equal(f.store.reviewRequests.requirement(input.target).state, "requested");
	await f.reopen();
	assert.deepEqual(await f.source().lookup(input.operationId, native), a);
	assert.deepEqual(await f.source().suggest(native, input), a);
	const dedup = await f.source().suggest(native, { ...input, operationId: randomUUID() });
	assert.equal(dedup.requestId, a.requestId);
	const page = await f.source().page();
	assert.equal(page.requests.length, 1);
	assert.equal(page.requests[0].sequence, 1);
	assert.equal(page.requests[0].comparison.sequence, 101);
	assert.equal(page.requests[0].actionability, "unknown");
	await assert.rejects(f.source().suggest(native, { ...input, title: "Different bytes" }), /payload changed/);
	await assert.rejects(f.source().suggest(coordinator, input), /actor or payload changed/);
	assert.equal(await f.source().lookup("missing", native), null);
});

test("native snooze/resume/withdraw are revision-CAS attention only, with immutable historical recovery", async (t) => {
	const f = await fixture(t),
		input = f.suggestion(),
		source = f.source();
	const a = await source.suggest(native, input),
		before = f.store.reviewRequests.requirement(input.target);
	const snooze = transition(a.requestId, 1);
	await source.transition(native, "snooze", snooze);
	assert.equal((await source.page()).requests[0].state, "snoozed");
	assert.equal(f.store.reviewRequests.requirement(input.target).state, "requested");
	assert.notEqual(f.store.reviewRequests.requirement(input.target).identity, before.identity);
	await assert.rejects(source.transition(native, "resume", transition(a.requestId, 1)), /revision changed/);
	await source.transition(native, "resume", transition(a.requestId, 2));
	await source.transition(native, "withdraw", transition(a.requestId, 3));
	assert.equal(f.store.reviewRequests.requirement(input.target).state, "withdrawn");
	assert.deepEqual(await source.suggest(native, input), a);
	assert.equal((await source.page()).requests[0].state, "withdrawn");
	await source.transition(native, "snooze", snooze); // original receipt, never snoozes again
	assert.equal(f.store.reviewRequests.get(a.requestId)!.state, "withdrawn");
	const duplicate = await source.suggest(native, { ...input, operationId: randomUUID() });
	assert.equal(duplicate.requestId, a.requestId);
	assert.equal(duplicate.state, "withdrawn");
	await assert.rejects(
		source.transition(native, "resume", transition(a.requestId, 4)),
		/Unsupported request transition/,
	);
	const history = await source.history(a.requestId);
	assert.deepEqual(
		history.map((r) => r.state),
		["pending", "snoozed", "pending", "withdrawn"],
	);
	assert.equal(history[0].reason, input.reason);
	assert.equal(f.store.humanReviews.targetState(input.target).latestRecordId, null);
});

test("replacement preserves exact histories and lineage, not approval or another actor's suggestion", async (t) => {
	const f = await fixture(t, true),
		first = f.suggestion();
	let source = f.source();
	const a = await source.suggest(coordinator, first);
	const next = { ...f.suggestion(2), replacesRequestId: a.requestId, replacesExpectedRevision: 1 };
	await assert.rejects(source.suggest(native, next), /Replacement lineage/);
	const wrong = { ...next, target: { ...next.target, layer: "stack" as const } };
	await assert.rejects(source.suggest(coordinator, wrong), /Exact request comparison/);
	const stack = snapshot(3);
	stack.request.scope.kind = "stack";
	f.snapshots.set(stack.snapshotId, stack);
	await assert.rejects(
		source.suggest(coordinator, { ...next, operationId: randomUUID(), target: dispositionTarget("project", stack) }),
		/Replacement lineage/,
	);
	const b = await source.suggest(coordinator, next);
	assert.equal(f.store.reviewRequests.get(a.requestId)!.state, "replaced");
	assert.equal(f.store.reviewRequests.get(a.requestId)!.replacedByRequestId, b.requestId);
	assert.equal(f.store.reviewRequests.get(b.requestId)!.state, "pending");
	assert.equal(f.store.reviewRequests.requirement(first.target).state, "withdrawn");
	assert.equal(f.store.reviewRequests.requirement(next.target).state, "requested");
	await f.reopen();
	source = f.source();
	assert.deepEqual(await source.lookup(first.operationId, coordinator), a);
	assert.equal(f.store.reviewRequests.get(a.requestId)!.state, "replaced");
	assert.equal((await source.history(a.requestId))[0].target.snapshotId, first.target.snapshotId);
	assert.equal(f.store.humanReviews.targetState(next.target).latestRecordId, null);
	await assert.rejects(
		source.suggest(coordinator, { ...f.suggestion(3), replacesRequestId: a.requestId, replacesExpectedRevision: 1 }),
		/Replacement lineage/,
	);
});

test("duplicate replacements keep the original predecessor revision through historical recovery and withdrawal", async (t) => {
	const f = await fixture(t, true),
		first = f.suggestion();
	let source = f.source();
	const a = await source.suggest(native, first);
	const next = { ...f.suggestion(2), replacesRequestId: a.requestId, replacesExpectedRevision: 1 };
	const b = await source.suggest(native, next);
	const wrong = { ...next, operationId: randomUUID(), replacesExpectedRevision: 999 };
	const before = await source.page();
	await assert.rejects(source.suggest(native, wrong), /different content/);
	assert.equal(f.store.reviewRequests.operation(wrong.operationId), undefined);
	assert.deepEqual(await source.page(), before);
	await assert.rejects(source.suggest(native, { ...next, replacesExpectedRevision: 999 }), /payload changed/);
	assert.deepEqual(await source.suggest(native, next), b);
	const duplicate = await source.suggest(native, { ...next, operationId: randomUUID() });
	assert.equal(duplicate.requestId, b.requestId);
	assert.equal(duplicate.state, "pending");
	await source.transition(native, "withdraw", transition(b.requestId, 1));
	await f.reopen();
	source = f.source();
	assert.deepEqual(await source.suggest(native, next), b);
	const withdrawn = await source.suggest(native, { ...next, operationId: randomUUID() });
	assert.equal(withdrawn.requestId, b.requestId);
	assert.equal(withdrawn.state, "withdrawn");
	assert.equal(withdrawn.revision, 2);
	const wrongAfterWithdrawal = { ...wrong, operationId: randomUUID() };
	await assert.rejects(source.suggest(native, wrongAfterWithdrawal), /different content/);
	assert.equal(f.store.reviewRequests.operation(wrongAfterWithdrawal.operationId), undefined);
	assert.equal(f.store.reviewRequests.get(a.requestId)!.state, "replaced");
	assert.equal(f.store.reviewRequests.get(b.requestId)!.state, "withdrawn");
	assert.equal((await source.history(b.requestId)).length, 2);
});

test("native and coordinator origins deduplicate separately; coordinator retires only its own suggestion", async (t) => {
	const f = await fixture(t),
		source = f.source(),
		input = f.suggestion();
	const user = await source.suggest(native, input);
	const own = await source.suggest(coordinator, { ...input, operationId: randomUUID() });
	assert.notEqual(own.requestId, user.requestId);
	await assert.rejects(
		source.transition(coordinator, "retire", transition(user.requestId, 1)),
		/original coordinator/,
	);
	await assert.rejects(source.transition(coordinator, "withdraw", transition(own.requestId, 1)), /actor\/action/);
	await source.transition(coordinator, "retire", transition(own.requestId, 1));
	assert.equal(f.store.reviewRequests.requirement(input.target).state, "requested");
	await assert.rejects(source.suggest(coordinator, f.suggestion(2, "standalone")), /same-mission/);
	await source.suggest(native, f.suggestion(2, "standalone"));
});

test("global pages are bounded, equality-only, independent of comparison sequence, and never hide snoozed work", async (t) => {
	const f = await fixture(t),
		source = f.source();
	for (let i = 1; i <= 23; i++) await source.suggest(native, f.suggestion(i, i % 2 ? "worker" : "standalone"));
	const first = await source.page(),
		second = await source.page(first.next!);
	assert.equal(first.requests.length, 20);
	assert.equal(first.next, 20);
	assert.equal(second.requests.length, 3);
	assert.equal(second.next, null);
	assert.equal((await source.page(0, "worker")).requests.length, 12);
	assert.deepEqual(await source.page(0, "work"), { requests: [], next: null });
	await assert.rejects(source.page(-1), /cursor/);
	await assert.rejects(source.page(0, "worker*"), /identifier/i);
});

test("stale/offline sources and later row or authority changes refuse instead of fake empty or unsaved positives", async (t) => {
	const f = await fixture(t),
		source = f.source(),
		a = f.suggestion(),
		b = f.suggestion(2);
	await source.suggest(native, a);
	await source.suggest(native, b);
	f.allow(false);
	await assert.rejects(source.page(), /Authority/);
	await assert.rejects(source.lookup(a.operationId, native), /Authority/);
	f.allow(true);
	f.snapshots.delete(a.target.snapshotId);
	await assert.rejects(source.page(), /source unavailable/);
	f.snapshots.set(a.target.snapshotId, snapshot());
	let n = 0;
	f.during(() => {
		if (++n === 2) f.revokeAuthority();
	});
	await assert.rejects(source.page(), /Authority changed/);
	f.during();
	const originalDurable = f.store.reviewRequests.durable.bind(f.store.reviewRequests);
	t.mock.method(f.store.reviewRequests, "durable", async () => {
		await originalDurable();
		f.revokeAuthority();
	});
	await assert.rejects(source.lookup(a.operationId, native), /Authority changed/);
});

test("durability barrier failure leaves an exact effect recoverable without replay", async (t) => {
	const f = await fixture(t, true),
		source = f.source(),
		input = f.suggestion();
	const original = f.store.reviewRequests.durable.bind(f.store.reviewRequests);
	let calls = 0;
	const mock = t.mock.method(f.store.reviewRequests, "durable", async () => {
		await original();
		if (++calls === 2) throw new Error("Lost ACK");
	});
	await assert.rejects(source.suggest(native, input), /Lost ACK/);
	mock.mock.restore();
	await f.reopen();
	const receipt = await f.source().lookup(input.operationId, native);
	assert.ok(receipt);
	assert.deepEqual(await f.source().suggest(native, input), receipt);
	assert.equal((await f.source().page()).requests.length, 1);
});

test("positive reads refuse row changes during durable and never select a later unsaved latest", async (t) => {
	const f = await fixture(t),
		input = f.suggestion(),
		source = f.source();
	const a = await source.suggest(native, input);
	const original = f.store.reviewRequests.durable.bind(f.store.reviewRequests);
	let changed = false;
	const mock = t.mock.method(f.store.reviewRequests, "durable", async () => {
		await original();
		if (!changed) {
			changed = true;
			// Synchronous write after the invocation barrier, deliberately not flushed here.
			f.store.reviewRequests.transition(
				randomUUID(),
				native,
				"test-only-transition",
				a.requestId,
				1,
				"withdrawn",
				"Concurrent explicit withdrawal",
				() => {},
			);
		}
	});
	await assert.rejects(source.page(), /request changed during read/);
	mock.mock.restore();
	assert.equal((await source.page()).requests[0].state, "withdrawn");
	assert.equal(
		(await source.lookup(input.operationId, native))!.state,
		"pending",
		"immutable receipt, not latest state",
	);
});

test("lookup pins absence before durability rather than returning a later unsaved operation", async (t) => {
	const f = await fixture(t),
		input = f.suggestion(),
		source = f.source();
	const comparison = (await f.qualify(input.target)).comparison;
	const original = f.store.reviewRequests.durable.bind(f.store.reviewRequests);
	const mock = t.mock.method(f.store.reviewRequests, "durable", async () => {
		await original();
		f.store.reviewRequests.suggest(
			input.operationId,
			native,
			canonicalJSON({ action: "suggest", ...input }),
			{ ...input, comparison },
			() => {},
		);
	});
	await assert.rejects(source.lookup(input.operationId, native), /operation changed during lookup/);
	mock.mock.restore();
	assert.ok(await source.lookup(input.operationId, native));
});

test("withdrawal and coordinator retirement cannot resolve human threads or clear change requests", async (t) => {
	const f = await fixture(t),
		input = f.suggestion();
	const reviews = new HumanReviews({
		store: f.store.humanReviews,
		qualify: f.qualify,
		requirement: (target) => f.store.reviewRequests.requirement(target),
	});
	const request = await reviews.prepare({
		purpose: "review-disposition",
		targets: [input.target],
		disposition: "request_changes",
		body: "Keep this blocker",
		expectedPriorRecordId: null,
		packageDigest: "0".repeat(64),
		feedback: {
			draft: null,
			annotations: [
				{
					id: "human-thread",
					body: "Human owns resolution",
					supersedes: null,
					anchor: { kind: "summary", snapshotId: input.target.snapshotId },
				},
			],
			findings: [],
			resolveAnnotationIds: [],
			supersedes: null,
		},
	});
	const payload = canonicalJSON(request),
		host = { hostId: "daemon", daemonId: "host", lineageId: "lineage" };
	await reviews.record(
		{
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
		},
		request,
	);
	const blocked = f.store.humanReviews.targetState(input.target);
	assert.deepEqual(blocked.unresolvedThreadIds, ["human-thread"]);
	assert.equal(blocked.blockingReviewIds.length, 1);
	const a = await f.source().suggest(native, input);
	await f.source().transition(native, "withdraw", transition(a.requestId, 1));
	const b = await f.source().suggest(coordinator, { ...input, operationId: randomUUID() });
	await f.source().transition(coordinator, "retire", transition(b.requestId, 1));
	assert.deepEqual(f.store.humanReviews.targetState(input.target), blocked);
	assert.equal((await reviews.history(input.target)).length, 1);
});

test("per-target requirement revisions fence feedback; no captured/optional request manufactures Approve prerequisites", async (t) => {
	const f = await fixture(t),
		input = f.suggestion();
	const reviews = new HumanReviews({
		store: f.store.humanReviews,
		qualify: f.qualify,
		requirement: (target) => f.store.reviewRequests.requirement(target),
	});
	const request = {
		purpose: "review-disposition" as const,
		targets: [input.target],
		disposition: "approve" as const,
		body: "Exact review",
		expectedPriorRecordId: null,
		packageDigest: "0".repeat(64),
	};
	const before = await reviews.prepare(request);
	const suggestion = await f.source().suggest(native, input);
	const after = await reviews.prepare(request);
	assert.notEqual(before.packageDigest, after.packageDigest);
	assert.equal(await reviews.prerequisites(after), "unavailable");
	await f.source().transition(native, "withdraw", transition(suggestion.requestId, 1));
	assert.equal(await reviews.prerequisites(after), "blocked");
	assert.notEqual(canonicalJSON(after), canonicalJSON(await reviews.prepare(request)));
	assert.deepEqual(f.store.humanReviews.targetState(input.target).unresolvedThreadIds, []);
});
