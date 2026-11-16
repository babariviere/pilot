import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentQuestion } from "@pilot/protocol";
import { createQuestionTool, normalizeQuestion, QUESTION_TOOL } from "./question-tool.ts";

test("ask_user saves the normalized question and returns without a human answer", async () => {
	const published: Array<[string, AgentQuestion]> = [];
	const tool = createQuestionTool(async (callId, question) => {
		published.push([callId, question]);
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
	assert.deepEqual(result.details, { question: expected, awaitingHuman: true });
	assert.equal(result.terminate, undefined);
	assert.deepEqual(result.content, [
		{
			type: "text",
			text: "Question saved. Awaiting the human reply. End your turn; their reply starts the next turn.",
		},
	]);
	assert.equal("blocking" in expected, false);
	assert.match(tool.description, /returns immediately, without a human answer/);
	assert.doesNotMatch(tool.description, /waits until they answer/);
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

test("a question names at most three distinct artifacts", () => {
	assert.deepEqual(normalizeQuestion({ question: "OK?", artifacts: [" mock ", "mock", "", "other"] }), {
		question: "OK?",
		options: [],
		artifacts: ["mock", "other"],
	});
	assert.throws(
		() => normalizeQuestion({ question: "OK?", artifacts: ["a", "b", "c", "d"] }),
		/At most 3 artifacts are allowed per question/,
	);
});

test("ask_user awaits publication, forwards cancellation and propagates save failures", async () => {
	const controller = new AbortController();
	let save!: () => void;
	const saving = new Promise<void>((resolve) => {
		save = resolve;
	});
	const tool = createQuestionTool(async (callId, question, signal) => {
		assert.equal(callId, "saving");
		assert.equal(signal, controller.signal);
		assert.deepEqual(question, { question: "Proceed?", options: [] });
		await saving;
	});
	let returned = false;
	const result = tool
		.execute("saving", { question: "Proceed?" }, controller.signal, undefined, {} as never)
		.then((result) => {
			returned = true;
			return result;
		});
	await Promise.resolve();
	assert.equal(returned, false, "publication must finish before reporting saved");
	save();
	assert.deepEqual((await result).details, { question: { question: "Proceed?", options: [] }, awaitingHuman: true });
	const failing = createQuestionTool(async () => {
		throw new Error("Save failed");
	});
	await assert.rejects(
		failing.execute("failed", { question: "Proceed?" }, undefined, undefined, {} as never),
		/Save failed/,
	);
});
