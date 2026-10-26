import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createSession, InboxDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { editQueuedMessage, queueGuardToken, queueUpdateForDisplay, removeQueuedMessage } from "./queue.ts";

test("captured row guard atomically rejects unseen edits/removals, preserves mode, and never resubmits", async () => {
	const storage = new MemoryStorage();
	const session = createSession(storage);
	try {
		const { conversation, input } = await session.commit(async (tx) => {
			const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
			const input = await tx.createSubmission({
				conversationId: conversation.id,
				type: "input",
				status: "queued",
				requestId: "user:1",
			});
			(await tx.doc(InboxDoc, conversation.id)).items.push({ id: input.id, mode: "followUp", content: "Original" });
			return { conversation, input };
		}, context);
		const read = () => session.snapshot(InboxDoc, conversation.id, context);
		const capture = (await queueUpdateForDisplay((await read()) ?? null, (id) => storage.submission(id, context)))
			.items[0]!;
		assert.equal(capture.guardToken, queueGuardToken(capture));
		// Another client mutates on the same line before this captured operation.
		await editQueuedMessage(session, conversation.id, input.id, "Other client", context, "steer");
		await assert.rejects(
			editQueuedMessage(session, conversation.id, input.id, "Stale edit", context, undefined, capture.guardToken),
			/changed/,
		);
		await assert.rejects(
			removeQueuedMessage(session, conversation.id, input.id, context, capture.guardToken),
			/changed/,
		);
		assert.deepEqual(
			(await read())!.items.map((i) => ({ id: i.id, mode: i.mode, content: i.mode === "write" ? null : i.content })),
			[{ id: input.id, mode: "steer", content: "Other client" }],
		);
		const token = queueGuardToken((await read())!.items[0]!);
		await editQueuedMessage(session, conversation.id, input.id, "Exact edit", context, undefined, token);
		assert.equal((await read())!.items[0]!.mode, "steer", "omitted mode preserves current delivery");
		await assert.rejects(removeQueuedMessage(session, conversation.id, input.id, context, token), /changed/);
		await removeQueuedMessage(
			session,
			conversation.id,
			input.id,
			context,
			queueGuardToken((await read())!.items[0]!),
		);
		await assert.rejects(
			editQueuedMessage(session, conversation.id, input.id, "No new send", context, undefined, capture.guardToken),
			/no longer queued/,
		);
		assert.equal((await read())!.items.length, 0);
		assert.equal(
			(await storage.scanEntries({ conversationId: conversation.id }, 10, undefined, context)).items.length,
			0,
		);
	} finally {
		await session.close(context);
	}
});

test("guarded text editing refuses structured/image content without loss; exact removal remains possible", async () => {
	const session = createSession(new MemoryStorage());
	try {
		const { conversation, input } = await session.commit(async (tx) => {
			const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
			const input = await tx.createSubmission({ conversationId: conversation.id, type: "input", status: "queued" });
			(await tx.doc(InboxDoc, conversation.id)).items.push({
				id: input.id,
				mode: "followUp",
				content: [
					{ type: "text", text: "Original" },
					{ type: "image", data: "preserved", mimeType: "image/png" },
				],
			});
			return { conversation, input };
		}, context);
		const before = await session.snapshot(InboxDoc, conversation.id, context);
		const token = queueGuardToken(before!.items[0]!);
		await assert.rejects(
			editQueuedMessage(session, conversation.id, input.id, "Text only", context, undefined, token),
			/Structured/,
		);
		assert.deepEqual(await session.snapshot(InboxDoc, conversation.id, context), before);
		await removeQueuedMessage(session, conversation.id, input.id, context, token);
	} finally {
		await session.close(context);
	}
});
