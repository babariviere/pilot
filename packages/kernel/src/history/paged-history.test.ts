import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, EntryRecord, Storage } from "@earendil-works/pi-durable";
import { readQuestionBoundary, readRecentEntries, readTranscriptPage, recentSnapshot } from "./paged-history.ts";

function fixture(count: number, head?: { id: number; start: number }) {
	const entries = Array.from(
		{ length: count },
		(_, i) =>
			({ id: i + 1, conversationId: 1, kind: "test", data: { text: "x".repeat(1024) } }) as unknown as EntryRecord,
	);
	if (head) Object.assign(entries[head.id - 1]!, { head: head.start, kind: "pi.compaction" });
	let hydrated = 0;
	const storage = {
		async conversation() {
			return { id: 1 };
		},
		async findLatestHeadMarker() {
			return head ? entries[head.id - 1] : undefined;
		},
		async scanEntries(query: { minEntryId?: number; maxEntryId?: number }, limit: number) {
			const range = entries
				.filter((e) => Number(e.id) >= (query.minEntryId ?? 0) && Number(e.id) <= (query.maxEntryId ?? Infinity))
				.toReversed();
			const items = range.slice(0, limit);
			hydrated += items.length;
			return { items, ...(range.length > limit ? { next: "unused" } : {}) };
		},
	} as unknown as Storage;
	return { storage, entries, hydrated: () => hydrated };
}

test("missing recent conversation is an error, not an exhausted transcript", async (t) => {
	const f = fixture(0);
	t.mock.method(f.storage, "conversation", async () => undefined);
	await assert.rejects(readRecentEntries(f.storage, 1 as ConversationId, context), /conversation is unavailable/);
});

test("recent storage read is bounded before hydration; explicit cursor reaches exact full transcript", async () => {
	for (const count of [0, 3, 6_000]) {
		const f = fixture(count);
		const recent = await readRecentEntries(f.storage, 1 as ConversationId, context);
		assert.ok(f.hydrated() <= 62, `hydrated ${f.hydrated()} of ${count}`);
		assert.equal(recent.entries.length, Math.min(count, 60));
		const all = [...recent.entries];
		let before = recent.history.before;
		while (before !== undefined) {
			const page = await readTranscriptPage(f.storage, recent.history.context, before, 24, context);
			all.unshift(...page.entries);
			assert.equal(page.more, page.nextBefore !== undefined);
			assert.ok(page.nextBefore === undefined || page.nextBefore < before);
			before = page.nextBefore;
		}
		assert.deepEqual(all, f.entries);
	}
});

test("oversized entries are paged intact; current question metadata can live outside the recent page", async () => {
	const f = fixture(100);
	Object.assign(f.entries[0]!, { kind: "pilot.question", data: { question: "Which option?", options: [] } });
	f.entries[99] = { ...f.entries[99]!, data: { text: "日本".repeat(200_000) } };
	const recent = await readRecentEntries(f.storage, 1 as ConversationId, context);
	assert.equal(recent.entries.length, 1, "one oversized entry is always admitted intact");
	assert.deepEqual(recent.entries[0], f.entries[99]);
	assert.equal(recent.history.before, 100);
	assert.deepEqual(await readQuestionBoundary(f.storage, recent.history.context, context), f.entries[0]);
	const live = recentSnapshot(f.entries, 1 as ConversationId);
	assert.deepEqual(live.history.question, f.entries[0]);
	assert.equal(recentSnapshot(f.entries, 1 as ConversationId, false).history.question, null);
	assert.deepEqual(live.entries, recent.entries);
	assert.equal(live.history.before, recent.history.before);
});

test("captured compaction range includes marker once, skips superseded active markers, and excludes later appends", async () => {
	const f = fixture(160, { id: 100, start: 30 });
	Object.assign(f.entries[49]!, { head: 40, kind: "pi.compaction" });
	const recent = await readRecentEntries(f.storage, 1 as ConversationId, context);
	assert.equal(recent.entries[0]?.id, 100);
	assert.equal(recent.history.context.tail, 160);
	f.entries.push({ id: 161, conversationId: 1, kind: "new" } as EntryRecord);
	const all = new Map(recent.entries.map((e) => [e.id, e]));
	let before = recent.history.before;
	while (before !== undefined) {
		const page = await readTranscriptPage(f.storage, recent.history.context, before, 24, context);
		for (const e of page.entries) {
			assert.ok(!all.has(e.id));
			all.set(e.id, e);
		}
		before = page.nextBefore;
	}
	assert.ok(!all.has(161 as EntryRecord["id"]));
	assert.ok(!all.has(50 as EntryRecord["id"]));
	assert.equal(all.size, 159);
});

test("current question projection ignores superseded active head markers", async () => {
	const f = fixture(160, { id: 100, start: 30 });
	Object.assign(f.entries[39]!, { kind: "pilot.question", data: { question: "Still current" } });
	Object.assign(f.entries[49]!, { head: 40, kind: "pi.user", model: [{ role: "user", content: "superseded head" }] });
	const page = await readRecentEntries(f.storage, 1 as ConversationId, context);
	assert.deepEqual(await readQuestionBoundary(f.storage, page.history.context, context), f.entries[39]);
});
