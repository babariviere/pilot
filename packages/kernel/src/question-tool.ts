/** The `ask_user` tool saves one question; the human reply starts a new turn. */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentQuestion } from "@pilot/protocol";
import { Type } from "typebox";

export const QUESTION_TOOL = "ask_user";
/** Transcript entry kind holding an `AgentQuestion`. Written outside model context, so codemode calls show it too. */
export { QUESTION_ENTRY } from "./question-entry.ts";
export const MAX_QUESTION_OPTIONS = 9;
/** At most this many artifacts per question: a question shows them all at once, so a few keep it readable. */
export const MAX_QUESTION_ARTIFACTS = 3;

/** Commits the question to the transcript. `callId` makes the write idempotent. */
export type PublishQuestion = (callId: string, question: AgentQuestion, signal?: AbortSignal) => Promise<void>;

export function createQuestionTool(publish: PublishQuestion): ToolDefinition {
	return defineTool({
		name: QUESTION_TOOL,
		label: "Ask the user",
		description: `Ask the user one question when you need their decision. Offer up to ${MAX_QUESTION_OPTIONS} short answers and mark the one you recommend as suggested; set multiSelect only when several answers can apply together. The user can always reply in their own words, including a question back. This call saves the question and returns immediately, without a human answer. End your turn after saving it. The human reply starts the next turn; never answer or select for them.`,
		promptSnippet: "Ask the user a question with suggested answers",
		parameters: Type.Object({
			question: Type.String({ minLength: 1, maxLength: 300, description: "One short question." }),
			context: Type.Optional(
				Type.String({ maxLength: 600, description: "One or two sentences the user needs to answer." }),
			),
			options: Type.Optional(
				Type.Array(
					Type.Object({
						label: Type.String({ minLength: 1, maxLength: 120 }),
						detail: Type.Optional(Type.String({ maxLength: 240, description: "One line on the consequence." })),
						suggested: Type.Optional(Type.Boolean()),
					}),
					{ maxItems: MAX_QUESTION_OPTIONS },
				),
			),
			multiSelect: Type.Optional(Type.Boolean()),
			artifacts: Type.Optional(
				Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
					maxItems: MAX_QUESTION_ARTIFACTS,
					description:
						"IDs of artifacts you saved (such as an NSH mockup) that the user needs to see to answer. Pilot shows them with the question.",
				}),
			),
		}),
		executionMode: "sequential",
		annotations: { readOnlyHint: true, openWorldHint: false },
		async execute(callId, params, signal) {
			const question = normalizeQuestion(params);
			await publish(callId, question, signal);
			return {
				content: [
					{
						type: "text",
						text: "Question saved. Awaiting the human reply. End your turn; their reply starts the next turn.",
					},
				],
				details: { question, awaitingHuman: true },
			};
		},
	});
}

/** Trims text, drops empty and duplicate answers, and keeps at most one suggestion unless several can be picked. */
export function normalizeQuestion(params: {
	question: string;
	context?: string;
	options?: Array<{ label: string; detail?: string; suggested?: boolean }>;
	multiSelect?: boolean;
	artifacts?: string[];
}): AgentQuestion {
	const question = params.question.trim();
	if (!question) throw new Error("question must not be empty");
	const seen = new Set<string>();
	const options: AgentQuestion["options"] = [];
	for (const option of params.options ?? []) {
		const label = option.label.trim();
		if (!label || seen.has(label)) continue;
		seen.add(label);
		const detail = option.detail?.trim();
		options.push({ label, ...(detail ? { detail } : {}), ...(option.suggested ? { suggested: true } : {}) });
	}
	if (options.length > MAX_QUESTION_OPTIONS) throw new Error(`At most ${MAX_QUESTION_OPTIONS} answers are allowed`);
	const multiSelect = !!params.multiSelect && options.length > 1;
	if (!multiSelect) {
		let suggested = false;
		for (const option of options) {
			if (option.suggested && suggested) delete option.suggested;
			suggested ||= !!option.suggested;
		}
	}
	const context = params.context?.trim();
	const artifacts = [...new Set((params.artifacts ?? []).map((id) => id.trim()).filter(Boolean))];
	if (artifacts.length > MAX_QUESTION_ARTIFACTS)
		throw new Error(`At most ${MAX_QUESTION_ARTIFACTS} artifacts are allowed per question`);
	return {
		question,
		...(context ? { context } : {}),
		options,
		...(multiSelect ? { multiSelect: true } : {}),
		...(artifacts.length ? { artifacts } : {}),
	};
}
