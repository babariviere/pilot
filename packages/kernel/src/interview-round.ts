/** Shared saved-round validation. No permission, mission or continuation effects. */
import { createHash } from "node:crypto";
import type { InterviewAnswer, InterviewQuestion } from "@pilot/protocol";
import { planningJSON as canonicalJSON } from "./planning-worker.ts";
export class InterviewInvalid extends Error {}
export const interviewDigest = (value: unknown): string =>
	createHash("sha256").update(canonicalJSON(value)).digest("hex");
export function interviewExact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key))
	)
		throw new InterviewInvalid("Expected exact interview fields");
}
export function interviewText(value: unknown, max: number, empty = false): asserts value is string {
	if (typeof value !== "string" || Buffer.byteLength(value) > max || (!empty && !value.trim()))
		throw new InterviewInvalid("Invalid interview text");
}
/** Largest answer list in one save. See validateAnswers. */
export const ANSWERS_LIMIT = 48 * 1024;
export function interviewId(value: unknown): asserts value is string {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
		throw new InterviewInvalid("Invalid interview identity");
}
export function validateQuestions(value: unknown): asserts value is InterviewQuestion[] {
	// A round is answered by a person in one sitting: 40 questions and 40 KiB keep it readable.
	if (!Array.isArray(value) || !value.length || value.length > 40)
		throw new InterviewInvalid(
			`Interview needs 1–40 questions; this round has ${Array.isArray(value) ? value.length : 0}. Split it into rounds.`,
		);
	const bytes = Buffer.byteLength(JSON.stringify(value));
	if (bytes > 40 * 1024)
		throw new InterviewInvalid(
			`Interview questions are ${Math.ceil(bytes / 1024)} KiB, more than 40 KiB. Shorten context or options, or split the round.`,
		);
	const seen = new Set<string>();
	for (const q of value) {
		const context = q && typeof q === "object" && Object.hasOwn(q, "context");
		interviewExact(q, ["id", "section", "prompt", "options", "recommendedOptionId", ...(context ? ["context"] : [])]);
		if (context) interviewText(q.context, 1500);
		interviewId(q.id);
		interviewText(q.prompt, 2000);
		if (
			seen.has(q.id) ||
			typeof q.section !== "string" ||
			!["outcome", "non-goals", "constraints", "acceptance", "authority"].includes(q.section) ||
			!Array.isArray(q.options) ||
			q.options.length > 8
		)
			throw new InterviewInvalid("Invalid interview question");
		seen.add(q.id);
		const options = new Set<string>();
		for (const option of q.options) {
			interviewExact(option, ["id", "meaning"]);
			interviewId(option.id);
			interviewText(option.meaning, 2000);
			if (options.has(option.id)) throw new InterviewInvalid("Duplicate option");
			options.add(option.id);
		}
		if (
			q.recommendedOptionId !== null &&
			(typeof q.recommendedOptionId !== "string" || !options.has(q.recommendedOptionId))
		)
			throw new InterviewInvalid("Recommendation must reference an option");
	}
}
export function validateAnswers(value: unknown, questions: InterviewQuestion[]): asserts value is InterviewAnswer[] {
	if (!Array.isArray(value) || value.length > 40) throw new InterviewInvalid("Answers need at most one per question");
	// One save carries every answer and must fit an operation (64 KiB), so 48 KiB leaves room for the rest.
	// Each answer repeats its picked option, so a full round with long answers needs this much.
	const bytes = Buffer.byteLength(JSON.stringify(value));
	if (bytes > ANSWERS_LIMIT)
		throw new InterviewInvalid(
			`Answers are ${Math.ceil(bytes / 1024)} KiB, more than ${ANSWERS_LIMIT / 1024} KiB. Shorten the longest answers.`,
		);
	const seen = new Set<string>();
	for (const a of value) {
		interviewExact(a, ["questionId", "questionDigest", "selectedOption", "text"]);
		const q = questions.find((q) => q.id === a.questionId);
		if (!q || seen.has(q.id) || a.questionDigest !== interviewDigest(q))
			throw new InterviewInvalid("Answer question meaning changed");
		seen.add(q.id);
		interviewText(a.text, 4000, true);
		if (
			a.selectedOption !== null &&
			!q.options.some((option) => canonicalJSON(option) === canonicalJSON(a.selectedOption))
		)
			throw new InterviewInvalid("Selected option identity or meaning changed");
	}
}
export function completeAnswers(state: {
	questions: InterviewQuestion[];
	answers: InterviewAnswer[];
}): InterviewAnswer[] {
	if (!state.questions.length) throw new InterviewInvalid("Planning interview is not ready");
	const answers = state.questions.map((q) => state.answers.find((a) => a.questionId === q.id));
	if (answers.some((a) => !a || (!a.selectedOption && !a.text.trim())))
		throw new InterviewInvalid("Every question needs an explicit answer");
	validateAnswers(answers, state.questions);
	return answers as InterviewAnswer[];
}
