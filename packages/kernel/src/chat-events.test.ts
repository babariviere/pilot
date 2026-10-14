import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createSession, MemoryStorage } from "@earendil-works/pi-durable";
import { chatEventEntries, chatEvents, CompactionStatsDoc } from "./chat-events.ts";

test("compaction metadata is presentation-only, survives reads, and retains the summary", async () => {
	const session = createSession(new MemoryStorage());
	try {
		const marker = await session.commit(async (tx) => {
			const root = await tx.createConversation({ ownership: { kind: "ownerless" } });
			const kept = await tx.appendEntry(root.id, {
				kind: "pi.user",
				model: [{ role: "user", content: "Kept", timestamp: 1 }],
			});
			(await tx.doc(CompactionStatsDoc)).items.push({
				firstKept: Number(kept.id),
				before: 142000,
				kept: 18000,
				at: 2,
			});
			return tx.appendEntry(root.id, {
				kind: "pi.compaction",
				head: kept.id,
				data: { reason: "manual" },
				model: [{ role: "user", content: "Full kept summary", timestamp: 3 }],
			});
		}, context);
		const [decorated] = await chatEventEntries(session, [marker], context);
		assert.equal((decorated?.data as { tokensBefore: number }).tokensBefore, 142000);
		assert.ok((decorated?.data as { tokensAfter: number }).tokensAfter >= 18000);
		assert.equal((decorated?.data as { tokensEstimated: boolean }).tokensEstimated, true);
		assert.deepEqual(decorated?.model, marker.model);
		assert.deepEqual(marker.data, { reason: "manual" }, "does not mutate durable entries");
		const [event] = await chatEvents(session, [{ type: "entry_appended", entry: marker }], context);
		assert.deepEqual(event?.type === "entry_appended" && event.entry, decorated);
	} finally {
		await session.close(context);
	}
});

test("text streaming never reads event metadata", async () => {
	await chatEvents(
		{ snapshot: () => assert.fail("no storage reads for deltas") } as never,
		[{ type: "message_update", changes: [] } as never],
		context,
	);
});
