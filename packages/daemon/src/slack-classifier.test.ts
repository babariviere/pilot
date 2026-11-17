import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSlackClassification } from "./slack-classifier.ts";

const valid = { type: "bug" as const, confidence: 0.9, severity: "high", summary: "Export crashes", label: null };
test("report details require exact source quotes and keep unknown identities null", () => {
	const source = "For Acme, Zoë reported:\nExport fails.";
	const details = {
		client: { value: "Acme", evidence: "For Acme" },
		issue: { value: "Export fails", evidence: "reported:\nExport fails." },
		reporter: null,
	};
	assert.deepEqual(parseSlackClassification(JSON.stringify({ ...valid, details }), [], source).details, details);
	for (const detail of [
		{ value: "Acme", evidence: "for Acme" },
		{ value: "Acme", evidence: "Acme " },
		{ value: "x".repeat(241), evidence: "Acme" },
		{ value: "Acme", evidence: "x".repeat(501) },
		{ value: "Acme", evidence: "" },
		{ value: "Acme", evidence: "Acme", invented: true },
	])
		assert.throws(() =>
			parseSlackClassification(JSON.stringify({ ...valid, details: { ...details, client: detail } }), [], source),
		);
	assert.throws(() => parseSlackClassification(JSON.stringify({ ...valid, details: { client: null } }), [], source));
	assert.equal(parseSlackClassification(JSON.stringify(valid), [], source).details, undefined);
	assert.throws(() =>
		parseSlackClassification(
			JSON.stringify({
				...valid,
				details: {
					...details,
					reporter: { value: "Alice", evidence: "Zoë reported" },
				},
			}),
			[],
			source,
		),
	);
	assert.deepEqual(
		parseSlackClassification(
			JSON.stringify({
				...valid,
				details: {
					...details,
					reporter: { value: "Zoë", evidence: "Zoë reported" },
				},
			}),
			[],
			source,
		).details?.reporter,
		{ value: "Zoë", evidence: "Zoë reported" },
	);
});
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
