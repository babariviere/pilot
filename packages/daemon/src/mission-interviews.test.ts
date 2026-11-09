import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type {
	AgreementAdmission,
	DurableOperation,
	InterviewAnswer,
	InterviewContinuation,
	InterviewQuestion,
	InterviewWrite,
	MissionInterview,
	SmallAskAdmission,
} from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { completeAnswers, interviewDigest, validateQuestions } from "./mission-interview-contract.ts";
import { MissionInterviews, type QualifiedMissionFlowAdapter } from "./mission-interviews.ts";
import { MissionStore } from "./missions.ts";
import { canonicalJSON, durableJSON, OperationJournal, OperationRejected, payloadHash } from "./operation-journal.ts";
import { WorkflowConfirmations } from "./workflow-confirmations.ts";

const host = { hostId: "native", daemonId: "daemon", lineageId: "lineage" };

test("empty bootstrap cannot submit, and question count/size limits reject instead of truncate", () => {
	assert.throws(() => completeAnswers({ questions: [], answers: [] } as unknown as MissionInterview), /not ready/);
	const forty = Array.from({ length: 40 }, (_, index) => ({ ...question(`q${index}`), prompt: "New question" }));
	validateQuestions(forty);
	assert.throws(() => validateQuestions([...forty, question("extra")]), /1–40 questions/);
	assert.throws(() => validateQuestions(forty.map((q) => ({ ...q, prompt: "x".repeat(1000) }))), /12 KiB/);
	assert.equal(forty.length, 40);
});
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
const question = (id = "outcome"): InterviewQuestion => ({
	id,
	section: "outcome",
	prompt: "What should change?",
	options: [
		{ id: "fix", meaning: "Fix the importer" },
		{ id: "leave", meaning: "Leave it unchanged" },
	],
	recommendedOptionId: "fix",
});
const version = (state: MissionInterview) => ({ fence: state.fence, revision: state.revision });
function answer(q: InterviewQuestion, text = "", choose = true): InterviewAnswer {
	return { questionId: q.id, questionDigest: interviewDigest(q), selectedOption: choose ? q.options[0]! : null, text };
}
async function fixture(t: TestContext, disk = false) {
	const home = await mkdtemp(join(tmpdir(), "interview-"));
	const file = disk ? join(home, "missions.sqlite") : ":memory:";
	let store = new MissionStore(file);
	let journal = new OperationJournal(join(home, "journal"), host);
	let allowed = true;
	let configuration = "config-1";
	let assignment = "assignment-owner-revision-1";
	let calls = 0;
	let loseAck = false;
	let failBefore = false;
	let beforeCommit: (() => void | Promise<void>) | undefined;
	let adapterAvailable = true;
	const adapter: QualifiedMissionFlowAdapter = {
		async admit(op, request, guard) {
			calls++;
			await beforeCommit?.();
			// Faux independent model/lifecycle gate, not derived from agreement approval.
			if (!allowed || failBefore) throw new Error("Independent admission denied");
			guard();
			const result = { admissionId: `new-${request.purpose}-${op.operationId}` };
			await durableJSON(join(home, `${op.operationId}.json`), { op, result });
			if (loseAck) throw new Error("Lost reply after commit");
			return result;
		},
		async lookup(op) {
			try {
				const record = JSON.parse(await readFile(join(home, `${op.operationId}.json`), "utf8"));
				assert.equal(canonicalJSON(record.op), canonicalJSON(op));
				return record.result;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			}
		},
	};
	const confirmations = () =>
		new WorkflowConfirmations({
			store,
			journal,
			authorize: () => {
				if (!allowed) throw new Conflict("Permission denied");
				return configuration;
			},
		});
	const service = () =>
		new MissionInterviews({
			store,
			journal,
			confirmations: confirmations(),
			authorize: (purpose) => {
				if (!allowed) throw new OperationRejected("Permission denied");
				return purpose === "agreement-start" ? assignment : configuration;
			},
			adapter: adapterAvailable ? adapter : undefined,
		});
	const run = (op: DurableOperation) => journal.execute(op, (op, entry) => service().admit(op, entry.firstEntry));
	t.after(async () => {
		await store.durable();
		store.close();
		await rm(home, { recursive: true, force: true });
	});
	return {
		get store() {
			return store;
		},
		get journal() {
			return journal;
		},
		get calls() {
			return calls;
		},
		set allowed(v: boolean) {
			allowed = v;
		},
		set configuration(v: string) {
			configuration = v;
		},
		set assignment(v: string) {
			assignment = v;
		},
		set loseAck(v: boolean) {
			loseAck = v;
		},
		set failBefore(v: boolean) {
			failBefore = v;
		},
		set beforeCommit(v: (() => void | Promise<void>) | undefined) {
			beforeCommit = v;
		},
		set adapterAvailable(v: boolean) {
			adapterAvailable = v;
		},
		service,
		run,
		confirmations,
		async create(questions = [question()]) {
			const op = operation("interview-create", randomUUID(), {
				purpose: "interview-create",
				projectId: "project",
				title: "Import",
				ownerSessionId: randomUUID(),
				questions,
			});
			const receipt = await run(op);
			assert.equal(receipt.state, "accepted", receipt.reason ?? "creation failed");
			return { op, state: store.interviews.lookup(op)! };
		},
		async write(state: MissionInterview, purpose: InterviewWrite["purpose"], extra = {}) {
			const op = operation(purpose, state.fence.missionId, { purpose, expected: version(state), ...extra });
			const receipt = await run(op);
			return { op, receipt, state: store.interviews.latest(state.fence.missionId)! };
		},
		async submitted(text = "") {
			let { state } = await this.create();
			({ state } = await this.write(state, "interview-save", { answers: [answer(state.questions[0]!, text)] }));
			const result = await this.write(state, "interview-submit");
			assert.equal(result.receipt.state, "accepted");
			return result.state;
		},
		async approve(state: MissionInterview) {
			const prepared = await confirmations().prepare(state.fence.missionId, "workflow-approve");
			const op = operation("workflow-approve", state.fence.missionId, { purpose: "workflow-approve", ...prepared });
			assert.equal(
				(await journal.execute(op, (op, entry) => confirmations().admit(op, entry.firstEntry))).state,
				"accepted",
			);
			return { op, prepared };
		},
		async reopen() {
			await store.durable();
			if (disk) {
				store.close();
				store = new MissionStore(file);
			}
			journal = new OperationJournal(join(home, "journal"), host);
			await journal.recover((op) => service().admit(op));
		},
	};
}
function continuation(state: MissionInterview) {
	const request: InterviewContinuation = {
		purpose: "interview-continue",
		fence: state.fence,
		submissionOperationId: state.submission!.operationId,
		submissionDigest: state.submission!.digest,
	};
	return operation(request.purpose, state.fence.missionId, request);
}
function smallAsk() {
	const request: SmallAskAdmission = {
		purpose: "small-ask-start",
		requestId: randomUUID(),
		projectId: "project",
		text: "Fix the importer; keep the format and run its tests",
		configurationDigest: "config-1",
	};
	return operation(request.purpose, request.requestId, request);
}

