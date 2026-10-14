import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createSession, InboxDoc, MemoryStorage } from "@earendil-works/pi-durable";
import type { QueueUpdateEvent } from "@pilot/protocol";
import {
	editQueuedMessage,
	previewText,
	queueUpdate,
	queueUpdateForDisplay,
	watchQueue,
	withdrawUserMessages,
} from "./queue.ts";

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

test("display queue shows only user input, without changing durable input or matching user text", async () => {
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
				["mission:send:mno", "followUp", "\nCoordinator message\nDetails"],
				["mission-notice:7", "followUp", "Mission notice"],
				["pr-follow-up:pqr", "followUp", "PR follow-up"],
				["client-request", "followUp", "User follow-up"],
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
		const since = new Map<number, number>();
		const displayed = await queueUpdateForDisplay(watch.value, readSubmission, since, 1_000);
		assert.deepEqual(
			displayed.items.map((item) => item.content),
			["Background job tests finished. Output: logs", "User steering", "User follow-up"],
		);
		assert.deepEqual(
			displayed.automatic?.map(({ origin, mode, preview, queuedAt }) => ({ origin, mode, preview, queuedAt })),
			[
				{ origin: "job", mode: "followUp", preview: "Job result", queuedAt: 1_000 },
				{ origin: "subagent", mode: "followUp", preview: "Subagent result", queuedAt: 1_000 },
				{ origin: "job", mode: "steer", preview: "Job steering", queuedAt: 1_000 },
				{ origin: "coordinator", mode: "followUp", preview: "Coordinator message", queuedAt: 1_000 },
				{ origin: "mission", mode: "followUp", preview: "Mission notice", queuedAt: 1_000 },
				{ origin: "pullRequest", mode: "followUp", preview: "PR follow-up", queuedAt: 1_000 },
			],
			"automatic input is listed read-only, in submission order",
		);
		assert.deepEqual(watch.value, original, "filtering never withdraws or edits input");
		await watch.stop();
		const reattached = await watchQueue(session, conversation.id, context);
		assert.deepEqual(
			await queueUpdateForDisplay(reattached.value, readSubmission, since, 5_000),
			displayed,
			"a later update keeps each item's first-seen time",
		);
		await reattached.stop();
		assert.deepEqual(await queueUpdateForDisplay(null, readSubmission, since), {
			type: "queue_update",
			items: [],
			automatic: [],
		});
		assert.equal(since.size, 0, "first-seen times are dropped once items leave the inbox");
	} finally {
		await session.close(context);
	}
});

test("automatic previews use the first non-empty line and stay bounded", () => {
	assert.equal(previewText("\n  \n  First line  \nSecond"), "First line");
	assert.equal(previewText([{ type: "image" }, { type: "text", text: "From parts" }]), "From parts");
	const long = previewText("x".repeat(500));
	assert.equal(Array.from(long).length, 200);
	assert.ok(long.endsWith("…"));
	assert.equal(previewText(undefined), "");
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

		await editQueuedMessage(session, conversation.id, first.id, "Now steering", context, "steer");
		await editQueuedMessage(session, conversation.id, second.id, "Now a follow-up", context, "followUp");
		assert.deepEqual(
			queueUpdate((await session.snapshot(InboxDoc, conversation.id, context)) ?? null).items,
			[
				{ id: first.id, mode: "steer", content: "Now steering" },
				{ id: second.id, mode: "followUp", content: "Now a follow-up" },
			],
			"a mode change keeps queue position",
		);
		await assert.rejects(
			editQueuedMessage(session, conversation.id, first.id, "Bad", context, "write" as "steer"),
			/mode must be steer or followUp/,
		);
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

test("stop withdraws the user's queued messages in delivery order and leaves automatic input for the abort", async () => {
	const storage = new MemoryStorage();
	const session = createSession(storage);
	try {
		const { conversation, ids } = await session.commit(async (tx) => {
			const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
			const inbox = await tx.doc(InboxDoc, conversation.id);
			const ids: Record<string, number> = {};
			for (const [requestId, mode, content] of [
				["user:1", "followUp", "First follow-up"],
				["native:jobs.result:abc", "followUp", "Job result"],
				["user:2", "steer", "Steer me"],
				[
					"user:3",
					"followUp",
					[
						{ type: "text", text: "Second" },
						{ type: "text", text: "follow-up" },
					],
				],
			] as const) {
				const input = await tx.createSubmission({
					conversationId: conversation.id,
					requestId,
					type: "input",
					status: "queued",
				});
				ids[requestId] = input.id;
				inbox.items.push({ id: input.id, mode, content: content as string });
			}
			const write = await tx.createSubmission({ conversationId: conversation.id, type: "write", status: "queued" });
			inbox.items.push({ id: write.id, mode: "write", entry: { kind: "notice" } });
			return { conversation, ids };
		}, context);
		const readSubmission = (id: Parameters<typeof storage.submission>[0]) => storage.submission(id, context);
		const watch = await watchQueue(session, conversation.id, context);
		const withdrawn = await withdrawUserMessages(session, conversation.id, watch.value, readSubmission, context);
		await watch.stop();
		assert.deepEqual(withdrawn, [
			{ requestId: "user:2", content: "Steer me" },
			{ requestId: "user:1", content: "First follow-up" },
			{ requestId: "user:3", content: "Second\nfollow-up" },
		]);
		for (const requestId of ["user:1", "user:2", "user:3"]) {
			const record = await storage.submission(ids[requestId] as never, context);
			assert.equal(record?.status, "unanswered");
		}
		const remaining = await watchQueue(session, conversation.id, context);
		assert.deepEqual(
			remaining.value?.items.map((item) => item.mode),
			["followUp", "write"],
			"automatic input and writes stay for the abort",
		);
		await remaining.stop();
		assert.deepEqual(await withdrawUserMessages(session, conversation.id, null, readSubmission, context), []);
	} finally {
		await session.close(context);
	}
});
