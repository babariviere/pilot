import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type {
	DurableOperation,
	HumanReviewContent,
	HumanReviewFeedback,
	NativeReviewSnapshot,
	ReviewDispositionPayload,
} from "@pilot/protocol";
import { checkLineRange, lineRange, projectRange } from "./human-review-anchors.ts";
import { dispositionTarget, HumanReviews, type QualifiedFeedbackPrerequisites } from "./human-reviews.ts";
import { MissionStore } from "./missions.ts";
import { canonicalJSON, OperationJournal, payloadHash } from "./operation-journal.ts";
import { dispositionPayload, WorkflowConfirmations } from "./workflow-confirmations.ts";

const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const host = { hostId: "daemon", daemonId: "host", lineageId: "lineage" };
const feedback = (): HumanReviewFeedback => ({
	draft: null,
	annotations: [],
	findings: [],
	resolveAnnotationIds: [],
	supersedes: null,
});
function snapshot(n = 1, text = "a\nb\nneedle\nc\nd\n"): NativeReviewSnapshot {
	return {
		snapshotId: hash(`snapshot${n}`),
		workerId: "worker",
		enrollmentTaskIds: [],
		enrollmentProjectId: "project",
		capturedAt: n,
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
		status: "complete",
		omissions: [],
		before: [],
		after: [
			{
				path: "a.ts",
				mode: "100644",
				gitOid: "d".repeat(40),
				state: "text",
				sha256: hash(text),
				bytes: Buffer.byteLength(text),
			},
		],
		changes: [],
		diff: { sha256: hash("patch"), bytes: 5 },
	};
}
let sequence = 0;
function op(request: ReviewDispositionPayload): DurableOperation {
	const payload = JSON.stringify(request);
	return {
		schemaVersion: 1,
		operationId: randomUUID(),
		producerId: "native-app",
		sequence: ++sequence,
		origin: host,
		destination: host,
		kind: "review-disposition",
		targetId: request.packageDigest,
		payload,
		payloadHash: payloadHash(payload),
	};
}
async function fixture(t: TestContext, disk = false) {
	const home = await mkdtemp(join(tmpdir(), "human-review-")),
		file = disk ? join(home, "missions.sqlite") : ":memory:";
	let store = new MissionStore(file),
		journal = new OperationJournal(join(home, "operations"), host);
	let allowed = true,
		custody = 1,
		prerequisiteRevision = 1,
		requirementRevision = 1;
	let state: QualifiedFeedbackPrerequisites["state"] = "unavailable";
	let requirement: "required" | "unknown" | "withdrawn" = "unknown";
	const snapshots = new Map([[snapshot().snapshotId, snapshot()]]),
		bytes = new Map([[snapshot().snapshotId, Buffer.from("a\nb\nneedle\nc\nd\n")]]);
	let duringRead: (() => void) | undefined;
	const service = () =>
		new HumanReviews({
			store: store.humanReviews,
			qualify: async (target) => {
				if (!allowed || target.projectId !== "project" || target.sessionId !== "worker")
					throw new Error("Access denied");
				const snapshot = snapshots.get(target.snapshotId);
				if (!snapshot) throw new Error("Missing retained snapshot");
				const observed = custody;
				return {
					snapshot: structuredClone(snapshot),
					fence: `custody-${custody}`,
					revalidate() {
						if (!allowed || observed !== custody) throw new Error("Access/custody changed");
					},
					async read(ref) {
						assert.equal(ref.sha256, hash(bytes.get(target.snapshotId)!));
						duringRead?.();
						return bytes.get(target.snapshotId)!;
					},
				};
			},
			prerequisites: async () => {
				const revision = prerequisiteRevision;
				return {
					state,
					identity: `checks-review-${revision}`,
					revalidate() {
						if (revision !== prerequisiteRevision) throw new Error("Stale prerequisite");
					},
				};
			},
			requirement: () => ({ identity: `request-${requirementRevision}`, state: requirement }),
		});
	const confirmations = () =>
		new WorkflowConfirmations({
			store,
			journal,
			authorize() {
				assert.fail("No mission/coordinator is invented");
			},
			dispositions: service(),
		});
	const content = (targets = [dispositionTarget("project", snapshot())]): HumanReviewContent => ({
		targets,
		body: "Human comment",
		disposition: "comment",
	});
	const prepare = (c = content()) =>
		service().prepare({
			...c,
			purpose: "review-disposition",
			expectedPriorRecordId: null,
			packageDigest: "0".repeat(64),
		});
	const run = (operation: DurableOperation) =>
		journal.execute(operation, (o, entry) => confirmations().admit(o, entry.firstEntry));
	t.after(async () => {
		await store.durable();
		store.close();
		await rm(home, { recursive: true, force: true });
	});
	return {
		home,
		snapshots,
		bytes,
		content,
		prepare,
		service,
		confirmations,
		run,
		get store() {
			return store;
		},
		get journal() {
			return journal;
		},
		set allowed(v: boolean) {
			allowed = v;
		},
		set duringRead(v: (() => void) | undefined) {
			duringRead = v;
		},
		ready() {
			state = "passed";
			requirement = "required";
			prerequisiteRevision++;
			requirementRevision++;
		},
		stalePrerequisites() {
			prerequisiteRevision++;
			state = "blocked";
		},
		withdraw() {
			requirementRevision++;
			requirement = "withdrawn";
		},
		changeCustody() {
			custody++;
		},
		async reopen() {
			await store.durable();
			store.close();
			store = new MissionStore(file);
			journal = new OperationJournal(join(home, "operations"), host);
			await journal.recover((o) => confirmations().admit(o));
		},
	};
}