test("creation alone enrolls; legacy missions cannot submit or acquire an interview approval", async (t) => {
	const f = await fixture(t);
	const legacy = f.store.create({ projectId: "project", title: "Legacy", planningVersion: 1 });
	await assert.rejects(f.service().read(legacy.id), /not enrolled/);
	const { state, op } = await f.create();
	assert.equal(state.fence.enrollmentId, op.targetId);
	assert.equal((await f.run(op)).state, "accepted");
	assert.equal(f.store.list().length, 2);
	await assert.rejects(f.confirmations().prepare(state.fence.missionId, "workflow-approve"), /complete interview/);
});

test("recommendation and partial autosaves never count as submission or resume", async (t) => {
	const f = await fixture(t);
	let { state } = await f.create([question(), question("acceptance")]);
	assert.equal((await f.write(state, "interview-submit")).receipt.state, "rejected");
	({ state } = await f.write(state, "interview-save", { answers: [answer(state.questions[0]!)] }));
	assert.equal((await f.write(state, "interview-submit")).receipt.state, "rejected");
	assert.equal(f.calls, 0);
	assert.equal(state.submission, null);
});

test("suggestion-only, free-text-only and option plus detail map exact accepted meaning", async (t) => {
	const f = await fixture(t);
	for (const [text, choose] of [
		["", true],
		["  My custom outcome  ", false],
		["Keep old files", true],
	] as const) {
		let { state } = await f.create();
		const saved = await f.write(state, "interview-save", { answers: [answer(state.questions[0]!, text, choose)] });
		assert.equal(saved.receipt.state, "accepted");
		({ state } = await f.write(saved.state, "interview-submit"));
		assert.equal(state.submission!.answers[0]!.text, text);
		assert.deepEqual(state.submission!.answers[0]!.selectedOption, choose ? state.questions[0]!.options[0] : null);
		assert.equal(f.store.brief(state.fence.missionId)!.markdown, state.submission!.agreementMarkdown);
		assert.equal(f.calls, 0);
	}
});

