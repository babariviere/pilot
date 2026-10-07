import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createSession, InboxDoc, MemoryStorage } from "@earendil-works/pi-durable";
import type { QueueUpdateEvent } from "@pilot/protocol";
import { queueUpdate, watchQueue } from "./queue.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("queue watch sends durable contents initially, on changes, and after reattachment", async () => {
	const session = createSession(new MemoryStorage());
	try {
		const conversation = await session.commit(async (tx) => {
			const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
			const input = await tx.createSubmission({ conversationId: conversation.id, type: "input", status: "queued" });
			const inbox = await tx.doc(InboxDoc, conversation.id);
			inbox.items.push({ id: input.id, mode: "followUp", content: "Run the tests\nReport failures" });
			return conversation;
		}, context);
		const watch = await watchQueue(session, conversation.id, context);
		assert.deepEqual(
			queueUpdate(watch.value).items.map((item) => item.content),
			["Run the tests\nReport failures"],
		);
		const updates: QueueUpdateEvent[] = [];
		let received = deferred();
		watch.start(async (inbox) => {
			updates.push(queueUpdate(inbox));
			received.resolve();
		});
		await session.commit(async (tx) => {
			const input = await tx.createSubmission({ conversationId: conversation.id, type: "input", status: "queued" });
			const write = await tx.createSubmission({ conversationId: conversation.id, type: "write", status: "queued" });
			const inbox = await tx.doc(InboxDoc, conversation.id);
			inbox.items.push({ id: input.id, mode: "steer", content: [{ type: "text", text: "Check lint too" }] });
			inbox.items.push({ id: write.id, mode: "write", entry: { kind: "notice" } });
		}, context);
		await received.promise;
		assert.deepEqual(
			updates.at(-1)?.items.map(({ mode, content }) => ({ mode, content })),
			[
				{ mode: "followUp", content: "Run the tests\nReport failures" },
				{ mode: "steer", content: [{ type: "text", text: "Check lint too" }] },
			],
		);
		await watch.stop();
		const reattached = await watchQueue(session, conversation.id, context);
		assert.deepEqual(queueUpdate(reattached.value), updates.at(-1));
		received = deferred();
		reattached.start(async (inbox) => {
			updates.push(queueUpdate(inbox));
			received.resolve();
		});
		await session.commit(async (tx) => {
			const inbox = await tx.doc(InboxDoc, conversation.id);
			inbox.items = [];
		}, context);
		await received.promise;
		assert.deepEqual(updates.at(-1), { type: "queue_update", items: [] });
		await reattached.stop();
	} finally {
		await session.close(context);
	}
});

test("a retired inbox clears the displayed queue", () => {
	assert.deepEqual(queueUpdate(null), { type: "queue_update", items: [] });
});
