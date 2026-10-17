import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonValue } from "@earendil-works/chord";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createControlMemoryTools } from "./control-memory-tools.ts";

test("only control exposes history; actions forward only their own arguments", async () => {
	const calls: unknown[] = [];
	const call = async (action: string, args: Record<string, JsonValue>) => {
		calls.push([action, args]);
		return { ok: true };
	};
	assert.deepEqual(createControlMemoryTools(false, call), []);
	const tools = createControlMemoryTools(true, call);
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["history"],
	);
	const tool = tools[0]!;
	assert.deepEqual(tool.annotations, { readOnlyHint: true, openWorldHint: false });
	for (const args of [
		{ action: "zoom", id: 0, n: 2 },
		{ action: "zoom", id: 1, n: 1, offset: 0 },
		{ action: "date", id: 1, n: 8, offset: 10 },
	]) {
		const result = await tool.execute("call", args, undefined, undefined, {} as never);
		assert.deepEqual(result, { content: [{ type: "text", text: '{"ok":true}' }], details: { ok: true } });
	}
	assert.deepEqual(calls, [
		["zoom", { id: 0, n: 2 }],
		["zoom", { id: 1, n: 1, offset: 0 }],
		["date", { id: 1 }],
	]);
});

test("history requires an action and id, and zoom requires n", async () => {
	const [tool] = createControlMemoryTools(true, async () => assert.fail("invalid history call reached daemon"));
	assert.ok(tool);
	for (const args of [
		{ action: "zoom", id: 0 },
		{ action: "unknown", id: 0 },
	])
		await assert.rejects(tool.execute("invalid", args, undefined, undefined, {} as never));
	const invalidArgs: Record<string, JsonValue>[] = [
		{ id: 0 },
		{ action: "date" },
		{ action: "unknown", id: 0 },
		{ action: "date", id: -1 },
		{ action: "zoom", id: 0, n: 0 },
		{ action: "zoom", id: 0, n: 1, offset: -1 },
	];
	for (const args of invalidArgs)
		assert.throws(() =>
			validateToolArguments(tool, { type: "toolCall", id: "invalid", name: "history", arguments: args }),
		);
});
