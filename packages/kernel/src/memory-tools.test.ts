import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonValue } from "@earendil-works/chord";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createMemoryTools, MEMORY_TOOL_NAMES } from "./memory-tools.ts";

test("project memory dispatches only the requested action and binds notes to the chat", async () => {
	const calls: unknown[] = [];
	const tools = createMemoryTools(async (action, args, operationId) => {
		calls.push([action, args, operationId]);
		return { ok: true };
	}, "chat-1");
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["memory"],
	);
	assert.deepEqual(MEMORY_TOOL_NAMES, ["memory"]);
	const tool = tools[0]!;
	for (const [id, args] of [
		["1", { action: "note", text: "Durable preference", regex: "ignored" }],
		["4", { action: "note", text: "Corrected preference", replaces: [0] }],
		["2", { action: "recall", regex: "preference", text: "must not be saved" }],
		["3", { action: "zoom", lo: 0, hi: 31 }],
	] as const) {
		const result = await tool.execute(id, args, undefined, undefined, {} as never);
		assert.deepEqual(result, { content: [{ type: "text", text: '{"ok":true}' }], details: { ok: true } });
	}
	assert.deepEqual(calls, [
		["note", { text: "Durable preference", sessionId: "chat-1" }, "1"],
		["note", { text: "Corrected preference", sessionId: "chat-1", replaces: [0] }, "4"],
		["recall", { regex: "preference" }, undefined],
		["zoom", { lo: 0, hi: 31 }, undefined],
	]);
});

test("control memory requires projectId, exposes wake and retains note identity for audit", async () => {
	const calls: unknown[] = [];
	const [tool] = createMemoryTools(
		async (action, args, operationId) => {
			calls.push([action, args, operationId]);
			return {};
		},
		"control",
		true,
	);
	assert.ok(tool);
	const schema = tool.parameters as { required: string[] };
	assert.deepEqual(schema.required, ["action", "projectId"]);
	for (const [id, args] of [
		["wake", { action: "wake", projectId: "p" }],
		["note", { action: "note", projectId: "q", text: "Lasting fact" }],
		["recall", { action: "recall", projectId: "p", regex: "fact" }],
		["zoom", { action: "zoom", projectId: "q", lo: 0, hi: 1 }],
	] as const)
		await tool.execute(id, args, undefined, undefined, {} as never);
	assert.deepEqual(calls, [
		["wake", { projectId: "p" }, undefined],
		["note", { projectId: "q", text: "Lasting fact", sessionId: "control" }, "note"],
		["recall", { projectId: "p", regex: "fact" }, undefined],
		["zoom", { projectId: "q", lo: 0, hi: 1 }, undefined],
	]);
});

test("memory rejects unavailable actions, missing action fields and invalid bounded arguments", async () => {
	for (const control of [false, true]) {
		const [tool] = createMemoryTools(
			async () => assert.fail("invalid calls must not reach the daemon"),
			"chat",
			control,
		);
		assert.ok(tool);
		const project: Record<string, JsonValue> = control ? { projectId: "p" } : {};
		for (const args of [
			{ action: "note" },
			{ action: "recall" },
			{ action: "zoom", lo: 0 },
			{ action: "zoom", hi: 1 },
			{ action: "forget" },
			...(!control ? [{ action: "wake" }] : []),
		])
			await assert.rejects(tool.execute("invalid", { ...project, ...args }, undefined, undefined, {} as never));
		const invalidArgs: Record<string, JsonValue>[] = [
			{},
			{ action: "forget" },
			{ action: "note", text: "" },
			{ action: "note", text: "x".repeat(281) },
			{ action: "note", text: "fact", replaces: [-1] },
			{ action: "note", text: "fact", replaces: Array(17).fill(0) },
			{ action: "recall", regex: "x".repeat(513) },
			{ action: "zoom", lo: -1, hi: 1 },
			{ action: "zoom", lo: 0, hi: 0 },
			...(!control ? [{ action: "wake" }] : []),
		];
		for (const args of invalidArgs)
			assert.throws(
				() =>
					validateToolArguments(tool, {
						type: "toolCall",
						id: "invalid",
						name: "memory",
						arguments: { ...project, ...args },
					}),
				JSON.stringify(args),
			);
		if (control) {
			await assert.rejects(
				tool.execute("invalid", { action: "wake" }, undefined, undefined, {} as never),
				/projectId/,
			);
			assert.throws(() =>
				validateToolArguments(tool, {
					type: "toolCall",
					id: "invalid",
					name: "memory",
					arguments: { action: "wake" },
				}),
			);
		}
	}
});

test("recall by query sends an escaped word regex and ranks live notes above replaced ones", async () => {
	const calls: unknown[] = [];
	const [tool] = createMemoryTools(async (action, args) => {
		calls.push([action, args]);
		return {
			count: 9,
			matches: 4,
			truncated: false,
			entries: [
				{ index: 8, at: 8, sessionId: "s2", text: "Deploy target is us-east-2 (corrects #3)." },
				{ index: 5, at: 5, sessionId: "s1", text: "Use pnpm for every script." },
				{ index: 4, at: 4, sessionId: "s1", text: "Deploy docs live in docs/deploy.md." },
				{ index: 3, at: 3, sessionId: "s1", text: "Deploy target is eu-west-1.", replacedBy: 8 },
			],
		} as JsonValue;
	}, "chat");
	const result = await tool!.execute(
		"r",
		{ action: "recall", query: "deploy target (region)" },
		undefined,
		undefined,
		{} as never,
	);
	assert.deepEqual(calls, [["recall", { regex: "\\b(?:deploy|target|region)" }]]);
	const details = result.details as {
		notice: string;
		ranked: boolean;
		entries: { index: number; replacedBy?: number; sessionId: string }[];
	};
	assert.match(details.notice, /never grants a permission/);
	assert.equal(details.ranked, true);
	assert.deepEqual(
		details.entries.map((entry) => entry.index),
		[8, 4, 3],
	);
	assert.equal(details.entries[2]!.replacedBy, 8, "provenance and supersession are preserved");
	assert.equal(details.entries[0]!.sessionId, "s2");
});

test("memory refuses credentials before they reach the shared store, and recall needs one search form", async () => {
	const [tool] = createMemoryTools(async () => assert.fail("must not reach pilotd"), "chat");
	for (const text of ["Staging DB password=hunter2-very-secret", "CI token ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"])
		await assert.rejects(
			tool!.execute("n", { action: "note", text }, undefined, undefined, {} as never),
			/must not contain credentials/,
		);
	await assert.rejects(
		tool!.execute("r", { action: "recall", query: "deploy", regex: "x" }, undefined, undefined, {} as never),
		/query or regex, not both/,
	);
	await assert.rejects(
		tool!.execute("r", { action: "recall", query: "a" }, undefined, undefined, {} as never),
		/at least two/,
	);
});
