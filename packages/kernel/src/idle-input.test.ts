import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	ConversationBusy,
	createRegistry,
	Harness,
	InboxDoc,
	LiveDoc,
	MemoryStorage,
	UserEntry,
} from "@earendil-works/pi-durable";
import { submitIdleInput } from "./idle-input.ts";

async function fixture(t: TestContext) {
	const storage = new MemoryStorage();
	const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, context);
	t.after(() => harness.close(context));
	const conversation = await harness.root(context);
	// Inspect admission independently of model scheduling. Session integration tests drive real generation.
	const resume = t.mock.method(harness, "resume", () => {});
	t.mock.method(conversation, "submit", () => assert.fail("idle admission must not use a second submission commit"));
	return { storage, harness, conversation, resume };
}

test("idle input atomically commits entry, placed submission and Harness generation, and retries idempotently", async (t) => {
	const { storage, harness, conversation, resume } = await fixture(t);
	const commit = t.mock.method(conversation, "commit", conversation.commit.bind(conversation));
	await submitIdleInput(harness, conversation, "idle", "Prepared user input", context);
	assert.equal(commit.mock.callCount(), 1);
	assert.equal(resume.mock.callCount(), 1);
	const entry = (await conversation.entries({}, 100, undefined, context)).items.find(
		(entry) => entry.kind === UserEntry.kind,
	);
	assert.ok(entry);
	assert.deepEqual(
		entry.model?.map((message) => ({ role: message.role, content: message.content })),
		[{ role: "user", content: "Prepared user input" }],
	);
	const submission = await storage.submissionByRequest(conversation.id, "idle", context);
	assert.equal(submission?.status, "placed");
	assert.equal(submission?.entry, entry.id);
	const live = await harness.snapshot(LiveDoc, conversation.id, context);
	assert.deepEqual(live?.run?.inputs, [submission?.id]);
	const task = await harness.getTask(live!.run!.taskId, context);
	assert.equal(task?.kind, "pi.generation");
	assert.equal(task?.conversationId, conversation.id);
	await submitIdleInput(harness, conversation, "idle", "Do not append retry", context);
	assert.equal(
		(await conversation.entries({}, 100, undefined, context)).items.filter((entry) => entry.kind === UserEntry.kind)
			.length,
		1,
	);
	assert.equal(resume.mock.callCount(), 2, "idempotent retries also request scheduling progress");
	await assert.rejects(submitIdleInput(harness, conversation, "different", "Busy", context), ConversationBusy);
});

for (const raced of ["inbox", "compaction"] as const) {
	test(`a ${raced} admitted before the idle transaction rejects atomically without appending auto input`, async (t) => {
		const { storage, harness, conversation, resume } = await fixture(t);
		const commit = conversation.commit.bind(conversation);
		t.mock.method(conversation, "commit", async (...[change, context]: Parameters<typeof commit>) => {
			await commit(async (tx) => {
				if (raced === "inbox") {
					const queued = await tx.createSubmission({
						conversationId: conversation.id,
						requestId: "user",
						type: "input",
						status: "queued",
					});
					(await tx.doc(InboxDoc, conversation.id)).items.push({
						id: queued.id,
						content: "User queued first",
						mode: "followUp",
					});
				} else {
					(await tx.doc(LiveDoc, conversation.id)).compactions = [
						{ taskId: 999 as never, reason: "manual", blocking: false, attempt: 1 },
					];
				}
			}, context);
			return commit(change, context);
		});
		await assert.rejects(
			submitIdleInput(harness, conversation, "auto", "Must not append or queue", context),
			ConversationBusy,
		);
		assert.equal(await storage.submissionByRequest(conversation.id, "auto", context), undefined);
		assert.equal((await conversation.entries({}, 100, undefined, context)).items.length, 0);
		assert.equal((await harness.inspect(context)).tasks.length, 0);
		assert.equal(resume.mock.callCount(), 0);
	});
}

test("failed idle admission rolls back its entry and submission if generation creation fails", async (t) => {
	const { storage, harness, conversation, resume } = await fixture(t);
	const commit = conversation.commit.bind(conversation);
	t.mock.method(conversation, "commit", (...[change, context]: Parameters<typeof commit>) =>
		commit(async (tx) => {
			t.mock.method(tx, "createTask", () => {
				throw new Error("generation admission failed");
			});
			return change(tx);
		}, context),
	);
	await assert.rejects(
		submitIdleInput(harness, conversation, "auto", "Rollback", context),
		/generation admission failed/,
	);
	assert.equal(await storage.submissionByRequest(conversation.id, "auto", context), undefined);
	assert.equal((await conversation.entries({}, 100, undefined, context)).items.length, 0);
	assert.equal((await harness.snapshot(LiveDoc, conversation.id, context))?.run, undefined);
	assert.equal(resume.mock.callCount(), 0);
});
