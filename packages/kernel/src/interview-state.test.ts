import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createSession, InboxDoc, MemoryStorage } from "@earendil-works/pi-durable";
import type { InterviewQuestion, StandaloneInterviewReply } from "@pilot/protocol";
import {
	admitWithHeld,
	HeldInputsDoc,
	holdOnStop,
	initializeQuestionHold,
	publishQuestionWithHeld,
} from "./held-inputs.ts";
import { interviewDigest } from "./interview-round.ts";
import { interviewQuestion, StandaloneInterviewDoc } from "./interview-state.ts";

const questions: InterviewQuestion[] = [
	{
		id: "scope",
		section: "outcome",
		prompt: "What should change?",
		options: [{ id: "fix", meaning: "Fix the export" }],
		recommendedOptionId: "fix",
	},
	{ id: "check", section: "acceptance", prompt: "How do we check it?", options: [], recommendedOptionId: null },
];
const reply = (): StandaloneInterviewReply => ({
	roundId: "round-one",
	answers: questions.map((q) => ({
		questionId: q.id,
		questionDigest: interviewDigest(q),
		selectedOption: q.options[0] ?? null,
		text: q.id === "check" ? "  Existing tests\n日本  " : "",
	})),
});
async function fixture() {
	const storage = new MemoryStorage();
	const session = createSession(storage);
	const conversation = await session.commit(
		(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
		context,
	);
	const read = (id: Parameters<typeof storage.submission>[0]) => storage.submission(id, context);
	const publish = (expected: string | null = null, roundId = "round-one") =>
		publishQuestionWithHeld(
			session,
			conversation.id,
			read,
			`interview:${roundId}`,
			{ ...interviewQuestion(roundId, questions) },
			context,
			expected,
		);
	await publish();
	const state = (await session.snapshot(StandaloneInterviewDoc, conversation.id, context))!;
	const input = () => ({
		requestId: "native-interview-submit",
		content: "Transport placeholder",
		mode: "followUp" as const,
		questionReplyId: state.round!.entryId,
		interviewReply: reply(),
	});
	return { storage, session, conversation, read, publish, input };
}

test("standalone publication saves the full round and durable nonblocking hold", async () => {
	const f = await fixture();
	try {
		const held = (await f.session.snapshot(HeldInputsDoc, f.conversation.id, context))!;
		assert.equal(held.questionPending, true);
		assert.ok(held.interviewPending);
		assert.equal(held.blockingQuestion, undefined);
		const state = (await f.session.snapshot(StandaloneInterviewDoc, f.conversation.id, context))!;
		assert.deepEqual(state.round!.questions, questions);
		assert.equal(state.round!.submission, null);
		assert.equal(await initializeQuestionHold(f.session, f.conversation.id, f.read, context), true);
		await f.publish(); // Same retained tool call dedupes, even with its earlier expected token.
		await assert.rejects(f.publish(null, "new-round"), /pending question/);
		await assert.rejects(f.publish("1", "replacement"), /pending question/);
		assert.deepEqual(
			await f.session.snapshot(StandaloneInterviewDoc, f.conversation.id, context),
			state,
			"even a current token cannot replace a round before the human submits it",
		);
	} finally {
		await f.session.close(context);
	}
});

test("ordinary messages, coordinator answers and incomplete submissions cannot release an interview", async () => {
	const f = await fixture();
	try {
		await assert.rejects(
			admitWithHeld(
				f.session,
				f.conversation.id,
				{ requestId: "user-message", content: "go ahead", mode: "followUp" },
				context,
			),
			/complete saved interview/,
		);
		await assert.rejects(
			admitWithHeld(
				f.session,
				f.conversation.id,
				{
					requestId: "mission:send:coordinator",
					content: "yes",
					mode: "followUp",
					answerQuestionId: f.input().questionReplyId,
				},
				context,
			),
			/complete saved interview/,
		);
		for (const bad of [
			{ ...reply(), answers: [] },
			{ ...reply(), roundId: "another" },
			{ ...reply(), answers: reply().answers.map((a) => ({ ...a, questionDigest: "forged" })) },
			{ ...reply(), answers: reply().answers.map((a) => ({ ...a, selectedOption: null, text: " " })) },
		])
			await assert.rejects(
				admitWithHeld(f.session, f.conversation.id, { ...f.input(), interviewReply: bad }, context),
			);
		assert.equal((await f.session.snapshot(HeldInputsDoc, f.conversation.id, context))?.questionPending, true);
		assert.equal(
			(await f.session.snapshot(StandaloneInterviewDoc, f.conversation.id, context))?.round?.submission,
			null,
		);
		const automatic = await admitWithHeld(
			f.session,
			f.conversation.id,
			{ requestId: "automation:run.finished:test", content: "automatic result", mode: "followUp" },
			context,
		);
		assert.equal(automatic?.held, true);
	} finally {
		await f.session.close(context);
	}
});

test("explicit submission atomically saves exact evidence, releases once and restores model context", async () => {
	const f = await fixture();
	try {
		const admitted = await admitWithHeld(f.session, f.conversation.id, f.input(), context);
		assert.ok(admitted?.id);
		const duplicate = await admitWithHeld(f.session, f.conversation.id, f.input(), context);
		assert.equal(duplicate?.id, admitted.id);
		const state = (await f.session.snapshot(StandaloneInterviewDoc, f.conversation.id, context))!;
		assert.deepEqual(state.round!.submission!.answers, reply().answers);
		assert.equal(state.round!.submission!.operationId, "native-interview-submit");
		assert.equal((await f.session.snapshot(HeldInputsDoc, f.conversation.id, context))?.questionPending, false);
		const entries = (await f.storage.scanEntries({ conversationId: f.conversation.id }, 100, undefined, context))
			.items;
		assert.equal(entries.filter((e) => e.kind === "pilot.interview-submission").length, 1);
		const user = entries.find((e) => e.kind === "pi.user");
		assert.match(JSON.stringify(user?.model), /Existing tests/);
		assert.doesNotMatch(JSON.stringify(user?.model), /Transport placeholder/);
		assert.equal((await f.session.snapshot(InboxDoc, f.conversation.id, context))?.items.length, 0);
		await assert.rejects(f.publish("1", "stale-round"), /revision changed/);
		await f.publish("2", "next-round");
		assert.equal(
			(await f.session.snapshot(StandaloneInterviewDoc, f.conversation.id, context))?.round?.roundId,
			"next-round",
			"a fresh token can open a round after complete submission",
		);
	} finally {
		await f.session.close(context);
	}
});

test("Stop cancels interview admission without accepting its recommendations or answers", async () => {
	const f = await fixture();
	try {
		await holdOnStop(f.session, f.conversation.id, f.read, context);
		await assert.rejects(admitWithHeld(f.session, f.conversation.id, f.input(), context), /no longer pending/);
		assert.equal(
			(await f.session.snapshot(StandaloneInterviewDoc, f.conversation.id, context))?.round?.submission,
			null,
		);
	} finally {
		await f.session.close(context);
	}
});