test("saved custom drafts survive new frontiers; changed option meanings require explicit answer", async (t) => {
	const f = await fixture(t);
	let state = await f.submitted("Keep this exact custom draft");
	const old = state;
	const q = { ...state.questions[0]!, options: [{ id: "fix", meaning: "Replace the importer" }] };
	({ state } = await f.write(state, "interview-questions", { questions: [q, question("new")] }));
	assert.deepEqual(state.answers, old.answers);
	assert.equal(state.submission, null);
	assert.equal((await f.write(state, "interview-submit")).receipt.state, "rejected");
	assert.equal((await f.write(state, "interview-save", { answers: old.answers })).receipt.state, "rejected");
	assert.equal((await f.run(continuation(old))).state, "rejected");
	const malformed = answer(q);
	malformed.selectedOption = old.answers[0]!.selectedOption;
	assert.equal((await f.write(state, "interview-save", { answers: [malformed] })).receipt.state, "rejected");
	({ state } = await f.write(state, "interview-save", {
		answers: [answer(q, "Saved custom draft"), answer(state.questions[1]!, "New answer", false)],
	}));
	assert.equal((await f.write(state, "interview-submit")).receipt.state, "accepted");
});

test("concurrent edits, stale submissions and duplicate submission cannot double-continue", async (t) => {
	const f = await fixture(t);
	const { state } = await f.create();
	const results = await Promise.all([
		f.write(state, "interview-save", { answers: [answer(state.questions[0]!)] }),
		f.write(state, "interview-save", { answers: [answer(state.questions[0]!, "Other edit")] }),
	]);
	assert.deepEqual(results.map((r) => r.receipt.state).sort(), ["accepted", "rejected"]);
	assert.equal((await f.write(state, "interview-submit")).receipt.state, "rejected");
	const latest = f.store.interviews.latest(state.fence.missionId)!;
	const submitted = await f.write(latest, "interview-submit");
	assert.equal((await f.run(submitted.op)).state, "accepted");
	assert.equal((await f.write(latest, "interview-submit")).receipt.state, "rejected");
	const op = continuation(submitted.state);
	assert.equal((await f.run(op)).state, "accepted");
	assert.equal((await f.run(op)).state, "accepted");
	assert.equal((await f.run(continuation(submitted.state))).state, "rejected");
	assert.equal(f.calls, 1);
});

test("owner ABA invalidates saved interview; matching titles or answers do not restore it", async (t) => {
	const f = await fixture(t);
	const state = await f.submitted();
	const id = state.fence.missionId;
	f.store.join("other", id);
	f.store.update(id, { coordinatorSessionId: "other" });
	f.store.update(id, { coordinatorSessionId: state.fence.ownerSessionId });
	await assert.rejects(f.service().read(id), /owner or membership/);
	assert.equal((await f.run(continuation(state))).state, "rejected");
});

test("unrelated membership changes preserve interview progress without carrying approval forward", async (t) => {
	const f = await fixture(t);
	const state = await f.submitted();
	await f.approve(state);
	f.store.join("new-worker", state.fence.missionId);
	assert.deepEqual(await f.service().read(state.fence.missionId), state);
	assert.equal((await f.confirmations().current(state.fence.missionId)).state, "stale");
	assert.deepEqual((await f.approve(state)).prepared.package.agreement!.submission, state.submission);
});