test("private drafts survive restart without dispatch, request inference or outbox entries", async (t) => {
	const f = await fixture(t, true),
		c = f.content();
	c.body = "";
	const draft = await f.service().saveDraft("draft", 0, c);
	assert.equal(draft.revision, 1);
	assert.deepEqual(f.store.humanReviews.outbox(), []);
	assert.equal(f.store.list().length, 0);
	await f.reopen();
	assert.deepEqual(await f.service().draft("draft"), draft);
	assert.deepEqual(await f.service().extraction(), []);
	await assert.rejects(f.service().saveDraft("draft", 0, c), /Draft changed/);
});

test("native confirmed comment is durable with one original/outbox and exact lost-ACK recovery", async (t) => {
	const f = await fixture(t, true),
		request = await f.prepare(),
		operation = op(request);
	const original = await f.run(operation);
	assert.equal(original.state, "accepted");
	assert.equal(
		f.store.humanReviews.get((original.result as { recordId: string }).recordId)!.author.origin,
		"native-user",
	);
	await f.reopen();
	assert.deepEqual(await f.journal.lookup(operation), original);
	assert.deepEqual(await f.run(operation), original);
	assert.equal((await f.service().extraction()).length, 1);
	assert.equal((await f.service().history(request.targets[0])).length, 1);
	assert.equal(f.store.list().length, 0);
});

test("entered but absent effect stays Unknown through restart, never records anew", async (t) => {
	const f = await fixture(t, true),
		operation = op(await f.prepare());
	const first = await f.journal.execute(operation, async (o) => {
		await f.journal.checkpoint(o, { stage: "workflow-effect-entered", purpose: o.kind, payloadHash: o.payloadHash });
		throw new Error("Crash before record");
	});
	assert.equal(first.state, "pending");
	await f.reopen();
	assert.equal((await f.run(operation)).state, "pending");
	assert.equal(await f.service().lookup(operation), undefined);
	assert.deepEqual(await f.service().extraction(), []);
});

test("entered committed effect is reconciled from exact row after restart", async (t) => {
	const f = await fixture(t, true),
		request = await f.prepare(),
		operation = op(request);
	let saved: { recordId: string } | undefined;
	const pending = await f.journal.execute(operation, async (o) => {
		await f.journal.checkpoint(o, { stage: "workflow-effect-entered", purpose: o.kind, payloadHash: o.payloadHash });
		saved = await f.service().record(o, request);
		throw new Error("Lost ACK after durable record");
	});
	assert.equal(pending.state, "pending");
	await f.reopen();
	assert.equal((await f.journal.lookup(operation))!.state, "accepted");
	assert.deepEqual((await f.journal.lookup(operation))!.result, saved);
	assert.equal((await f.service().extraction()).length, 1);
});

