import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createSession, InboxDoc, MemoryStorage } from "@earendil-works/pi-durable";
import type { QueueUpdateEvent } from "@pilot/protocol";
import { editQueuedMessage, queueUpdate, queueUpdateForDisplay, watchQueue } from "./queue.ts";

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

test("display queue hides only job notifications, without changing durable input or matching user text", async () => {
	const storage = new MemoryStorage();
	const session = createSession(storage);
	try {
		const conversation = await session.commit(async (tx) => {
			const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
			const inbox = await tx.doc(InboxDoc, conversation.id);
			for (const [requestId, mode, content] of [
				["user:1", "followUp", "Background job tests finished. Output: logs"],
				["native:jobs.result:abc", "followUp", "Job result"],
				["native:subagent.result:def", "followUp", "Subagent result"],
				["native:user:ghi", "steer", "User steering"],
				["native:jobs.result:jkl", "steer", "Job steering"],
			] as const) {
				const input = await tx.createSubmission({
					conversationId: conversation.id,
					requestId,
					type: "input",
					status: "queued",
				});
				inbox.items.push({ id: input.id, mode, content });
			}
			return conversation;
		}, context);
		const readSubmission = (id: Parameters<typeof storage.submission>[0]) => storage.submission(id, context);
		const watch = await watchQueue(session, conversation.id, context);
		const original = structuredClone(watch.value);
		const displayed = await queueUpdateForDisplay(watch.value, readSubmission);
		assert.deepEqual(
			displayed.items.map((item) => item.content),
			["Background job tests finished. Output: logs", "Subagent result", "User steering"],
		);
		assert.deepEqual(watch.value, original, "filtering never withdraws or edits input");
		await watch.stop();
		const reattached = await watchQueue(session, conversation.id, context);
		assert.deepEqual(await queueUpdateForDisplay(reattached.value, readSubmission), displayed);
		await reattached.stop();
		assert.deepEqual(await queueUpdateForDisplay(null, readSubmission), { type: "queue_update", items: [] });
	} finally {
		await session.close(context);
	}
});

test("editing queued messages preserves IDs, delivery modes, order, and broadcasts committed content", async () => {
	const storage = new MemoryStorage();
	const session = createSession(storage);
	try {
		const { conversation, first, second, write } = await session.commit(async (tx) => {
			const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
			const first = await tx.createSubmission({ conversationId: conversation.id, type: "input", status: "queued" });
			const second = await tx.createSubmission({ conversationId: conversation.id, type: "input", status: "queued" });
			const write = await tx.createSubmission({ conversationId: conversation.id, type: "write", status: "queued" });
			const inbox = await tx.doc(InboxDoc, conversation.id);
			inbox.items = [
				{ id: first.id, mode: "followUp", content: "Original follow-up" },
				{ id: second.id, mode: "steer", content: "Original steering" },
				{ id: write.id, mode: "write", entry: { kind: "notice" } },
			];
			return { conversation, first, second, write };
		}, context);
		const watch = await watchQueue(session, conversation.id, context);
		const updated = deferred();
		watch.start(async (inbox) => {
			if (queueUpdate(inbox).items[0]?.content === "Edited follow-up\nWith details") updated.resolve();
		});
		await editQueuedMessage(session, conversation.id, first.id, "Edited follow-up\nWith details", context);
		await updated.promise;
		await editQueuedMessage(session, conversation.id, second.id, "Edited steering", context);
		const restored = await watchQueue(session, conversation.id, context);
		assert.deepEqual(queueUpdate(restored.value).items, [
			{ id: first.id, mode: "followUp", content: "Edited follow-up\nWith details" },
			{ id: second.id, mode: "steer", content: "Edited steering" },
		]);
		assert.equal(restored.value?.items[2]?.mode, "write");
		assert.deepEqual(await storage.submission(first.id, context), first, "editing does not resubmit");
		assert.deepEqual(
			(await storage.scanEntries({ conversationId: conversation.id }, 100, undefined, context)).items,
			[],
		);
		await assert.rejects(
			editQueuedMessage(session, conversation.id, write.id, "Not input", context),
			/no longer queued/,
		);
		for (const id of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
			await assert.rejects(
				editQueuedMessage(session, conversation.id, id, "Edit", context),
				/Invalid queued message ID/,
			);
		}
		await assert.rejects(
			editQueuedMessage(session, conversation.id, first.id, " \n ", context),
			/message is required/,
		);
		assert.deepEqual(
			queueUpdate((await session.snapshot(InboxDoc, conversation.id, context)) ?? null),
			queueUpdate(restored.value),
		);
		await Promise.all([watch.stop(), restored.stop()]);
	} finally {
		await session.close(context);
	}
});

test("an edit racing consumption or withdrawal fails without resubmitting or changing history", async () => {
	const session = createSession(new MemoryStorage());
	try {
		const { conversation, other, input } = await session.commit(async (tx) => {
			const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
			const other = await tx.createConversation({ ownership: { kind: "ownerless" } });
			const input = await tx.createSubmission({ conversationId: conversation.id, type: "input", status: "queued" });
			(await tx.doc(InboxDoc, conversation.id)).items.push({ id: input.id, mode: "followUp", content: "Original" });
			return { conversation, other, input };
		}, context);
		await assert.rejects(
			editQueuedMessage(session, other.id, input.id, "Wrong conversation", context),
			/no longer queued/,
		);
		// Consume on the mutation line immediately before the edit; the edited input must never become a new prompt.
		const consumption = session.commit(async (tx) => {
			const inbox = await tx.doc(InboxDoc, conversation.id);
			const entry = await tx.appendEntry(conversation.id, {
				kind: "pi.user",
				model: [{ role: "user", content: "Original", timestamp: 0 }],
			});
			tx.placeSubmission(input.id, entry.id);
			inbox.items = [];
		}, context);
		const edit = editQueuedMessage(session, conversation.id, input.id, "Too late", context);
		await consumption;
		await assert.rejects(edit, /no longer queued/);
		assert.deepEqual(queueUpdate((await session.snapshot(InboxDoc, conversation.id, context)) ?? null).items, []);
		await assert.rejects(editQueuedMessage(session, conversation.id, input.id, "Retry", context), /no longer queued/);
		const withdrawn = await session.commit(async (tx) => {
			const input = await tx.createSubmission({ conversationId: conversation.id, type: "input", status: "queued" });
			tx.settleSubmission(input.id, { status: "unanswered", reason: "aborted" });
			return input;
		}, context);
		await assert.rejects(
			editQueuedMessage(session, conversation.id, withdrawn.id, "Too late", context),
			/no longer queued/,
		);
	} finally {
		await session.close(context);
	}
});
