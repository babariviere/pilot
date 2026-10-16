import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonValue } from "@earendil-works/chord";
import type { AgentQuestion } from "@pilot/protocol";
import { createDatabaseTool, DATABASE_TOOL } from "./database-tool.ts";

const run = (tool: ReturnType<typeof createDatabaseTool>, params: Record<string, unknown>) =>
	tool.execute("call-1", params as never, undefined, undefined, {} as never);

test("db forwards calls to pilotd and returns its result", async () => {
	const calls: Array<[string, Record<string, JsonValue>]> = [];
	const tool = createDatabaseTool(
		async (action, args) => {
			calls.push([action, args]);
			return { env: "staging", mode: "read", columns: ["n"], rows: [{ n: 1 }], rowCount: 1, truncated: false };
		},
		async () => assert.fail("no question"),
	);
	assert.equal(tool.name, DATABASE_TOOL);
	const result = await run(tool, { action: "query", env: "staging", sql: "select $1::int as n", params: [1] });
	assert.deepEqual(calls, [["query", { env: "staging", sql: "select $1::int as n", params: [1] }]]);
	assert.equal(result.terminate, undefined);
	assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text).rows, [{ n: 1 }]);
});

test("a pending access request asks the user, hides its id from the agent and ends the turn", async () => {
	const published: Array<[string, AgentQuestion]> = [];
	const tool = createDatabaseTool(
		async (): Promise<JsonValue> => ({
			status: "pending",
			env: "prod",
			mode: "read",
			question: {
				question: "Allow read access to the prod database?",
				context: "Check a renewal",
				options: [
					{ label: "Allow read access to prod", detail: "Read-only, for the rest of this chat" },
					{ label: "Deny" },
				],
				databaseAccess: { id: "request-1", env: "prod", mode: "read" },
			},
		}),
		async (callId, question) => {
			published.push([callId, question]);
		},
	);
	const result = await run(tool, { action: "access", env: "prod", reason: "Check a renewal" });
	assert.equal(result.terminate, true);
	assert.doesNotMatch(JSON.stringify(result), /request-1/);
	assert.deepEqual(result.details, { status: "pending", env: "prod", mode: "read" });
	assert.deepEqual(published, [
		[
			"call-1",
			{
				question: "Allow read access to the prod database?",
				context: "Check a renewal",
				options: [
					{ label: "Allow read access to prod", detail: "Read-only, for the rest of this chat" },
					{ label: "Deny" },
				],
				databaseAccess: { id: "request-1", env: "prod", mode: "read" },
			},
		],
	]);
});