test("missing/stale checks and agent review refuse Approve, early feedback remains possible", async (t) => {
	const f = await fixture(t),
		c = { ...f.content(), disposition: "approve" as const };
	const missing = await f.run(op(await f.prepare(c)));
	assert.equal(missing.state, "rejected");
	assert.equal((await f.run(op(await f.prepare()))).state, "accepted");
	assert.equal(
		(await f.run(op(await f.prepare({ ...f.content(), disposition: "request_changes" })))).state,
		"accepted",
	);
	f.ready();
	// Request changes is not cleared by readiness, later comment, or another selection.
	assert.equal(await f.service().prerequisites(await f.prepare(c)), "unavailable");
});

test("test-only exact passing producers permit an immutable selected approval, never future revisions", async (t) => {
	const f = await fixture(t);
	f.ready();
	const request = await f.prepare({ ...f.content(), disposition: "approve" });
	assert.equal((await f.run(op(request))).state, "accepted");
	const other = snapshot(2);
	f.snapshots.set(other.snapshotId, other);
	assert.equal(f.store.humanReviews.targetState(dispositionTarget("project", other)).latestRecordId, null);
	assert.equal(f.store.humanReviews.latest([dispositionTarget("project", other)]), undefined);
});

test("held package detects revision, custody, prerequisite and requirement changes", async (t) => {
	for (const change of ["stalePrerequisites", "withdraw", "changeCustody"] as const) {
		const f = await fixture(t);
		f.ready();
		const request = await f.prepare({ ...f.content(), disposition: "approve" });
		f[change]();
		assert.equal((await f.run(op(request))).state, "rejected", change);
		assert.equal(f.store.humanReviews.latest(request.targets), undefined);
	}
});

test("per-target CAS prevents overlapping selections from bypassing newer feedback", async (t) => {
	const f = await fixture(t);
	f.ready();
	const second = snapshot(2);
	f.snapshots.set(second.snapshotId, second);
	const targets = [f.content().targets[0], dispositionTarget("project", second)];
	const held = await f.prepare({ ...f.content(targets), disposition: "approve" });
	const changes = await f.prepare({ ...f.content([targets[0]]), disposition: "request_changes" });
	assert.equal((await f.run(op(changes))).state, "accepted");
	assert.equal((await f.run(op(held))).state, "rejected");
	const fresh = await f.prepare({ ...f.content(targets), disposition: "approve" });
	assert.equal(fresh.expectedPriorRecordId, null, "selected-set prior alone cannot bypass overlap");
	assert.equal(await f.service().prerequisites(fresh), "unavailable");
	assert.equal((await f.run(op(fresh))).state, "rejected");
});

test("exact same-selection CAS admits one concurrent submission", async (t) => {
	const f = await fixture(t),
		one = await f.prepare(),
		two = await f.prepare();
	const results = await Promise.all([f.run(op(one)), f.run(op(two))]);
	assert.equal(results.filter((r) => r.state === "accepted").length, 1);
	assert.equal((await f.service().extraction()).length, 1);
});

test("strict optional feedback preserves omission and rejects extras, actor claims and tampering", async (t) => {
	const f = await fixture(t),
		original = await f.prepare();
	assert.equal(Object.hasOwn(dispositionPayload(original), "feedback"), false);
	for (const request of [
		{ ...original, authorOrigin: "user" },
		{ ...original, feedback: { ...feedback(), extra: true } },
		{ ...original, feedback: { ...feedback(), annotations: Array(101).fill({}) } },
	])
		assert.throws(() => dispositionPayload(request));
	assert.equal((await f.run(op({ ...original, body: "Agent transcription changed the package" }))).state, "rejected");
	const included = await f.prepare({ ...f.content(), feedback: feedback() });
	assert.notEqual(included.packageDigest, original.packageDigest);
});

test("draft consumption binds revision/content and retains originals without draft extraction", async (t) => {
	const f = await fixture(t, true),
		c = { ...f.content(), feedback: feedback() };
	const draft = await f.service().saveDraft("draft", 0, c);
	const request = await f.prepare({
		...c,
		feedback: { ...c.feedback, draft: { id: draft.id, revision: draft.revision } },
	});
	assert.equal((await f.run(op(request))).state, "accepted");
	assert.equal((await f.service().extraction()).length, 1);
	await assert.rejects(f.service().saveDraft("draft", 1, c), /submitted/);
	await f.reopen();
	assert.deepEqual(await f.service().draft("draft"), draft);
});

