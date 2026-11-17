// Mission adapter. The shared renderer never sees Plans, PlanPage, mission
// commands, proposal/revisit rules, or the mission's help and round notes.
import { computed } from "nsh";
import type { Interview, PlanPage, Question } from "pilot-day/native";
import { type InterviewRead, InterviewRenderer, type InterviewSource } from "./InterviewRenderer";
import { deferred, deferredQuestions, put as putInterview } from "./interviewView";
import {
	answerText,
	checkSubmit,
	composeAnswer,
	editAnswer,
	pickAnswer,
	saveNow,
	shownChoice,
	submit,
	unsaved,
} from "./planCommands";
import type { Plans } from "./planning";
import { answerKey, answerMessages, planMessages, submitting } from "./planView";
import { HELP_KEYS, QuestionHelp, RoundNotes, toggleQuestionHelp } from "./QuestionHelp";

export { place } from "./InterviewRenderer";

/** Kept for callers that inspect a mission answer, including unsaved drafts. */
export function hasAnswer(interview: Interview, question: Question): boolean {
	if (question.state === "changed" && !unsaved(interview, question)) return false;
	return typeof shownChoice(interview, question) === "string" || answerText(interview, question).trim() !== "";
}

export function InterviewDoc(props: { plans: Plans; page: PlanPage; interview: Interview }) {
	const iv = () => props.interview;
	const read = computed<InterviewRead>(() => {
		const saved = iv();
		const questions = saved.questions.map((q) => (deferred(saved, q) ? { ...q, state: "open" as const } : q));
		const interview = { ...saved, questions, answered: questions.filter((q) => q.state === "answered").length };
		const review = interview.kind === "review";
		return {
			interview,
			remainingRoom: interview.room,
			fresh: props.page.fresh,
			keyboardActive: true,
			busy: submitting()[interview.id] === true,
			message: planMessages()[props.page.missionId] ?? "",
			routeKey: `plan/${props.page.missionId}`,
			answers: Object.fromEntries(
				interview.questions.map((q) => [
					q.id,
					{
						deferred: deferred(interview, q),
						choice: shownChoice(interview, q),
						text: answerText(interview, q),
						unsaved: unsaved(interview, q),
						message: answerMessages()[answerKey(interview, q)] ?? "",
					},
				]),
			),
			heading: review
				? "Your review"
				: interview.kind === "topic"
					? `Questions about “${interview.topic}”`
					: interview.kind === "revisit"
						? "Revisit questions"
						: interview.round > 1
							? `Questions, round ${interview.round}`
							: "Questions",
			submitLabel: review ? "Send review" : "Submit answers",
			submissionHint:
				interview.kind === "revisit"
					? "Submitting completes this round. Nothing changes until you confirm a revision."
					: "Submitting sends every answer at once. Nothing starts building.",
			outdatedHint:
				"The plan changed since these questions were asked. Your answers are kept, but they cannot be submitted. Pilot will ask again.",
			roundHint:
				interview.kind === "revisit"
					? "New questions about gaps only. Your agreement and earlier answers stay as they are until you confirm a revision."
					: interview.round > 1 && interview.kind === "mission"
						? "New questions only. Earlier answers stay as they were, under Earlier interview rounds."
						: "",
		};
	});
	const source: InterviewSource = {
		read,
		defer(question) {
			const interview = iv();
			putInterview(deferredQuestions, answerKey(interview, question), question.digest);
			void saveNow(props.plans, answerKey(interview, question));
		},
		dispatch(command) {
			if (command.kind === "submit") {
				void submit(props.plans, props.page);
				return;
			}
			if (command.kind === "check") {
				void checkSubmit(props.plans, props.page);
				return;
			}
			const interview = iv();
			const question = interview.questions.find((q) => q.id === command.questionId);
			if (!question) return;
			switch (command.kind) {
				case "choose":
					pickAnswer(props.plans, props.page.missionId, interview, question, command.choice);
					break;
				case "edit":
					editAnswer(props.plans, props.page.missionId, interview, question, command.text);
					break;
				case "compose":
					composeAnswer(props.plans, interview, question, command.active);
					break;
				case "save":
					void saveNow(props.plans, answerKey(interview, question));
					break;
				case "help":
					if (command.help in HELP_KEYS)
						toggleQuestionHelp(
							interview,
							question,
							answerKey(interview, question),
							command.help as keyof typeof HELP_KEYS,
							props.plans.feed.askQuestion !== undefined && props.page.fresh,
						);
					break;
			}
		},
		helpKeys: HELP_KEYS,
		questionHelp: (q, key) => (
			<QuestionHelp plans={props.plans} page={props.page} interview={iv()} question={q} helpKey={key} />
		),
		roundNotes: () => (
			<If when={iv().kind !== "review" && props.plans.feed.continuePlanning !== undefined}>
				<RoundNotes plans={props.plans} page={props.page} interview={iv()} />
			</If>
		),
	};
	return <InterviewRenderer source={source} />;
}
