import assert from "node:assert/strict";
import { test } from "node:test";
import { createRepairDiagnosticsTools } from "./repair-diagnostics-tools.ts";

const host = { hostId: "local", daemonId: "daemon", lineageId: "lineage" };
const subject = {
	kind: "chat" as const,
	host,
	sessionId: "00000000-0000-4000-8000-000000000001",
	chatUrl: "pilot://chat/00000000-0000-4000-8000-000000000001",
};

test("repair tools read only the confirmed chat and expose no discovery or proposal actions", async () => {
	const calls: unknown[] = [];
	const tools = createRepairDiagnosticsTools(subject, {
		diagnostics: async (...args) => {
			calls.push(args);
			return {} as never;
		},
		history: async (...args) => {
			calls.push(args);
			return {} as never;
		},
		logs: async (...args) => {
			calls.push(args[0]);
			return {} as never;
		},
	});
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["diagnostics", "diagnostic_logs", "diagnostic_history"],
	);
	for (const tool of tools) {
		assert.equal(tool.annotations?.readOnlyHint, true);
		assert.equal(tool.annotations?.destructiveHint, false);
		assert.ok(tool.description.length < 200);
	}
	const [diagnostics, logs, history] = tools;
	await diagnostics!.execute("diagnostics", { limit: 4 }, undefined, undefined, {} as never);
	await history!.execute("history", { before: 12, limit: 3 }, undefined, undefined, {} as never);
	await logs!.execute("logs", { action: "inventory" }, undefined, undefined, {} as never);
	assert.deepEqual(calls, [[subject.sessionId, 4], [subject.sessionId, 12, 3], { action: "inventory" }]);
	for (const tool of [diagnostics!, history!]) {
		await assert.rejects(
			tool.execute("cross-chat", { sessionId: "other" }, undefined, undefined, {} as never),
			/approved repair subject/,
		);
	}
	assert.equal(calls.length, 3, "denied chat reads never dispatch");
});

test("app repair tools never expose history or allow a chat selector", async () => {
	const calls: unknown[] = [];
	const tools = createRepairDiagnosticsTools(
		{ kind: "app", host },
		{
			diagnostics: async (...args) => {
				calls.push(args);
				return {} as never;
			},
			logs: async () => ({}) as never,
			history: async () => assert.fail("app repair must not expose chat history"),
		},
	);
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["diagnostics", "diagnostic_logs"],
	);
	await tools[0]!.execute("app", {}, undefined, undefined, {} as never);
	await assert.rejects(
		tools[0]!.execute("chat", { sessionId: subject.sessionId }, undefined, undefined, {} as never),
		/approved repair subject/,
	);
	assert.deepEqual(calls, [[undefined, undefined]]);
});
