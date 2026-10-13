import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSlackClassification } from "./slack-classifier.ts";

const valid = { isBugReport: true, confidence: 0.9, severity: "high", summary: "Export crashes", guessedProject: null };
test("classification strictly validates all fields and refuses malformed output without echoing it", () => {
	assert.deepEqual(parseSlackClassification(JSON.stringify(valid)), valid);
	for (const text of [
		"private text, not JSON",
		"```json\n" + JSON.stringify(valid) + "\n```",
		"null",
		"[]",
		"{}",
		JSON.stringify({ ...valid, isBugReport: "true" }),
		JSON.stringify({ ...valid, confidence: "0.9" }),
		JSON.stringify({ ...valid, confidence: -0.1 }),
		JSON.stringify({ ...valid, confidence: 1.1 }),
		JSON.stringify({ ...valid, severity: "urgent" }),
		JSON.stringify({ ...valid, summary: "" }),
		JSON.stringify({ ...valid, summary: "a".repeat(241) }),
		JSON.stringify({ ...valid, summary: "bad\nline" }),
		JSON.stringify({ ...valid, guessedProject: {} }),
		JSON.stringify({ ...valid, guessedProject: "x".repeat(121) }),
		JSON.stringify({ ...valid, tool: "slack_send_message" }),
		JSON.stringify({ ...valid, guessedProject: undefined }),
		"x".repeat(4097),
		JSON.stringify({ ...valid, confidence: null }),
	])
		assert.throws(() => parseSlackClassification(text), { message: "Invalid Slack classification" });
});
