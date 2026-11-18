// Standalone adapter for the same saved-round form missions use. Local JSON
// keeps drafts only; native code resolves exact options and digests on Submit.
import { cleanup, computed, effect, signal, Text, View, type ViewRef } from "nsh";
import type { Decision, Interview, Question, QuestionSection } from "pilot-day/native";
import { checkDecision, laterDecision, needsCheck, saveDecisionDraft } from "./commands";
import type { Day } from "./day";
import { type InterviewRead, InterviewRenderer, type InterviewSource } from "./InterviewRenderer";
import { Action, ToggleChip } from "./ui";
import { anchors, focusFront, holdFront, messages, replies, setFor } from "./view";

const SECTIONS: Record<string, QuestionSection> = {
	outcome: "outcome",
	"non-goals": "nonGoals",
	constraints: "constraints",
	acceptance: "acceptance",
	authority: "authority",
};

export function InterviewCard(props: { day: Day; decision: Decision; later: boolean; keyboardActive: boolean }) {
	const d = () => props.decision;
	const id = d().id;
	// Entry plus round identity scopes the form's kept navigation and fields.
	const interviewId = `attention/${id}/${d().interviewRoundId}`;
	const answers = signal(
		d().interviewQuestions.map((q) => ({
			questionId: q.id,
			selectedOptionId: q.selectedOptionId,
			text: q.text,
		})),
	);
	const sending = signal(false);
	const submitted = signal(false);
	const draftMessage = signal("");
	const contextOpen = signal<Record<string, boolean>>({});
	const composing = new Set<string>();
	const idle = () => d().delivery === "idle" && !sending() && !submitted();
	const serialized = () => JSON.stringify({ roundId: d().interviewRoundId, answers: answers() });
	const primary = signal<ViewRef | null>(null);
	anchors.set(id, () => primary() ?? undefined);
	effect(() => {
		if (focusFront() && primary()) {
			primary()?.focus();
			focusFront.set(false);
		}
	});
	setFor(replies, id, serialized());
	cleanup(() => {
		anchors.delete(id);
		props.day.feed.flushDrafts();
	});

	function save(questionId: string) {
		if (!idle() || composing.has(questionId)) return;
		setFor(replies, id, serialized());
		const outcome = saveDecisionDraft(props.day, d());
		draftMessage.set(outcome.status === "accepted" ? "" : outcome.message);
	}
	function edit(questionId: string, patch: { selectedOptionId?: string | null; text?: string }) {
		if (!idle()) return;
		answers.set(answers().map((a) => (a.questionId === questionId ? { ...a, ...patch } : a)));
		save(questionId);
	}
	async function submit() {
		if (!idle() || composing.size || answers().some((a) => a.selectedOptionId === null && !a.text.trim())) return;
		const text = serialized();
		sending.set(true);
		try {
			props.day.feed.flushDrafts();
			const outcome = await props.day.feed.reply({
				decisionId: id,
				revision: d().revision,
				optionId: null,
				optionIds: [],
				text,
			});
			setFor(messages, id, outcome.message);
			if (outcome.status === "accepted") {
				submitted.set(true);
				focusFront.set(true);
			}
		} finally {
			sending.set(false);
		}
	}
	const read = computed<InterviewRead>(() => {
		const local = new Map(answers().map((a) => [a.questionId, a]));
		const questions: Question[] = d().interviewQuestions.map((q) => {
			const a = local.get(q.id)!;
			return {
				id: q.id,
				section: SECTIONS[q.section] ?? "outcome",
				prompt: q.prompt,
				context: q.context,
				choices: q.options.map((o) => ({ ...o, recommended: q.recommendedOptionId === o.id })),
				chosen: a.selectedOptionId,
				text: a.text,
				state: a.selectedOptionId !== null || a.text.trim() ? "answered" : "open",
				// Presentation only. The attention bridge fills the authoritative digest.
				digest: "",
				asks: [],
				earlier: "",
				new: false,
				saving: "idle",
			};
		});
		const interview: Interview = {
			id: interviewId,
			questions,
			answered: questions.filter((q) => q.state === "answered").length,
			submit:
				sending() || d().delivery === "sending"
					? "submitting"
					: d().delivery === "checking"
						? "checking"
						: needsCheck(d())
							? "unknown"
							: submitted()
								? "submitted"
								: "open",
			current: true,
			accepting: true,
			unconfirmed: needsCheck(d()),
			// These native Interview fields are not rendered for standalone rounds.
			kind: "mission",
			topic: "",
			round: 1,
			revision: d().revision,
			questionSet: 1,
			proposal: "",
			room: 0,
		};
		return {
			interview,
			// The immutable shown question stays answerable during unrelated activity.
			// Native checks its exact entry and scope when Submit is pressed.
			fresh: true,
			keyboardActive: props.keyboardActive,
			busy: sending(),
			message: draftMessage() || messages()[id] || "",
			routeKey: "today",
			heading: "Questions before proceeding",
			submitLabel: "Submit answers",
			submissionHint: "Submitting sends every answer at once and resumes the chat within its current permissions.",
			roundHint: d().draft.unsaved
				? "Pilot could not save this draft. Copy your answers before closing."
				: "Drafts do not continue the chat. Only Submit answers sends the full round.",
			answers: Object.fromEntries(
				questions.map((q) => [
					q.id,
					{
						choice: q.chosen ?? (q.text.trim() ? null : undefined),
						text: q.text,
						unsaved: d().draft.unsaved || draftMessage() !== "",
						message: draftMessage(),
					},
				]),
			),
		};
	});
	const toggleContext = (questionId: string) =>
		contextOpen.set({ ...contextOpen(), [questionId]: !contextOpen()[questionId] });
	const source: InterviewSource = {
		read,
		dispatch(command) {
			switch (command.kind) {
				case "choose":
					edit(command.questionId, { selectedOptionId: command.choice || null });
					break;
				case "edit":
					edit(command.questionId, { text: command.text });
					break;
				case "compose":
					if (command.active) composing.add(command.questionId);
					else {
						composing.delete(command.questionId);
						save(command.questionId);
					}
					break;
				case "save":
					save(command.questionId);
					props.day.feed.flushDrafts();
					break;
				case "submit":
					void submit();
					break;
				case "check":
					void checkDecision(props.day, d());
					break;
				case "help":
					if (command.help === "context") toggleContext(command.questionId);
					break;
				case "focus":
					// Answering this round keeps it in front while it waits.
					holdFront(id);
					break;
			}
		},
		helpKeys: { context: "m" },
		questionHelp: (q) => (
			<If when={q.context}>
				<View class="flex-row flex-wrap gap-1.5">
					<ToggleChip
						label="More context"
						shortcut="M"
						pressed={contextOpen()[q.id] === true}
						onChange={() => toggleContext(q.id)}
					/>
				</View>
				<If when={contextOpen()[q.id]}>
					<Text testID={`context-${q.id}`} class="text-sm text-muted-foreground">
						{q.context}
					</Text>
				</If>
			</If>
		),
	};
	return (
		<View testID="interview-card" class="gap-4">
			<InterviewRenderer source={source} anchor={(node) => primary.set(node)} />
			<If when={props.later}>
				<Action label="Later" disabled={!idle()} onPress={() => laterDecision(props.day, d())} />
			</If>
		</View>
	);
}