test("complete snapshot is not approval; exact approval admits only its current agreement", async (t) => {
	const f = await fixture(t);
	const state = await f.submitted();
	const { op: approval, prepared } = await f.approve(state);
	assert.deepEqual(prepared.package.agreement!.submission, state.submission);
	const request: AgreementAdmission = {
		purpose: "agreement-start",
		fence: state.fence,
		submissionOperationId: state.submission!.operationId,
		submissionDigest: state.submission!.digest,
		approvalOperationId: approval.operationId,
		approvalDigest: prepared.package.digest,
		assignmentDigest: "assignment-owner-revision-1",
	};
	assert.equal(
		(await f.run(operation(request.purpose, state.fence.missionId, { ...request, approvalOperationId: "other" })))
			.state,
		"rejected",
	);
	const op = operation(request.purpose, state.fence.missionId, request);
	assert.equal((await f.run(op)).state, "accepted");
	assert.equal(f.calls, 1);
	const changed = await f.write(state, "interview-save", { answers: [answer(state.questions[0]!, "Changed scope")] });
	assert.equal(changed.receipt.state, "accepted");
	const resubmitted = await f.write(changed.state, "interview-submit");
	assert.equal(
		(
			await f.run(
				operation(request.purpose, state.fence.missionId, {
					...request,
					fence: resubmitted.state.fence,
					submissionOperationId: resubmitted.op.operationId,
					submissionDigest: resubmitted.state.submission!.digest,
					assignmentDigest: "new",
				}),
			)
		).state,
		"rejected",
	);
	assert.equal(f.calls, 1);
});

test("held agreement admission rechecks permissions, amendments and pending revocation at commit", async (t) => {
	for (const change of ["permission", "brief", "revocation", "assignment"] as const) {
		const f = await fixture(t);
		const state = await f.submitted();
		const { op: approval, prepared } = await f.approve(state);
		const request: AgreementAdmission = {
			purpose: "agreement-start",
			fence: state.fence,
			submissionOperationId: state.submission!.operationId,
			submissionDigest: state.submission!.digest,
			approvalOperationId: approval.operationId,
			approvalDigest: prepared.package.digest,
			assignmentDigest: "assignment-owner-revision-1",
		};
		f.beforeCommit = async () => {
			if (change === "permission") f.allowed = false;
			else if (change === "assignment") f.assignment = "assignment-owner-revision-2";
			else if (change === "brief")
				f.store.writeBrief(state.fence.missionId, "Not the approved scope", state.submission!.briefRevision);
			else {
				const p = await f.confirmations().prepare(state.fence.missionId, "workflow-revoke");
				await f.journal.reserve(
					operation("workflow-revoke", state.fence.missionId, { purpose: "workflow-revoke", ...p }),
				);
			}
		};
		const op = operation(request.purpose, state.fence.missionId, request);
		assert.equal((await f.run(op)).state, "pending");
		assert.equal((await f.run(op)).state, "pending");
		assert.equal(f.calls, 1);
	}
});

test("small asks create no mission, require independent admission and exact configuration", async (t) => {
	const f = await fixture(t);
	const op = smallAsk();
	f.allowed = false;
	assert.equal((await f.run(op)).state, "rejected");
	f.allowed = true;
	f.configuration = "config-2";
	assert.equal((await f.run(smallAsk())).state, "rejected");
	f.configuration = "config-1";
	f.adapterAvailable = false;
	assert.equal((await f.run(smallAsk())).state, "rejected");
	f.adapterAvailable = true;
	assert.equal((await f.run(smallAsk())).state, "accepted");
	assert.equal(f.store.list().length, 0);
	assert.equal(f.calls, 1);
});

