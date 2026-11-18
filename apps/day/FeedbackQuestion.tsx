// Feedback adapter for the same presentation used by mission and standalone interviews.
// The feedback source still owns exact question delivery and receipt reconciliation.
import { cleanup, computed, signal, Text, View } from "nsh";
import type { Interview, Question } from "pilot-day/native";
import type { ArtifactSource } from "./artifactReads";
import type { FeedbackItem, StepIntent, StepResult, UserFeedbackQuestion } from "./feedbackFeed";
import { MAX_ANSWER_LENGTH } from "./feedbackFeed";
import { answerKey, answerMessage, type ChatStep } from "./feedbackSteps";
import { answerDrafts, setAnswerDraft, stepMessages } from "./feedbackView";
import { type InterviewRead, InterviewRenderer, type InterviewSource } from "./InterviewRenderer";
import { QuestionArtifacts } from "./QuestionArtifacts";
import { ToggleChip } from "./ui";

// Only the form the user last touched owns its shortcuts, even in feedback history.
const activeQuestion = signal<string | null>(null);

export function FeedbackQuestion(props: {
	item: FeedbackItem;
	/** The asking chat: a triage, a prototype or a fix. */
	triage: ChatStep;
	question: UserFeedbackQuestion;
	/** Reads the mockups the chat attached. Without it they are not shown. */
	artifacts?: ArtifactSource;
	correctionDigest?: string;
	busy: boolean;
	sending: boolean;
	unknown?: { state: "unknown" | "checking"; operationId: string; replyKey?: string } | null;
	keyboardActive?: boolean;
	routeKey?: string;
	send: (intent: StepIntent) => Promise<StepResult>;
	check: (operationId: string) => Promise<void>;
}) {
	const qid = props.correctionDigest ? `correction-${props.correctionDigest}` : String(props.question.id);
	const key = props.correctionDigest ? `${props.triage.sessionId}/${qid}` : answerKey(props.triage, props.question);
	const draft = () => answerDrafts()[key] ?? { picks: [], text: "" };
	const unknown = () =>
		props.unknown && (!props.unknown.replyKey || props.unknown.replyKey === key) ? props.unknown : null;
	const context = signal(false);
	const composing = signal(false);
	const message = () => answerMessage(props.question, draft().picks, draft().text);
	const tooLong = () => message().length > MAX_ANSWER_LENGTH;
	const editable = () => !props.busy && !props.unknown;
	cleanup(() => {
		if (activeQuestion() === key) activeQuestion.set(null);
	});
	const read = computed<InterviewRead>(() => {
		const d = draft();
		const answered = !!message().trim() && !tooLong();
		const question: Question = {
			id: qid,
			section: "outcome",
			prompt: props.question.question,
			context: props.question.context ?? "",
			choices: props.question.options.map((o, n) => ({
				id: String(n),
				meaning: o.label,
				recommended: o.suggested === true,
			})),
			chosen: d.picks.length ? String(d.picks[0]) : null,
			text: d.text,
			state: answered ? "answered" : "open",
			digest: "",
			asks: [],
			earlier: "",
			new: false,
			saving: "idle",
		};
		const interview: Interview = {
			id: `feedback/${key}`,
			questions: [question],
			answered: answered ? 1 : 0,
			submit:
				unknown()?.state === "checking"
					? "checking"
					: unknown()
						? "unknown"
						: props.sending
							? "submitting"
							: "open",
			current: true,
			accepting: true,
			unconfirmed: !!unknown(),
			kind: "mission",
			topic: "",
			round: 1,
			revision: 1,
			questionSet: 1,
			proposal: "",
			room: 0,
		};
		return {
			interview,
			fresh: !props.busy || !!unknown() || props.sending,
			keyboardActive: activeQuestion() ? activeQuestion() === key : (props.keyboardActive ?? true),
			busy: props.busy || composing() || tooLong(),
			routeKey: props.routeKey ?? "feedback",
			message: tooLong()
				? `Too long. Keep it under ${MAX_ANSWER_LENGTH} characters.`
				: (stepMessages()[props.item.id] ?? ""),
			heading: props.correctionDigest ? "Correct the investigation" : "Questions before proceeding",
			submitLabel: props.correctionDigest ? "Send correction" : "Submit answers",
			submissionHint:
				props.triage.kind === "prototype"
					? "Your choice becomes the fix proposal. It starts no fix."
					: props.triage.kind === "fix"
						? "Goes to the fix chat only. It approves nothing else."
						: "Clarifies this investigation only. Starts no fix and approves nothing.",
			roundHint: props.question.multiSelect
				? "Choose all that apply. Only Submit answers sends your answer."
				: "Drafts do not continue the chat. Only Submit answers sends your answer.",
			answers: {
				[qid]: {
					choice: question.chosen,
					...(props.question.multiSelect ? { choices: d.picks.map(String) } : {}),
					text: d.text,
					unsaved: false,
					message: "",
				},
			},
		};
	});
	const source: InterviewSource = {
		read,
		dispatch(command) {
			if (
				command.kind === "choose" ||
				command.kind === "edit" ||
				command.kind === "compose" ||
				command.kind === "help" ||
				command.kind === "focus"
			)
				activeQuestion.set(key);
			if (command.kind === "check") {
				const pending = unknown();
				if (pending) void props.check(pending.operationId);
				return;
			}
			if (command.kind === "help") {
				context.set(!context());
				return;
			}
			if (command.kind === "compose") {
				composing.set(command.active);
				return;
			}
			if (!editable()) return;
			if (command.kind === "choose") {
				const n = Number(command.choice);
				const picks =
					command.choice === ""
						? []
						: props.question.multiSelect
							? draft().picks.includes(n)
								? draft().picks.filter((p) => p !== n)
								: [...draft().picks, n]
							: [n];
				setAnswerDraft(key, { ...draft(), picks });
			} else if (command.kind === "edit") setAnswerDraft(key, { ...draft(), text: command.text });
			else if (command.kind === "submit" && !composing() && message().trim() && !tooLong()) {
				const sent = answerDrafts()[key];
				void props
					.send(
						props.correctionDigest
							? {
									action: "correct",
									feedbackId: props.item.id,
									triageSessionId: props.triage.sessionId,
									proposalDigest: props.correctionDigest,
									message: message(),
								}
							: {
									action: "answer",
									feedbackId: props.item.id,
									triageSessionId: props.triage.sessionId,
									questionId: props.question.id,
									message: message(),
								},
					)
					.then((r) => {
						if (r.status === "accepted" && answerDrafts()[key] === sent) setAnswerDraft(key, null);
					});
			}
		},
		helpKeys: { context: "m" },
		choiceDetail: (_question, id) => props.question.options[Number(id)]?.detail ?? "",
		questionHelp: () => (
			<If when={props.question.context}>
				<View class="gap-2">
					<View class="flex-row">
						<ToggleChip label="More context" pressed={context()} onChange={() => context.set(!context())} />
					</View>
					<If when={context()}>
						<Text class="text-sm text-muted-foreground">{props.question.context ?? ""}</Text>
					</If>
				</View>
			</If>
		),
	};
	return (
		<View testID={`feedback-question-${props.item.id}`} class="gap-2.5">
			<If when={props.artifacts && props.question.artifacts?.length}>
				<QuestionArtifacts source={props.artifacts as ArtifactSource} artifacts={props.question.artifacts ?? []} />
			</If>
			<InterviewRenderer source={source} />
		</View>
	);
}
