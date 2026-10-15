/** The `ask_user` tool: shows the user a question in place of the composer. Their reply is the next user message. */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentQuestion } from "@pilot/protocol";

export const QUESTION_TOOL = "ask_user";
/** Transcript entry kind holding an `AgentQuestion`. Written outside model context, so codemode calls show it too. */
export { QUESTION_ENTRY } from "./question-entry.ts";
export const MAX_QUESTION_OPTIONS = 9;

/** Commits the question to the transcript. `callId` makes the write idempotent. */
export type PublishQuestion = (callId: string, question: AgentQuestion) => Promise<void>;

export function createQuestionTool(publish: PublishQuestion): ToolDefinition {
	return defineTool({
		name: QUESTION_TOOL,
		label: "Ask the user",
		description: `Ask the user one question when you need their decision. Offer up to ${MAX_QUESTION_OPTIONS} short answers and mark the one you recommend as suggested; set multiSelect only when several answers can apply together. The user can always reply in their own words instead, including a question back. Your turn ends after this call and their reply arrives as the next user message, so ask last.`,
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
		}),
		executionMode: "sequential",
		annotations: { readOnlyHint: true, openWorldHint: false },
		async execute(callId, params) {
			const question = normalizeQuestion(params);
			await publish(callId, question);
			return {
				content: [
					{
						type: "text",
						text: "The user sees your question. End your turn now; their reply arrives as the next user message.",
					},
				],
				details: question,
				terminate: true,
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
	return { question, ...(context ? { context } : {}), options, ...(multiSelect ? { multiSelect: true } : {}) };
}
