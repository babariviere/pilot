/** Standalone saved rounds. Publication, submission and their execution hold share one transaction. */
import { defineDoc, type ConversationId, type EntryId, type Tx } from "@earendil-works/pi-durable";
import type { AgentQuestion, InterviewQuestion, StandaloneInterviewReply } from "@pilot/protocol";
import {
	completeAnswers,
	interviewDigest,
	interviewExact,
	validateAnswers,
	validateQuestions,
} from "./interview-round.ts";

export type StandaloneRound = {
	entryId: number;
	roundId: string;
	questions: InterviewQuestion[];
	submission: { operationId: string; answers: StandaloneInterviewReply["answers"]; digest: string } | null;
};
export const StandaloneInterviewDoc = defineDoc<{ revision: number; round: StandaloneRound | null }>({
	kind: "pilot.interview",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ revision: 0, round: null }),
	checkpointWhen: () => false,
});

export function interviewQuestion(roundId: string, questions: InterviewQuestion[]): AgentQuestion {
	validateQuestions(questions);
	return {
		question: "Questions before proceeding",
		options: [],
		interview: {
			roundId,
			questions,
			questionDigests: Object.fromEntries(questions.map((q) => [q.id, interviewDigest(q)])),
		},
	};
}

export function validateInterviewReply(questions: InterviewQuestion[], reply: StandaloneInterviewReply): void {
	interviewExact(reply, ["roundId", "answers"]);
	validateAnswers(reply.answers, questions);
	completeAnswers({ questions, answers: reply.answers });
}

/** Exact human input, never an ordinary message, recommendation or coordinator answer. */
export async function acceptInterviewReply(
	tx: Tx,
	conversationId: ConversationId,
	entryId: number,
	operationId: string,
	reply: StandaloneInterviewReply,
): Promise<string> {
	const state = await tx.doc(StandaloneInterviewDoc, conversationId);
	const round = state.round;
	if (!round || round.entryId !== entryId || round.roundId !== reply.roundId || round.submission)
		throw new Error("That interview round is no longer pending");
	const entry = await tx.entry(entryId as EntryId);
	if (entry?.conversationId !== conversationId || entry.kind !== "pilot.question")
		throw new Error("Interview belongs to another conversation");
	validateInterviewReply(round.questions, reply);
	const answers = structuredClone(reply.answers);
	const submission = { operationId, answers, digest: interviewDigest({ questions: round.questions, answers }) };
	await tx.appendEntry(conversationId, {
		kind: "pilot.interview-submission",
		data: { entryId, roundId: round.roundId, questions: round.questions, ...submission },
		model: [],
	});
	round.submission = submission;
	state.revision++;
	return [
		"The user submitted these interview answers. They do not change permissions or mission approvals.",
		...round.questions.map((q) => {
			const a = answers.find((answer) => answer.questionId === q.id)!;
			return `${q.prompt}\n${JSON.stringify({ selectedOption: a.selectedOption, text: a.text })}`;
		}),
	].join("\n\n");
}
