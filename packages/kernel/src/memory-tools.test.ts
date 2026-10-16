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

test("control memory tools require projectId, expose wake and retain the tool call identity for audit", async () => {
	const calls: unknown[] = [];
	const tools = createMemoryTools(
		async (action, args, operationId) => {
			calls.push([action, args, operationId]);
			return {};
		},
		"control",
		true,
	);
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["memory_wake", "memory_note", "memory_recall", "memory_zoom"],
	);
	for (const tool of tools) {
		const schema = tool.parameters as { required: string[] };
		assert.ok(schema.required.includes("projectId"));
	}
	await tools[0]!.execute("wake", { projectId: "p" }, undefined, undefined, {} as never);
	await tools[1]!.execute("note", { projectId: "q", text: "Lasting fact" }, undefined, undefined, {} as never);
	await tools[2]!.execute("recall", { projectId: "p", regex: "fact" }, undefined, undefined, {} as never);
	await tools[3]!.execute("zoom", { projectId: "q", lo: 0, hi: 1 }, undefined, undefined, {} as never);
	assert.deepEqual(calls, [
		["wake", { projectId: "p" }, undefined],
		["note", { projectId: "q", text: "Lasting fact", sessionId: "control" }, "note"],
		["recall", { projectId: "p", regex: "fact" }, undefined],
		["zoom", { projectId: "q", lo: 0, hi: 1 }, undefined],
	]);
	assert.ok(!tools.some((tool) => tool.name.includes("forget")));
});
