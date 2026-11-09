import type { InterviewAnswer, InterviewQuestion, MissionInterview } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { canonicalJSON, payloadHash } from "./operation-journal.ts";

export const interviewDigest = (value: unknown): string => payloadHash(canonicalJSON(value));
export function interviewExact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key))
	)
		throw new Conflict("Expected exact interview fields");
}
export function interviewText(value: unknown, max: number, empty = false): asserts value is string {
	if (typeof value !== "string" || Buffer.byteLength(value) > max || (!empty && !value.trim()))
		throw new Conflict("Invalid interview text");
}
export function interviewId(value: unknown): asserts value is string {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
		throw new Conflict("Invalid interview identity");
}
export function validateQuestions(value: unknown): asserts value is InterviewQuestion[] {
	if (
		!Array.isArray(value) ||
		!value.length ||
		value.length > 40 ||
		Buffer.byteLength(JSON.stringify(value)) > 12 * 1024
	)
		throw new Conflict("Interview needs 1–40 questions within 12 KiB");
	const seen = new Set<string>();
	for (const q of value) {
		interviewExact(q, ["id", "section", "prompt", "options", "recommendedOptionId"]);
		interviewId(q.id);
		interviewText(q.prompt, 2000);
		if (
			seen.has(q.id) ||
			typeof q.section !== "string" ||
			!["outcome", "non-goals", "constraints", "acceptance", "authority"].includes(q.section) ||
			!Array.isArray(q.options) ||
			q.options.length > 8
		)
			throw new Conflict("Invalid interview question");
		seen.add(q.id);
		const options = new Set<string>();
		for (const option of q.options) {
			interviewExact(option, ["id", "meaning"]);
			interviewId(option.id);
			interviewText(option.meaning, 2000);
			if (options.has(option.id)) throw new Conflict("Duplicate option");
			options.add(option.id);
		}
		if (
			q.recommendedOptionId !== null &&
			(typeof q.recommendedOptionId !== "string" || !options.has(q.recommendedOptionId))
		)
			throw new Conflict("Recommendation must reference an option");
	}
}
export function validateAnswers(value: unknown, questions: InterviewQuestion[]): asserts value is InterviewAnswer[] {
	if (!Array.isArray(value) || value.length > 40 || Buffer.byteLength(JSON.stringify(value)) > 12 * 1024)
		throw new Conflict("Answers exceed 12 KiB");
	const seen = new Set<string>();
	for (const a of value) {
		interviewExact(a, ["questionId", "questionDigest", "selectedOption", "text"]);
		const q = questions.find((q) => q.id === a.questionId);
		if (!q || seen.has(q.id) || a.questionDigest !== interviewDigest(q))
			throw new Conflict("Answer question meaning changed");
		seen.add(q.id);
		interviewText(a.text, 4000, true);
		if (
			a.selectedOption !== null &&
			!q.options.some((option) => canonicalJSON(option) === canonicalJSON(a.selectedOption))
		)
			throw new Conflict("Selected option identity or meaning changed");
	}
}
export function completeAnswers(state: MissionInterview): InterviewAnswer[] {
	const answers = state.questions.map((q) => state.answers.find((a) => a.questionId === q.id));
	if (answers.some((a) => !a || (!a.selectedOption && !a.text.trim())))
		throw new Conflict("Every question needs an explicit answer");
	validateAnswers(answers, state.questions);
	return answers as InterviewAnswer[];
}
/** Deterministic mapping, no model paraphrase and no inferred acceptance of recommendations. */
export function agreementMarkdown(state: MissionInterview): string {
	const answers = completeAnswers(state);
	const markdown = [
		"# Mission agreement",
		...state.questions.map((q, index) => {
			const a = answers[index]!;
			return `\n## ${q.section}: ${JSON.stringify(q.prompt)}\n\n${JSON.stringify({ selectedOption: a.selectedOption, text: a.text })}`;
		}),
	].join("\n");
	interviewText(markdown, 28 * 1024);
	return markdown;
}