test("edits append explicit supersession and only native user submission resolves original threads", async (t) => {
	const f = await fixture(t),
		fb = feedback(),
		target = f.content().targets[0];
	const range = lineRange(
		f.bytes.get(target.snapshotId)!,
		{ side: "after", path: "a.ts", sha256: snapshot().after[0].sha256! },
		3,
		3,
	);
	fb.annotations.push({
		id: "annotation",
		body: "Keep the reason",
		anchor: { kind: "lines", snapshotId: target.snapshotId, ranges: [range] },
		supersedes: null,
	});
	const originalRequest = await f.prepare({ ...f.content(), disposition: "request_changes", feedback: fb });
	const first = await f.run(op(originalRequest));
	const originalId = (first.result as { recordId: string }).recordId;
	f.ready();
	const approval = {
		...f.content(),
		disposition: "approve" as const,
		feedback: {
			...feedback(),
			supersedes: { recordId: originalId, reason: "Explicitly replaced after human review" },
		},
	};
	assert.equal(
		await f.service().prerequisites(await f.prepare(approval)),
		"unavailable",
		"supersession alone does not resolve thread",
	);
	approval.feedback.resolveAnnotationIds = ["annotation"];
	assert.equal((await f.run(op(await f.prepare(approval)))).state, "accepted");
	const history = await f.service().history(target);
	assert.equal(history[0].record.confirmed.feedback!.annotations[0].body, "Keep the reason");
	assert.deepEqual(history[0].record.confirmed.feedback!.annotations[0].anchor, fb.annotations[0].anchor);
	assert.deepEqual(f.store.humanReviews.targetState(target).unresolvedThreadIds, []);
});

test("retirement-independent history/outbox/drafts and exact receipts require current source access", async (t) => {
	const f = await fixture(t, true),
		c = f.content(),
		request = await f.prepare(c),
		operation = op(request);
	await f.service().saveDraft("draft", 0, c);
	await f.run(operation);
	await f.reopen();
	f.allowed = false;
	await assert.rejects(f.service().lookup(operation), /Access denied/);
	await assert.rejects(f.service().draft("draft"), /Access denied/);
	await assert.rejects(f.service().history(c.targets[0]), /Access denied/);
	await assert.rejects(f.service().extraction(), /Access denied/);
	f.allowed = true;
	assert.equal((await f.service().extraction()).length, 1);
});

test("host validates original blob/side/path/range/context and fences custody after retained reads", async (t) => {
	const f = await fixture(t),
		target = f.content().targets[0],
		fb = feedback();
	const range = lineRange(
		f.bytes.get(target.snapshotId)!,
		{ side: "after", path: "a.ts", sha256: snapshot().after[0].sha256! },
		3,
		3,
	);
	fb.annotations = [
		{
			id: "a",
			body: "Why",
			anchor: { kind: "lines", snapshotId: target.snapshotId, ranges: [range] },
			supersedes: null,
		},
	];
	const c = { ...f.content(), feedback: fb };
	const wrong = structuredClone(c);
	(wrong.feedback.annotations[0].anchor as { ranges: (typeof range)[] }).ranges[0].excerptSha256 = "0".repeat(64);
	await assert.rejects(f.prepare(wrong), /mismatch/);
	f.duringRead = () => f.changeCustody();
	await assert.rejects(f.service().saveDraft("draft", 0, c), /custody changed/);
	assert.equal(f.store.humanReviews.draft("draft"), undefined);
});

test("original anchors remain exact; deterministic projections mark moved, ambiguous and outdated", () => {
	const original = Buffer.from("\uFEFFa\r\nb\r\nneedle\r\nc\r\nd\r\n");
	const range = lineRange(original, { side: "after", path: "a.ts", sha256: hash(original) }, 3, 3);
	assert.equal(range.excerptSha256, hash("needle\r\n"));
	checkLineRange(original, range);
	assert.equal(projectRange(range, original, original).state, "same");
	// Keep two exact lines of context; BOM is outside the candidate's context here.
	const plain = Buffer.from("a\nb\nneedle\nc\nd\n"),
		r = lineRange(plain, { side: "after", path: "a.ts", sha256: hash(plain) }, 3, 3);
	const moved = projectRange(r, plain, Buffer.from("extra\na\nb\nneedle\nc\nd\n"));
	assert.equal(moved.state, "moved");
	if ("range" in moved) assert.equal(moved.range.startLine, 4);
	assert.equal(projectRange(r, plain, Buffer.from("a\nb\nneedle\nc\nd\nneedle\n")).state, "ambiguous");
	assert.equal(projectRange(r, plain, Buffer.from("a\nb\nneedle\nc\nd\nxneedle\n")).state, "ambiguous");
	assert.equal(projectRange(r, plain, Buffer.from("a\nb\n needle\nc\nd\n")).state, "outdated");
	assert.equal(projectRange(r, plain, Buffer.from("a\nchanged\nneedle\nc\nd\n")).state, "outdated");
	assert.equal(
		canonicalJSON(range),
		canonicalJSON(lineRange(original, { side: "after", path: "a.ts", sha256: hash(original) }, 3, 3)),
	);
});

