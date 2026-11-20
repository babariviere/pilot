import type { InterviewAnswer, InterviewQuestion, MissionInterview } from "@pilot/protocol";
import * as round from "@pilot/kernel/interview-round";
import { Conflict } from "./errors.ts";
export const interviewDigest = round.interviewDigest;
export const ANSWERS_LIMIT = round.ANSWERS_LIMIT;
const AGREEMENT_LIMIT = 28 * 1024;
function checked<T>(work: () => T): T {
	try {
		return work();
	} catch (error) {
		if (error instanceof round.InterviewInvalid) throw new Conflict(error.message);
		throw error;
	}
}
export function interviewExact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
	checked(() => round.interviewExact(value, keys));
}
export function interviewText(value: unknown, max: number, empty = false): asserts value is string {
	checked(() => round.interviewText(value, max, empty));
}
export function interviewId(value: unknown): asserts value is string {
	checked(() => round.interviewId(value));
}
export function validateQuestions(value: unknown): asserts value is InterviewQuestion[] {
	checked(() => round.validateQuestions(value));
}
export function validateAnswers(value: unknown, questions: InterviewQuestion[]): asserts value is InterviewAnswer[] {
	checked(() => round.validateAnswers(value, questions));
}
export function completeAnswers(state: Pick<MissionInterview, "questions" | "answers">): InterviewAnswer[] {
	return checked(() => round.completeAnswers(state));
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
	// The agreement becomes the mission brief, which every worker reads: its size is model cost on every turn.
	const bytes = Buffer.byteLength(markdown);
	if (bytes > AGREEMENT_LIMIT)
		throw new Conflict(
			`The agreement would be ${Math.ceil(bytes / 1024)} KiB, more than ${AGREEMENT_LIMIT / 1024} KiB. Shorten the longest answers.`,
		);
	interviewText(markdown, AGREEMENT_LIMIT);
	return markdown;
}
