import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSlackClassification } from "./slack-classifier.ts";

const valid = { type: "bug" as const, confidence: 0.9, severity: "high", summary: "Export crashes", label: null };
test("classification strictly validates all fields and refuses malformed output without echoing it", () => {
	assert.deepEqual(parseSlackClassification(JSON.stringify(valid)), valid);
	for (const text of [
		"private text, not JSON",
		"```json\n" + JSON.stringify(valid) + "\n```",
		"null",
		"[]",
		"{}",
		JSON.stringify({ ...valid, type: "other" }),
		JSON.stringify({ ...valid, confidence: "0.9" }),
		JSON.stringify({ ...valid, confidence: -0.1 }),
		JSON.stringify({ ...valid, confidence: 1.1 }),
		JSON.stringify({ ...valid, severity: "urgent" }),
		JSON.stringify({ ...valid, summary: "" }),
		JSON.stringify({ ...valid, summary: "a".repeat(241) }),
		JSON.stringify({ ...valid, summary: "bad\nline" }),
		JSON.stringify({ ...valid, label: {} }),
		JSON.stringify({ ...valid, label: "x".repeat(81) }),
		JSON.stringify({ ...valid, tool: "slack_send_message" }),
		JSON.stringify({ ...valid, label: undefined }),
		"x".repeat(4097),
		JSON.stringify({ ...valid, confidence: null }),
	])
		assert.throws(() => parseSlackClassification(text), { message: "Invalid Slack classification" });
});