test("atomic record revalidation rejects prerequisites changed after async qualification", async (t) => {
	const f = await fixture(t);
	f.ready();
	const request = await f.prepare({ ...f.content(), disposition: "approve" });
	const append = f.store.humanReviews.append.bind(f.store.humanReviews);
	t.mock.method(f.store.humanReviews, "append", (...args: Parameters<typeof append>) => {
		f.stalePrerequisites();
		return append(...args);
	});
	const receipt = await f.run(op(request));
	assert.equal(receipt.state, "pending", "effect entered, exact absence stays Unknown");
	assert.deepEqual(f.store.humanReviews.outbox(), []);
});

test("atomic record revalidation rejects requirement and custody changes at the final CAS", async (t) => {
	for (const mutate of ["withdraw", "changeCustody"] as const) {
		const f = await fixture(t),
			request = await f.prepare();
		const append = f.store.humanReviews.append.bind(f.store.humanReviews);
		t.mock.method(f.store.humanReviews, "append", (...args: Parameters<typeof append>) => {
			f[mutate]();
			return append(...args);
		});
		assert.equal((await f.run(op(request))).state, "pending");
		assert.deepEqual(f.store.humanReviews.outbox(), []);
	}
});

test("failed durability and unreadable lookup never acknowledge or recreate a review", async (t) => {
	const f = await fixture(t),
		request = await f.prepare(),
		operation = op(request);
	const durable = f.store.humanReviews.durable.bind(f.store.humanReviews);
	const append = f.store.humanReviews.append.bind(f.store.humanReviews);
	t.mock.method(f.store.humanReviews, "append", (...args: Parameters<typeof append>) => {
		const record = append(...args);
		t.mock.method(f.store.humanReviews, "durable", async () => {
			throw new Error("Disk unavailable");
		});
		return record;
	});
	assert.equal((await f.run(operation)).state, "pending");
	await assert.rejects(f.service().lookup(operation), /Disk unavailable/);
	t.mock.method(f.store.humanReviews, "durable", durable);
	assert.ok(await f.service().lookup(operation));
	assert.equal((await f.run(operation)).state, "accepted");
	assert.equal(f.store.humanReviews.outbox().length, 1);
});

test("edited drafts cannot substitute changed text into an already confirmed operation", async (t) => {
	const f = await fixture(t),
		content = { ...f.content(), feedback: feedback() };
	await f.service().saveDraft("d", 0, content);
	const held = await f.prepare({ ...content, feedback: { ...content.feedback, draft: { id: "d", revision: 1 } } });
	await f.service().saveDraft("d", 1, { ...content, body: "A newer unsent draft" });
	assert.equal((await f.run(op(held))).state, "pending");
	assert.equal(f.store.humanReviews.outbox().length, 0);
	assert.equal((await f.service().draft("d"))!.content.body, "A newer unsent draft");
});

test("overlapping selections cannot clear request changes or their human threads", async (t) => {
	const f = await fixture(t);
	f.ready();
	const second = snapshot(2);
	f.snapshots.set(second.snapshotId, second);
	const a = f.content().targets[0],
		b = dispositionTarget("project", second),
		fb = feedback();
	fb.annotations = [
		{
			id: "thread",
			body: "Human asks for a fix",
			anchor: { kind: "summary", snapshotId: a.snapshotId },
			supersedes: null,
		},
	];
	const first = await f.run(
		op(await f.prepare({ ...f.content([a, b]), disposition: "request_changes", feedback: fb })),
	);
	const priorId = (first.result as { recordId: string }).recordId;
	assert.equal((await f.run(op(await f.prepare(f.content([a]))))).state, "accepted");
	const approval = { ...f.content([a]), disposition: "approve" as const };
	assert.equal(await f.service().prerequisites(await f.prepare(approval)), "unavailable");
	// A partial selection cannot supersede a request covering another unseen target.
	const partial = {
		...approval,
		feedback: {
			...feedback(),
			supersedes: { recordId: priorId, reason: "Only saw A" },
			resolveAnnotationIds: ["thread"],
		},
	};
	assert.equal((await f.run(op(await f.prepare(partial)))).state, "pending");
	assert.deepEqual(f.store.humanReviews.targetState(a).unresolvedThreadIds, ["thread"]);
	assert.deepEqual(f.store.humanReviews.targetState(b).blockingReviewIds, [priorId]);
});

