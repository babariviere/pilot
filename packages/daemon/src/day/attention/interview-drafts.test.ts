import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { interviewDigest } from "@pilot/kernel/interview-round";
import type { DurableOperation, InterviewQuestion, NativeAttentionRequest } from "@pilot/protocol";
import { payloadHash } from "../../transport/operations/operation-journal.ts";
import { attentionDigest } from "./attention-store.ts";
import { nativeAttentionFixture } from "./native-attention.fixture.ts";

test("standalone interview drafts survive restart, refuse stale saves and never submit", async (t) => {
	const f = await nativeAttentionFixture();
	t.after(() => f.close());
	const question: InterviewQuestion = {
		id: "scope",
		section: "outcome",
		prompt: "What should change?",
		options: [],
		recommendedOptionId: null,
	};
	const questionDigest = interviewDigest(question);
	f.session = { ...f.session, mode: "ask", missionId: undefined };
	f.question = {
		...f.question,
		data: {
			question: "Questions before proceeding",
			options: [],
			interview: { roundId: "round-one", questions: [question], questionDigests: { scope: questionDigest } },
		},
	};
	const { scope } = (await f.read()).questions[0]!;
	const read = {
		...f.envelope(),
		kind: "interview-draft",
		scope,
		roundId: "round-one",
	} satisfies NativeAttentionRequest;
	const draft = (text: string) => ({
		roundId: "round-one",
		answers: [{ questionId: "scope", questionDigest, selectedOption: null, text }],
	});
	const save = (expectedRevision: number | null, text: string) =>
		({
			...f.envelope(),
			kind: "interview-draft-save",
			scope,
			expectedRevision,
			draft: draft(text),
		}) satisfies NativeAttentionRequest;
	const call = async (input: NativeAttentionRequest, lookup = false) => (await f.post(input, lookup)).json();

	assert.equal((await f.post(read, false, "")).status, 403);
	assert.equal((await call({ ...read, projectId: randomUUID() })).ok, false);
	assert.deepEqual(await call(read), { ok: true, value: null });
	assert.equal((await call(save(null, ""), true)).error.code, "invalid");
	assert.deepEqual(await call(read), { ok: true, value: null });
	assert.deepEqual(await call(save(null, "")), { ok: true, value: { ...draft(""), revision: 1 } });
	const second = { ...draft("  Limit edits to the docs.\n "), revision: 2 };
	assert.deepEqual(await call(save(1, second.answers[0]!.text)), { ok: true, value: second });
	assert.equal((await call(save(1, "Another window's unsaved words"))).error.code, "conflict");
	await f.restart();
	assert.deepEqual(await call(read, true), { ok: true, value: second });
	assert.equal((await call({ ...read, roundId: "round-two" })).error.code, "stale");
	assert.equal(f.sends, 0);

	const submission = (revision: number, text: string): DurableOperation => {
		const payload = JSON.stringify({
			projectId: f.project.id,
			scope,
			interview: draft(text),
			draftRevision: revision,
		});
		return {
			schemaVersion: 1,
			operationId: randomUUID(),
			producerId: randomUUID(),
			sequence: 1,
			origin: { ...f.host, hostId: "local" },
			destination: f.host,
			kind: "attention-answer",
			targetId: f.owner,
			payload,
			payloadHash: payloadHash(payload),
			bindingId: attentionDigest(scope),
			bindingGeneration: 1,
		};
	};
	const submit = async (op: DurableOperation, lookup = false) =>
		(
			await fetch(`${f.root}/api/operations${lookup ? "/receipt" : ""}`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-pilot-github-capability": f.capability },
				body: JSON.stringify(op),
			})
		).json();

	assert.equal((await submit(submission(1, second.answers[0]!.text))).state, "rejected");
	assert.equal((await submit(submission(2, "Different words"))).state, "rejected");
	assert.equal(f.sends, 0);
	// The fixture lets us observe delivery admission, then drops the acknowledgement.
	const op = submission(2, second.answers[0]!.text);
	assert.equal((await submit(op)).state, "pending");
	assert.equal(f.sends, 1);
	const third = { ...draft("Newer unsent words"), revision: 3 };
	assert.deepEqual(await call(save(2, third.answers[0]!.text)), { ok: true, value: third });
	await f.restart();
	assert.equal((await submit(op, true)).state, "pending");
	assert.equal(f.sends, 1);
	assert.deepEqual(await call(read), { ok: true, value: third });
});
