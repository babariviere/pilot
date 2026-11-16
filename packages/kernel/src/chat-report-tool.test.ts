import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonValue } from "@earendil-works/chord/json";
import { CHAT_REPORT_TOOL, createChatReportTool } from "./chat-report-tool.ts";

test("chat_report forwards the report to pilotd and returns its answer", async () => {
	const calls: Array<Record<string, JsonValue>> = [];
	const tool = createChatReportTool(async (args) => {
		calls.push(args);
		return { saved: true, at: 5 };
	});
	assert.equal(tool.name, CHAT_REPORT_TOOL);
	const report = { answer: "It is a true positive.", links: [{ url: "https://example.com", title: "Log" }] };
	const result = await tool.execute("call-1", report as never, undefined, undefined, {} as never);
	assert.deepEqual(calls, [report]);
	assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), { saved: true, at: 5 });
});