test("annotation edits preserve originals and reject duplicate supersession", async (t) => {
	const f = await fixture(t),
		fb = feedback(),
		target = f.content().targets[0];
	fb.annotations = [
		{
			id: "original",
			body: "Original bytes",
			anchor: { kind: "summary", snapshotId: target.snapshotId },
			supersedes: null,
		},
	];
	await f.run(op(await f.prepare({ ...f.content(), feedback: fb })));
	const edit = feedback();
	edit.annotations = [{ ...fb.annotations[0], id: "edit", body: "Corrected bytes", supersedes: "original" }];
	assert.equal((await f.run(op(await f.prepare({ ...f.content(), feedback: edit })))).state, "accepted");
	const repeated = feedback();
	repeated.annotations = [{ ...edit.annotations[0], id: "third" }];
	assert.equal((await f.run(op(await f.prepare({ ...f.content(), feedback: repeated })))).state, "pending");
	const rows = await f.service().history(target);
	assert.equal(rows[0].record.confirmed.feedback!.annotations[0].body, "Original bytes");
	assert.equal(rows[1].record.confirmed.feedback!.annotations[0].supersedes, "original");
});

test("retained reanchor projections preserve originals across rewritten, renamed and duplicate excerpts", async (t) => {
	const f = await fixture(t),
		target = f.content().targets[0],
		fb = feedback(),
		originalBytes = f.bytes.get(target.snapshotId)!;
	const range = lineRange(originalBytes, { side: "after", path: "a.ts", sha256: hash(originalBytes) }, 3, 3);
	fb.annotations = [
		{
			id: "original",
			body: "Exact reason",
			anchor: { kind: "lines", snapshotId: target.snapshotId, ranges: [range] },
			supersedes: null,
		},
	];
	await f.run(op(await f.prepare({ ...f.content(), feedback: fb })));
	const text = "extra\na\nb\nneedle\nc\nd\n",
		newer = snapshot(2, text);
	f.snapshots.set(newer.snapshotId, newer);
	f.bytes.set(newer.snapshotId, Buffer.from(text));
	const projected = await f.service().projectAnnotation("original", dispositionTarget("project", newer));
	assert.equal(projected.state, "moved");
	assert.deepEqual(projected.original, fb.annotations[0]);
	assert.equal(projected.projected!.snapshotId, newer.snapshotId);
	const duplicate = snapshot(3, `${text}needle\n`);
	f.snapshots.set(duplicate.snapshotId, duplicate);
	f.bytes.set(duplicate.snapshotId, Buffer.from(`${text}needle\n`));
	assert.equal(
		(await f.service().projectAnnotation("original", dispositionTarget("project", duplicate))).state,
		"ambiguous",
	);
	const renamed = snapshot(4);
	renamed.after[0].path = "renamed.ts";
	renamed.changes = [
		{
			status: "R100",
			beforePath: "a.ts",
			afterPath: "renamed.ts",
			beforeMode: "100644",
			afterMode: "100644",
			beforeOid: "d".repeat(40),
			afterOid: "d".repeat(40),
		},
	];
	f.snapshots.set(renamed.snapshotId, renamed);
	f.bytes.set(renamed.snapshotId, originalBytes);
	const r = await f.service().projectAnnotation("original", dispositionTarget("project", renamed));
	assert.equal(r.state, "same");
	assert.equal((r.projected as { ranges: (typeof range)[] }).ranges[0].path, "renamed.ts");
	assert.deepEqual(
		(await f.service().history(target))[0].record.confirmed.feedback!.annotations[0],
		fb.annotations[0],
	);
});

