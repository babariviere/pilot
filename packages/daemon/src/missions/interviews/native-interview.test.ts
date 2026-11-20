import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { interviewDigest, validateQuestions } from "@pilot/kernel/interview-round";
import type { DurableOperation, InterviewQuestion, StandaloneInterviewReply } from "@pilot/protocol";
import { attentionDigest } from "../../day/attention/attention-store.ts";
import { nativeAttentionFixture } from "../../day/attention/native-attention.fixture.ts";
import { payloadHash } from "../../transport/operations/operation-journal.ts";

const questions: InterviewQuestion[] = [
	{
		id: "scope",
		section: "outcome",
		prompt: "What changes?",
		options: [{ id: "fix", meaning: "Fix export" }],
		recommendedOptionId: "fix",
	},
];
const reply = (): StandaloneInterviewReply => ({
	roundId: "saved-round",
	answers: [
		{
			questionId: "scope",
			questionDigest: interviewDigest(questions[0]),
			selectedOption: questions[0]!.options[0]!,
			text: "  Extra detail\n日本  ",
		},
	],
});

test("native attention shows valid full rounds whose digest wrapper exceeds 44 KiB", async (t) => {
	const f = await nativeAttentionFixture();
	t.after(() => f.close());
	const fullRound: InterviewQuestion[] = Array.from({ length: 40 }, (_, index) => ({
		id: `q${index}`.padEnd(128, "x"),
		section: "outcome",
		prompt: "p".repeat(750),
		options: [],
		recommendedOptionId: null,
	}));
	validateQuestions(fullRound);
	f.session = { ...f.session, mode: "ask", missionId: undefined };
	const data = {
		question: "Questions before proceeding",
		options: [],
		interview: {
			roundId: "large-saved-round",
			questions: fullRound,
			questionDigests: Object.fromEntries(fullRound.map((question) => [question.id, interviewDigest(question)])),
		},
	};
	assert.ok(Buffer.byteLength(JSON.stringify(fullRound)) < 40 * 1024);
	assert.ok(Buffer.byteLength(JSON.stringify(data)) > 44 * 1024);
	f.question = { ...f.question, data };
	const visible = (await f.read()).questions;
	assert.equal(visible.length, 1, "a saved valid round must not leave an invisible admission hold");
	assert.deepEqual(visible[0]!.question.interview, data.interview);
});

for (const mode of ["build", "ask"] as const)
	test(`native ${mode} interview accepts only exact complete human submission`, async (t) => {
		const f = await nativeAttentionFixture();
		t.after(() => f.close());
		f.session = { ...f.session, mode, missionId: undefined };
		f.question = {
			...f.question,
			data: {
				question: "Questions before proceeding",
				options: [],
				interview: { roundId: "saved-round", questions, questionDigests: { scope: interviewDigest(questions[0]) } },
			},
		};
		const q = (await f.read()).questions[0]!;
		assert.ok(q, "Ask interviews are visible without Build permissions");
		let sends = 0;
		f.sessions.sendDurable = async (session, _content, _mode, _operation, options) => {
			sends++;
			assert.equal(session, f.owner);
			assert.deepEqual(options?.interviewReply, reply());
			assert.equal(options?.questionReplyId, q.scope.subject.kind === "question" ? q.scope.subject.entryId : 0);
		};
		const submit = async (body: Record<string, unknown>) => {
			const payload = JSON.stringify({ projectId: f.project.id, scope: q.scope, ...body });
			const op: DurableOperation = {
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
				bindingId: attentionDigest(q.scope),
				bindingGeneration: 1,
			};
			return (
				await fetch(`${f.root}/api/operations`, {
					method: "POST",
					headers: { "content-type": "application/json", "x-pilot-github-capability": f.capability },
					body: JSON.stringify(op),
				})
			).json();
		};
		for (const interview of [
			{ ...reply(), answers: [] },
			{ ...reply(), roundId: "other-round" },
			{ ...reply(), answers: reply().answers.map((a) => ({ ...a, questionDigest: "forged" })) },
			{
				...reply(),
				answers: reply().answers.map((a) => ({
					...a,
					selectedOption: { id: "fix", meaning: "Different meaning" },
				})),
			},
			{ ...reply(), answers: reply().answers.map((a) => ({ ...a, selectedOption: null, text: " " })) },
		])
			assert.equal((await submit({ interview })).state, "rejected");
		assert.notEqual((await submit({ message: "Yes, do it" })).state, "accepted");
		assert.equal(sends, 0);
		assert.equal((await submit({ interview: reply() })).state, "accepted");
		assert.equal(sends, 1);
	});
