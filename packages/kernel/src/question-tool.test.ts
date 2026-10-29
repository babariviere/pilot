import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentQuestion } from "@pilot/protocol";
import { createQuestionTool, normalizeQuestion, QUESTION_TOOL } from "./question-tool.ts";

test("ask_user publishes the normalized question and awaits the answer", async () => {
	const published: Array<[string, AgentQuestion]> = [];
	const tool = createQuestionTool(async (callId, question) => {
		published.push([callId, question]);
		return "Sync worker";
	});
	assert.equal(tool.name, QUESTION_TOOL);
	const result = await tool.execute(
		"call-1",
		{
			question: " Where should retries live? ",
			context: "",
			options: [
				{ label: "Shared client", detail: " Every caller ", suggested: true },
				{ label: "Sync worker", suggested: true },
				{ label: "Shared client" },
				{ label: "  " },
			],
		},
		undefined,
		undefined,
		{} as never,
	);
	const expected: AgentQuestion = {
		question: "Where should retries live?",
		options: [{ label: "Shared client", detail: "Every caller", suggested: true }, { label: "Sync worker" }],
	};
	assert.deepEqual(published, [["call-1", expected]]);
	assert.deepEqual(result.details, { question: expected, answer: "Sync worker" });
	assert.equal(result.terminate, undefined);
	assert.deepEqual(result.content, [{ type: "text", text: "Sync worker" }]);
});

test("multiSelect needs several answers and keeps every suggestion", () => {
	assert.deepEqual(
		normalizeQuestion({
			question: "Which checks?",
			options: [
				{ label: "Typecheck", suggested: true },
				{ label: "Tests", suggested: true },
			],
			multiSelect: true,
		}),
		{
			question: "Which checks?",
			options: [
				{ label: "Typecheck", suggested: true },
				{ label: "Tests", suggested: true },
			],
			multiSelect: true,
		},
	);
	assert.deepEqual(normalizeQuestion({ question: "Proceed?", options: [{ label: "Yes" }], multiSelect: true }), {
		question: "Proceed?",
		options: [{ label: "Yes" }],
	});
	assert.deepEqual(normalizeQuestion({ question: "Anything else?" }), { question: "Anything else?", options: [] });
});
