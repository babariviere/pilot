import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonValue } from "@earendil-works/chord";
import { createSlackStatusTool, SLACK_STATUS_TOOL } from "./slack-status-tool.ts";

test("slack_status forwards only the status and reason to pilotd", async () => {
	const calls: Array<Record<string, JsonValue>> = [];
	const tool = createSlackStatusTool(async (args) => {
		calls.push(args);
		return { updated: [{ title: "Export fails", status: "waiting" }], unchanged: [] };
	});
	assert.equal(tool.name, SLACK_STATUS_TOOL);
	const result = await tool.execute(
		"call-1",
		{ status: "waiting", reason: "CSM to confirm the org" } as never,
		undefined,
		undefined,
		{} as never,
	);
	await tool.execute("call-2", { status: "in_progress" } as never, undefined, undefined, {} as never);
	await tool.execute(
		"call-3",
		{ status: "done", reason: "answered in thread" } as never,
		undefined,
		undefined,
		{} as never,
	);
	assert.deepEqual(calls, [
		{ status: "waiting", reason: "CSM to confirm the org" },
		{ status: "in_progress" },
		{ status: "done", reason: "answered in thread" },
	]);
	assert.equal(JSON.parse((result.content[0] as { text: string }).text).updated[0].status, "waiting");
});
