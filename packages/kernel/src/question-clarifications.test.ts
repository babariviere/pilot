import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createSession, InboxDoc, LiveDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { admitWithHeld, holdOnStop, publishQuestionWithHeld } from "./held-inputs.ts";
import { HeldInputsDoc } from "./held-inputs-doc.ts";
import { QuestionClarifications } from "./question-clarifications.ts";

async function fixture(t: TestContext) {
	const storage = new MemoryStorage();
	const session = createSession(storage);
	t.after(() => session.close(context));
	const conversation = await session.commit(
		(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
		context,
	);
	const id = conversation.id;
	const read = (submission: Parameters<typeof storage.submission>[0]) => storage.submission(submission, context);
	await admitWithHeld(
		session,
		id,
		{ requestId: "mission:send:next", content: "Automatic follow-up", mode: "followUp" },
		context,
	);
	await publishQuestionWithHeld(
		session,
		id,
		read,
		"original-question",
		{ question: "Keep the existing API?" },
		context,
	);
	const questionId = Number((await storage.submissionByRequest(id, "original-question", context))!.entry);
	let calls = 0;
	const requests = new QuestionClarifications(session, id, async (_request, signal) => {
		calls++;
		signal.throwIfAborted();
		return "Keeping it avoids breaking callers.";
	});
	return { storage, session, id, read, questionId, requests, calls: () => calls };
}

test("clarification keeps the original question, held inputs and run unchanged; exact retry only reads", async (t) => {
	const f = await fixture(t);
	const before = await f.session.snapshot(HeldInputsDoc, f.id, context);
	const live = await f.session.snapshot(LiveDoc, f.id, context);
	const inbox = await f.session.snapshot(InboxDoc, f.id, context);
	const request = { operationId: "clarification-one", questionId: f.questionId, question: "Why keep it?" };
	assert.equal((await f.requests.request(request)).answer, "Keeping it avoids breaking callers.");
	assert.equal((await f.requests.request(request)).questionId, f.questionId);
	assert.equal(f.calls(), 1);
	assert.deepEqual(await f.session.snapshot(HeldInputsDoc, f.id, context), before);
	assert.deepEqual(await f.session.snapshot(LiveDoc, f.id, context), live);
	assert.deepEqual(await f.session.snapshot(InboxDoc, f.id, context), inbox);
	await assert.rejects(f.requests.request({ ...request, question: "Different bytes" }), /changed/);
});

test("follow-up clarification includes the prior exchange without releasing the original hold", async (t) => {
	const f = await fixture(t);
	const first = { operationId: "first", questionId: f.questionId, question: "Why keep it?" };
	await f.requests.request(first);
	const next = new QuestionClarifications(f.session, f.id, async (source) => {
		assert.deepEqual(source.previous, [{ ...first, answer: "Keeping it avoids breaking callers." }]);
		return "Callers are programs using the API.";
	});
	await next.request({ operationId: "next", questionId: f.questionId, question: "What are callers?" });
	assert.equal((await f.session.snapshot(HeldInputsDoc, f.id, context))!.questionPending, true);
});

test("a lost or cancelled clarification never repeats a provider effect", async (t) => {
	const f = await fixture(t);
	let calls = 0;
	const requests = new QuestionClarifications(f.session, f.id, async () => {
		calls++;
		throw new Error("lost provider response");
	});
	const request = { operationId: "lost", questionId: f.questionId, question: "Why?" };
	await assert.rejects(requests.request(request), /lost provider response/);
	await assert.rejects(requests.request(request), /Unknown|inspect/);
	const restored = new QuestionClarifications(f.session, f.id, async () => {
		assert.fail("recovery must not send");
	});
	await assert.rejects(restored.request(request), /Unknown|inspect/);
	await assert.rejects(restored.request({ ...request, operationId: "another" }), /Unknown earlier clarification/);
	assert.equal(calls, 1);
});

test("Stop and a replaced question refuse clarification before a provider call", async (t) => {
	const f = await fixture(t);
	await publishQuestionWithHeld(f.session, f.id, f.read, "new-question", { question: "Which version?" }, context);
	await assert.rejects(
		f.requests.request({ operationId: "stale", questionId: f.questionId, question: "Why?" }),
		/question.*changed/i,
	);
	await holdOnStop(f.session, f.id, f.read, context);
	await assert.rejects(
		f.requests.request({ operationId: "stopped", questionId: f.questionId, question: "Why?" }),
		/stopped/i,
	);
	assert.equal(f.calls(), 0);
});
