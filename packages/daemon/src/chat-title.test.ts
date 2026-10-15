import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryRecord } from "@pilot/protocol";
import { chatTitleContext, TITLE_CONTEXT_LIMIT } from "./chat-title.ts";

function entry(id: number, kind: string, role: string, content: unknown): EntryRecord {
	return { id, kind, model: [{ role, content }] } as unknown as EntryRecord;
}

const signal = new AbortController().signal;

test("title context includes only chronological user and assistant text across pages", async () => {
	const reads: number[] = [];
	const context = await chatTitleContext(
		"Fix it",
		async (before, limit) => {
			reads.push(before);
			assert.equal(limit, 64);
			return before === Number.MAX_SAFE_INTEGER
				? {
						entries: [
							entry(4, "pi.tool-result", "toolResult", [{ type: "text", text: "Tests passed" }]),
							entry(5, "pi.message", "toolResult", [{ type: "text", text: "TOOL OUTPUT" }]),
							entry(5, "pi.assistant", "assistant", [
								{ type: "thinking", thinking: "PRIVATE THOUGHT", signature: "SIGNATURE" },
								{ type: "image", data: "IMAGE DATA" },
								{ type: "toolCall", arguments: { secret: "TOOL ARGS" } },
								{ type: "text", text: "Fixed the title generator" },
							]),
						],
						more: true,
					}
				: {
						entries: [
							entry(1, "pi.user", "user", "Fix it"),
							entry(2, "pi.user", "user", [{ type: "text", text: "Wait until the first turn finishes" }]),
							entry(3, "pi.compaction", "user", "COMPACTION SUMMARY"),
						],
						more: false,
					};
		},
		signal,
	);
	assert.deepEqual(reads, [Number.MAX_SAFE_INTEGER, 4]);
	assert.ok(
		context.includes(
			"user: Fix it\n\nuser: Wait until the first turn finishes\n\nassistant: Fixed the title generator",
		),
	);
	for (const excluded of [
		"PRIVATE THOUGHT",
		"SIGNATURE",
		"IMAGE DATA",
		"TOOL ARGS",
		"Tests passed",
		"TOOL OUTPUT",
		"Tool result",
		"COMPACTION SUMMARY",
	])
		assert.ok(!context.includes(excluded));
});

test("large title contexts preserve the opening and latest answer within the limit", async () => {
	let reads = 0;
	const context = await chatTitleContext(
		"Opening intent",
		async (before) => {
			reads++;
			return {
				entries: [
					entry(before - 3, "pi.user", "user", "u".repeat(100_000)),
					entry(before - 2, "pi.tool-result", "toolResult", [{ type: "text", text: "t".repeat(100_000) }]),
					entry(before - 1, "pi.assistant", "assistant", [
						{ type: "text", text: `Latest answer ${"a".repeat(100_000)}` },
					]),
				],
				more: true,
			};
		},
		signal,
	);
	assert.ok(context.startsWith("Opening request: Opening intent"));
	assert.ok(context.includes("assistant: Latest answer"));
	assert.ok(context.includes("user: "));
	assert.ok(!context.includes("ttt"));
	assert.ok(context.length <= TITLE_CONTEXT_LIMIT);
	assert.ok(reads <= 8);
});

test("title context bounds scans through non-message history and respects cancellation", async () => {
	let reads = 0;
	await chatTitleContext(
		"Task",
		async (before) => {
			reads++;
			return { entries: [entry(before - 1, "host.metadata", "user", "ignored")], more: true };
		},
		signal,
	);
	assert.equal(reads, 8);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		chatTitleContext("Task", async () => assert.fail("must not read"), controller.signal),
		{ name: "AbortError" },
	);
});
