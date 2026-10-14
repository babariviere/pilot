import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createSession, InboxDoc, LiveDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { admitWithHeld, discardHeld, HeldInputsDoc, holdOnStop } from "./held-inputs.ts";
import { queueUpdateForDisplay } from "./queue.ts";

async function fixture() {
	const storage = new MemoryStorage();
	const session = createSession(storage);
	const conversation = await session.commit(async (tx) => {
		const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
		const inbox = await tx.doc(InboxDoc, conversation.id);
		for (const [requestId, mode, content] of [
			["mission:send:follow", "followUp", "Follow"],
			["user:follow", "followUp", "User follow"],
			["native:jobs.result:job", "followUp", "Job"],
			["mission:send:steer", "steer", "Correction"],
			["user:steer", "steer", "User steer"],
			["pr-follow-up:1", "followUp", "PR"],
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
	const read = (id: Parameters<typeof storage.submission>[0]) => storage.submission(id, context);
	return { storage, session, id: conversation.id, read };
}

for (const user of [false, true]) {
	test(
		user
			? "next user input carries held input in one turn"
			: "Send now places all held input, steering first, in one turn",
		async () => {
			const f = await fixture();
			try {
				const withdrawn = await holdOnStop(f.session, f.id, f.read, context);
				assert.deepEqual(
					withdrawn.map((item) => item.content),
					["User steer", "User follow"],
				);
				assert.equal((await f.session.snapshot(InboxDoc, f.id, context))?.items.length, 0);
				const held = await f.session.snapshot(HeldInputsDoc, f.id, context);
				assert.equal((await f.session.snapshot(LiveDoc, f.id, context))?.run, undefined);
				assert.equal(held?.items.length, 4);
				for (const item of held!.items) assert.equal((await f.read(item.id))?.status, "queued");
				const display = await queueUpdateForDisplay(null, f.read, undefined, 1, held!);
				assert.equal(display.items.length, 0);
				assert.ok(display.automatic!.every((item) => item.held));
				assert.equal(display.automatic!.length, 4);
				assert.equal(held?.events.length, 2);
				// Repeated Stop neither drops nor duplicates the parked submissions or their events.
				await holdOnStop(f.session, f.id, f.read, context);
				assert.equal((await f.session.snapshot(HeldInputsDoc, f.id, context))?.events.length, 2);
				const result = await admitWithHeld(
					f.session,
					f.id,
					user ? { requestId: "next", content: "Next user", mode: "steer" } : undefined,
					context,
				);
				assert.equal(result?.started, true);
				const live = await f.session.snapshot(LiveDoc, f.id, context);
				assert.equal(live?.run?.inputs.length, user ? 5 : 4);
				const entries = await f.storage.scanEntries({ conversationId: f.id }, 100, undefined, context);
				assert.deepEqual(
					[...entries.items].reverse().map((entry) => entry.model?.[0]?.content),
					["Correction", "Follow", "Job", "PR", ...(user ? ["Next user"] : [])],
				);
				assert.equal((await f.session.snapshot(HeldInputsDoc, f.id, context))?.items.length, 0);
				assert.equal(await admitWithHeld(f.session, f.id, undefined, context), undefined);
			} finally {
				await f.session.close(context);
			}
		},
	);
}

test("discard per row and all only settles held input and emits durable events", async () => {
	const f = await fixture();
	try {
		await holdOnStop(f.session, f.id, f.read, context);
		const held = (await f.session.snapshot(HeldInputsDoc, f.id, context))!;
		await discardHeld(f.session, f.id, f.read, context, held.items[0]!.id);
		assert.equal((await f.read(held.items[0]!.id))?.status, "unanswered");
		assert.equal((await f.session.snapshot(HeldInputsDoc, f.id, context))?.items.length, 3);
		await discardHeld(f.session, f.id, f.read, context, held.items[0]!.id);
		await discardHeld(f.session, f.id, f.read, context);
		const after = (await f.session.snapshot(HeldInputsDoc, f.id, context))!;
		assert.equal(after.items.length, 0);
		assert.ok(after.stopped);
		assert.deepEqual(
			after.events.map((event) => event.state),
			["held", "held", "discarded", "discarded"],
		);
		assert.equal(new Set(after.events.map((event) => event.id)).size, 4);
		await f.session.commit(async (tx) => {
			const inbox = await tx.doc(InboxDoc, f.id);
			const input = await tx.createSubmission({
				conversationId: f.id,
				requestId: "mission:send:waiting",
				type: "input",
				status: "queued",
			});
			inbox.items.push({ id: input.id, mode: "steer", content: "Waiting" });
		}, context);
		await discardHeld(f.session, f.id, f.read, context);
		assert.equal((await f.session.snapshot(InboxDoc, f.id, context))?.items.length, 1);
	} finally {
		await f.session.close(context);
	}
});

test("late automatic input stays held, and request retries do not duplicate it", async () => {
	const f = await fixture();
	try {
		await holdOnStop(f.session, f.id, f.read, context);
		const input = { requestId: "mission:send:late", content: "Late correction", mode: "steer" } as const;
		const admission = await admitWithHeld(f.session, f.id, input, context);
		assert.equal(admission?.held, true);
		assert.deepEqual(await admitWithHeld(f.session, f.id, input, context), admission);
		assert.equal((await f.session.snapshot(LiveDoc, f.id, context))?.run, undefined);
		assert.equal((await f.session.snapshot(HeldInputsDoc, f.id, context))?.items.length, 5);
	} finally {
		await f.session.close(context);
	}
});