test("final approval guard refuses a revocation still persisting, not just a published pending row", async (t) => {
	const f = await fixture(t);
	const state = await f.submitted();
	const { op, prepared } = await f.approve(state);
	const id = state.fence.missionId;
	await f.confirmations().current(id);
	f.confirmations().assertApproval(id, op.operationId, prepared.package.digest);
	const revoke = await f.confirmations().prepare(id, "workflow-revoke");
	const persisting = f.journal.reserve(operation("workflow-revoke", id, { purpose: "workflow-revoke", ...revoke }));
	assert.throws(() => f.confirmations().assertApproval(id, op.operationId, prepared.package.digest), /not settled/);
	await persisting;
	assert.throws(
		() => f.confirmations().assertApproval(id, op.operationId, prepared.package.digest),
		/Revocation is uncertain/,
	);
});

test("passive reads reject writes appended after the invoked durability barrier", async (t) => {
	const f = await fixture(t);
	const { state } = await f.create();
	let release!: () => void;
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	const original = f.store.durable.bind(f.store);
	t.mock.method(f.store, "durable", async () => {
		await original();
		await barrier;
	});
	const reading = f.service().read(state.fence.missionId);
	const op = operation("interview-save", state.fence.missionId, {
		purpose: "interview-save",
		expected: version(state),
		answers: [answer(state.questions[0]!)],
	});
	f.store.interviews.write(op, JSON.parse(op.payload), () => {});
	release();
	await assert.rejects(reading, /Interview changed/);
});

test("lost admission ACK recovers exact durable receipts after restart without replay", async (t) => {
	const f = await fixture(t, true);
	const state = await f.submitted();
	for (const op of [continuation(state), smallAsk()]) {
		f.loseAck = true;
		assert.equal((await f.run(op)).state, "pending");
		const calls = f.calls;
		await f.reopen();
		assert.equal((await f.journal.lookup(op))!.state, "accepted");
		assert.equal((await f.run(op)).state, "accepted");
		assert.equal(f.calls, calls);
	}
	assert.deepEqual(await f.service().read(state.fence.missionId), state);
});

test("missing entered effect and fresh-envelope retries remain blocked after recovery", async (t) => {
	const f = await fixture(t, true);
	const state = await f.submitted();
	const op = continuation(state);
	f.failBefore = true;
	assert.equal((await f.run(op)).state, "pending");
	f.failBefore = false;
	await f.reopen();
	assert.equal((await f.run(op)).state, "pending");
	assert.equal((await f.run(continuation(state))).state, "rejected");
	assert.equal(f.calls, 1);
	const small = smallAsk();
	f.failBefore = true;
	assert.equal((await f.run(small)).state, "pending");
	f.failBefore = false;
	assert.equal((await f.run(operation(small.kind, small.targetId, JSON.parse(small.payload)))).state, "rejected");
});

test("reservation without checkpoint and missing saved rows are Unknown, not new writes", async (t) => {
	const f = await fixture(t);
	const { state } = await f.create();
	const op = operation("interview-save", state.fence.missionId, {
		purpose: "interview-save",
		expected: version(state),
		answers: [answer(state.questions[0]!)],
	});
	await f.journal.reserve(op);
	assert.equal((await f.run(op)).state, "pending");
	assert.deepEqual(f.store.interviews.latest(state.fence.missionId), state);
	await f.journal.checkpoint(op, { stage: "interview-effect-entered", purpose: op.kind, payloadHash: op.payloadHash });
	assert.equal((await f.run(op)).state, "pending");
	assert.deepEqual(f.store.interviews.latest(state.fence.missionId), state);
});

test("save and submission durability failures recover exact rows, never repeat the mapping", async (t) => {
	const f = await fixture(t);
	let { state } = await f.create();
	const original = f.store.durable.bind(f.store);
	let fail = true;
	t.mock.method(f.store, "durable", async () => {
		if (fail) throw new Conflict("Disk ACK lost");
		await original();
	});
	const save = await f.write(state, "interview-save", { answers: [answer(state.questions[0]!)] });
	assert.equal(save.receipt.state, "pending");
	fail = false;
	assert.equal((await f.run(save.op)).state, "accepted");
	state = save.state;
	fail = true;
	const submitted = await f.write(state, "interview-submit");
	assert.equal(submitted.receipt.state, "pending");
	const revision = f.store.require(state.fence.missionId).briefRevision;
	fail = false;
	assert.equal((await f.run(submitted.op)).state, "accepted");
	assert.equal(f.store.require(state.fence.missionId).briefRevision, revision);
});
