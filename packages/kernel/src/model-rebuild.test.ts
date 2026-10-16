import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { createSession, MemoryStorage } from "@earendil-works/pi-durable";
import { rebuildContext } from "./model-rebuild.ts";

test("rebuild chunks include every raw character, respect output limits and never split emoji", async (t) => {
	const storage = new MemoryStorage();
	const session = createSession(storage);
	t.after(() => session.close(context));
	const raw = `prefix ${"😀".repeat(6000)} final fact`;
	const source = await session.commit(async (tx) => {
		const { id } = await tx.createConversation({ ownership: { kind: "ownerless" } });
		await tx.appendEntry(id, { kind: "pi.user", model: [{ role: "user", content: raw, timestamp: 1 }] });
		const tail = await tx.appendEntry(id, {
			kind: "pi.compaction",
			head: "self",
			model: [{ role: "user", content: "DO NOT USE OLD SUMMARY", timestamp: 2 }],
		});
		return { id, tail: tail.id };
	}, context);
	const chunks: string[] = [];
	const result = await rebuildContext({
		storage,
		conversationId: source.id,
		tail: source.tail,
		budget: 2048,
		maxOutputTokens: 128,
		context,
		signal: new AbortController().signal,
		summarize: async (text, maxTokens) => {
			assert.equal(maxTokens, 128);
			assert.ok(estimateTextTokens(text) < 2048);
			assert.doesNotMatch(text, /DO NOT USE OLD SUMMARY/);
			assert.equal(Buffer.from(text).toString("utf8"), text);
			chunks.push(text.split("<transcript>\n")[1]!.split("\n</transcript>")[0]!);
			return "Portable summary";
		},
	});
	assert.ok(chunks.length > 1);
	assert.equal(chunks.join("").trim(), `[user]\n${raw}`);
	assert.equal(result.head, "self");
	assert.match(JSON.stringify(result.model), /Portable summary/);
});

for (const summary of ["", "too large ".repeat(500)]) {
	test(`an ${summary ? "oversized" : "empty"} summary cannot become a new context`, async (t) => {
		const storage = new MemoryStorage();
		const session = createSession(storage);
		t.after(() => session.close(context));
		const source = await session.commit(async (tx) => {
			const { id } = await tx.createConversation({ ownership: { kind: "ownerless" } });
			const tail = await tx.appendEntry(id, {
				kind: "pi.user",
				model: [{ role: "user", content: "fact ".repeat(3000), timestamp: 1 }],
			});
			return { id, tail: tail.id };
		}, context);
		await assert.rejects(
			rebuildContext({
				storage,
				conversationId: source.id,
				tail: source.tail,
				budget: 2048,
				maxOutputTokens: 128,
				context,
				signal: new AbortController().signal,
				summarize: async () => summary,
			}),
			/empty or too large/,
		);
	});
}
