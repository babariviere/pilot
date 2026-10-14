import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryTools } from "./memory-tools.ts";

test("project memory tools call only their requested operation and bind notes to the chat", async () => {
	const calls: Array<[string, Record<string, unknown>]> = [];
	const tools = createMemoryTools(async (action, args) => {
		calls.push([action, args]);
		return { ok: true };
	}, "chat-1");
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["memory_note", "memory_recall", "memory_zoom"],
	);
	await tools[0]!.execute("1", { text: "Durable preference" }, undefined, undefined, {} as never);
	await tools[0]!.execute("4", { text: "Corrected preference", replaces: [0] }, undefined, undefined, {} as never);
	await tools[1]!.execute("2", { regex: "preference" }, undefined, undefined, {} as never);
	await tools[2]!.execute("3", { lo: 0, hi: 31 }, undefined, undefined, {} as never);
	assert.deepEqual(calls, [
		["note", { text: "Durable preference", sessionId: "chat-1" }],
		["note", { text: "Corrected preference", sessionId: "chat-1", replaces: [0] }],
		["recall", { regex: "preference" }],
		["zoom", { lo: 0, hi: 31 }],
	]);
});
