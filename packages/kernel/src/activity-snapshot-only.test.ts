import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	createSession,
	InboxDoc,
	LiveDoc,
	MemoryStorage,
	type SnapshotEvent,
	type SubmissionId,
	type TaskId,
} from "@earendil-works/pi-durable";
import { watchActivity } from "./activity.ts";

test("activity attachment reads no history, writes no existing docs and delivers only commit-consistent run/inbox", async (t) => {
	const storage = new MemoryStorage();
	const session = createSession(storage);
	try {
		const conversation = await session.commit(async (tx) => {
			const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
			await tx.doc(LiveDoc, conversation.id);
			await tx.doc(InboxDoc, conversation.id);
			await tx.appendEntry(conversation.id, { kind: "very-large-history", data: { text: "unused" } });
			return conversation;
		}, context);
		t.mock.method(storage, "scanEntries", () => {
			assert.fail("activity must not scan transcript");
		});
		const commit = t.mock.method(storage, "commit");
		const stream = await watchActivity(session, conversation.id, context);
		assert.equal(commit.mock.callCount(), 0, "snapshot attachment is a no-op transaction");
		assert.deepEqual(stream.snapshot.entries, []);
		assert.deepEqual(stream.snapshot.inbox, []);
		const frames: SnapshotEvent[] = [];
		stream.start(async (events) => {
			for (const event of events) if (event.type === "snapshot") frames.push(event);
		});
		const update = async (run: boolean, queued: boolean) => {
			const count = frames.length;
			await session.commit(async (tx) => {
				const live = await tx.doc(LiveDoc, conversation.id);
				if (run) live.run = { taskId: 100 as TaskId, inputs: [101 as SubmissionId] };
				else delete live.run;
				(await tx.doc(InboxDoc, conversation.id)).items = queued
					? [{ id: 102 as SubmissionId, mode: "followUp", content: "large content not sent" }]
					: [];
			}, context);
			await delay(1);
			assert.equal(frames.length, count + 1);
			assert.equal(Boolean(frames.at(-1)?.run), run);
			assert.equal(Boolean(frames.at(-1)?.inbox.length), queued);
		};
		await update(true, false);
		await update(false, true);
		await update(true, false);
		await update(false, false);
		const count = frames.length;
		await session.commit(async (tx) => {
			(await tx.doc(LiveDoc, conversation.id)).tools = [
				{ callId: "call", name: "tool", status: "running", output: "large output not sent" },
			];
			await tx.appendEntry(conversation.id, { kind: "entry-only-change" });
		}, context);
		await delay(1);
		assert.equal(frames.length, count, "output and transcript updates do not enlarge the activity stream");
		await stream.stop();
		await session.commit(async (tx) => {
			(await tx.doc(InboxDoc, conversation.id)).items = [
				{ id: 102 as SubmissionId, mode: "followUp", content: "after stop" },
			];
		}, context);
		await delay(1);
		assert.equal(frames.length, count, "stopped watch does not deliver");
	} finally {
		await session.close(context);
	}
});