test("large newline-dense retained blobs use line indexes without per-line objects", () => {
	const bytes = Buffer.alloc(2 * 1024 * 1024, 10);
	const range = lineRange(bytes, { side: "after", path: "many-lines", sha256: hash(bytes) }, 1_000_000, 1_000_001);
	assert.equal(range.excerptSha256, hash("\n\n"));
	assert.equal(projectRange(range, bytes, bytes).state, "same");
	assert.throws(
		() => lineRange(Buffer.alloc(bytes.length + 1), { side: "after", path: "huge", sha256: "0".repeat(64) }, 1, 1),
		/limit/,
	);
});

test("producer record is idempotent for the complete exact operation, without rechecking readiness", async (t) => {
	const f = await fixture(t);
	f.ready();
	const request = await f.prepare({ ...f.content(), disposition: "approve" }),
		operation = op(request);
	const first = await f.service().record(operation, request);
	f.stalePrerequisites();
	f.withdraw();
	assert.deepEqual(await f.service().record(operation, request), first);
	assert.equal(f.store.humanReviews.outbox().length, 1);
	await assert.rejects(f.service().record({ ...operation, producerId: "different" }, request), /Conflicting exact/);
	f.allowed = false;
	await assert.rejects(f.service().record(operation, request), /Access denied/);
});

test("concurrent A and A+B packages share per-target CAS despite distinct selection histories", async (t) => {
	const f = await fixture(t);
	f.ready();
	const other = snapshot(2);
	f.snapshots.set(other.snapshotId, other);
	const a = f.content().targets[0],
		b = dispositionTarget("project", other);
	const one = await f.prepare({ ...f.content([a]), disposition: "request_changes" });
	const both = await f.prepare({ ...f.content([a, b]), disposition: "approve" });
	const receipts = await Promise.all([f.run(op(one)), f.run(op(both))]);
	assert.equal(receipts.filter((r) => r.state === "accepted").length, 1);
	assert.equal((await f.service().history(a)).length, 1);
	assert.equal(f.store.humanReviews.outbox().length, 1);
});

test("omitted feedback preserves legacy validation/bytes above the new optional-field bound", async (t) => {
	const f = await fixture(t),
		request = await f.prepare();
	const legacy = {
		...request,
		body: "\0".repeat(5000) + "x".repeat(11384),
		targets: Array.from({ length: 20 }, (_, i) => ({
			...request.targets[0],
			projectId: "p".repeat(128),
			sessionId: "s".repeat(128),
			snapshotId: hash(String(i)),
		})),
	};
	const bytes = JSON.stringify(legacy);
	assert.ok(Buffer.byteLength(bytes) > 48 * 1024);
	assert.ok(Buffer.byteLength(bytes) <= 64 * 1024);
	assert.equal(JSON.stringify(dispositionPayload(legacy)), bytes);
	assert.equal(Object.hasOwn(dispositionPayload(legacy), "feedback"), false);
	assert.throws(() => dispositionPayload({ ...legacy, feedback: feedback() }), /48 KiB/);
});

test("anchor-target scope: an A+B comment never attaches A's thread to B", async (t) => {
	const f = await fixture(t, true),
		other = snapshot(2);
	f.snapshots.set(other.snapshotId, other);
	const a = f.content().targets[0],
		b = dispositionTarget("project", other),
		fb = feedback();
	fb.annotations = [
		{ id: "thread-A", body: "Only about A", anchor: { kind: "summary", snapshotId: a.snapshotId }, supersedes: null },
	];
	assert.equal((await f.run(op(await f.prepare({ ...f.content([a, b]), feedback: fb })))).state, "accepted");
	assert.deepEqual(f.store.humanReviews.targetState(a).unresolvedThreadIds, ["thread-A"]);
	assert.deepEqual(f.store.humanReviews.targetState(b).unresolvedThreadIds, []);
	await f.reopen();
	assert.deepEqual(f.store.humanReviews.targetState(a).unresolvedThreadIds, ["thread-A"]);
	assert.deepEqual(f.store.humanReviews.targetState(b).unresolvedThreadIds, []);
});

for (const action of ["resolve", "edit"] as const) {
	test(`anchor-target scope: ${action} A's own thread with only A selected preserves B and originals`, async (t) => {
		const f = await fixture(t, true),
			other = snapshot(2);
		f.snapshots.set(other.snapshotId, other);
		const a = f.content().targets[0],
			b = dispositionTarget("project", other),
			fb = feedback();
		const range = lineRange(
			f.bytes.get(a.snapshotId)!,
			{ side: "after", path: "a.ts", sha256: snapshot().after[0].sha256! },
			3,
			3,
		);
		fb.annotations = [
			{
				id: "thread-A",
				body: "Original text",
				anchor: { kind: "lines", snapshotId: a.snapshotId, ranges: [range] },
				supersedes: null,
			},
		];
		const first = await f.run(op(await f.prepare({ ...f.content([a, b]), feedback: fb })));
		assert.equal(first.state, "accepted");
		const recordId = (first.result as { recordId: string }).recordId;
		const original = f.store.humanReviews.get(recordId),
			beforeB = f.store.humanReviews.targetState(b);
		const change = feedback();
		if (action === "resolve") change.resolveAnnotationIds = ["thread-A"];
		else
			change.annotations = [
				{ ...fb.annotations[0], id: "edited-A", body: "Explicit correction", supersedes: "thread-A" },
			];
		assert.equal((await f.run(op(await f.prepare({ ...f.content([a]), feedback: change })))).state, "accepted");
		assert.deepEqual(f.store.humanReviews.targetState(b), beforeB);
		assert.deepEqual(
			f.store.humanReviews.targetState(a).unresolvedThreadIds,
			action === "resolve" ? [] : ["edited-A"],
		);
		assert.deepEqual(f.store.humanReviews.get(recordId), original);
		await f.reopen();
		assert.deepEqual(f.store.humanReviews.targetState(b), beforeB);
		assert.deepEqual(f.store.humanReviews.get(recordId), original);
		assert.deepEqual(f.store.humanReviews.get(recordId)!.confirmed.feedback!.annotations, fb.annotations);
		assert.equal((await f.service().extraction()).length, 2);
	});
}

test("anchor-target scope: resolving A leaves an A+B Request-changes record blocking both", async (t) => {
	const f = await fixture(t),
		other = snapshot(2);
	f.snapshots.set(other.snapshotId, other);
	const a = f.content().targets[0],
		b = dispositionTarget("project", other),
		fb = feedback();
	fb.annotations = [
		{
			id: "thread-A",
			body: "A needs a fix",
			anchor: { kind: "summary", snapshotId: a.snapshotId },
			supersedes: null,
		},
	];
	const first = await f.run(
		op(await f.prepare({ ...f.content([a, b]), disposition: "request_changes", feedback: fb })),
	);
	assert.equal(first.state, "accepted");
	const recordId = (first.result as { recordId: string }).recordId,
		change = feedback();
	change.resolveAnnotationIds = ["thread-A"];
	assert.equal((await f.run(op(await f.prepare({ ...f.content([a]), feedback: change })))).state, "accepted");
	for (const target of [a, b]) {
		assert.deepEqual(f.store.humanReviews.targetState(target).blockingReviewIds, [recordId]);
		assert.deepEqual(f.store.humanReviews.targetState(target).unresolvedThreadIds, []);
	}
	f.ready();
	assert.equal(
		await f.service().prerequisites(await f.prepare({ ...f.content([a, b]), disposition: "approve" })),
		"unavailable",
	);
});

test("anchor-target scope: B alone cannot resolve or edit A's thread", async (t) => {
	const f = await fixture(t),
		other = snapshot(2);
	f.snapshots.set(other.snapshotId, other);
	const a = f.content().targets[0],
		b = dispositionTarget("project", other),
		fb = feedback();
	fb.annotations = [
		{ id: "thread-A", body: "Only A", anchor: { kind: "summary", snapshotId: a.snapshotId }, supersedes: null },
	];
	await f.run(op(await f.prepare({ ...f.content([a, b]), feedback: fb })));
	const beforeA = f.store.humanReviews.targetState(a),
		beforeB = f.store.humanReviews.targetState(b);
	const resolve = feedback();
	resolve.resolveAnnotationIds = ["thread-A"];
	const edit = feedback();
	edit.annotations = [
		{ id: "edited-B", body: "Not A", anchor: { kind: "summary", snapshotId: b.snapshotId }, supersedes: "thread-A" },
	];
	for (const change of [resolve, edit])
		assert.equal((await f.run(op(await f.prepare({ ...f.content([b]), feedback: change })))).state, "pending");
	assert.deepEqual(f.store.humanReviews.targetState(a), beforeA);
	assert.deepEqual(f.store.humanReviews.targetState(b), beforeB);
	assert.equal(f.store.humanReviews.outbox().length, 1);
});
