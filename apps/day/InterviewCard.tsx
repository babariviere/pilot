// Standalone adapter for the same saved-round form missions use. Local JSON
// keeps drafts only; native code resolves exact options and digests on Submit.
import { cleanup, computed, effect, signal, View, type ViewRef } from "nsh";
import type { Decision, IntentOutcome, Interview, Question, QuestionSection } from "pilot-day/native";
import { checkDecision, laterDecision, needsCheck, saveDecisionDraft } from "./commands";
import type { Day } from "./day";
import { type InterviewRead, InterviewRenderer, type InterviewSource } from "./InterviewRenderer";
import { Button, Chip, Chips, Quote } from "./ui";
import { anchors, focusFront, holdFront, messages, replies, setFor } from "./view";

const SECTIONS: Record<string, QuestionSection> = {
	outcome: "outcome",
	"non-goals": "nonGoals",
	constraints: "constraints",
	acceptance: "acceptance",
	authority: "authority",
};

type DraftAnswer = Pick<Decision["interviewQuestions"][number], "selectedOptionId" | "text"> & {
	questionId: string;
};

function initialAnswers(decision: Decision, kept?: string): DraftAnswer[] {
	const saved = new Map<string, DraftAnswer>();
	if (kept && decision.delivery === "idle") {
		try {
			const draft = JSON.parse(kept);
			if (draft?.roundId === decision.interviewRoundId && Array.isArray(draft?.answers)) {
				for (const a of draft.answers) {
					if (
						typeof a?.questionId === "string" &&
						typeof a.text === "string" &&
						(a.selectedOptionId === null || typeof a.selectedOptionId === "string")
					)
						saved.set(a.questionId, a);
				}
			}
		} catch {
			// The kept window draft is optional; use native projection when unreadable.
		}
	}
	return decision.interviewQuestions.map((q) => {
		const a = saved.get(q.id);
		return {
			questionId: q.id,
			selectedOptionId: a
				? q.options.some((o) => o.id === a.selectedOptionId)
					? a.selectedOptionId
					: null
				: q.selectedOptionId,
			text: a?.text ?? q.text,
		};
	});
}

export function InterviewCard(props: { day: Day; decision: Decision; later: boolean; keyboardActive: boolean }) {
	const d = () => props.decision;
	const id = d().id;
	const primary = signal<ViewRef | null>(null);
	anchors.set(id, () => primary() ?? undefined);
	effect(() => {
		if (focusFront() && primary()) {
			primary()?.focus();
			focusFront.set(false);
		}
	});
	cleanup(() => {
		anchors.delete(id);
		props.day.feed.flushDrafts();
	});
	return (
		<InterviewForm
			decision={d()}
			identity={`attention/${id}/${d().interviewRoundId}`}
			keyboardActive={props.keyboardActive}
			anchor={(node) => primary.set(node)}
			initialize={(text) => setFor(replies, id, text)}
			message={messages()[id]}
			onSave={(text) => {
				setFor(replies, id, text);
				const outcome = saveDecisionDraft(props.day, d());
				return outcome.status === "accepted" ? "" : outcome.message;
			}}
			onFlush={() => props.day.feed.flushDrafts()}
			onSubmit={async (text) => {
				const outcome = await props.day.feed.reply({
					decisionId: id,
					revision: d().revision,
					optionId: null,
					optionIds: [],
					text,
				});
				setFor(messages, id, outcome.message);
				if (outcome.status === "accepted") focusFront.set(true);
				return outcome;
			}}
			onCheck={() => void checkDecision(props.day, d())}
			onFocus={() => holdFront(id)}
			onLater={props.later ? () => laterDecision(props.day, d()) : undefined}
		/>
	);
}

/** The same round form without the selected project's draft or command state. */
export function ScopedInterviewCard(props: {
	decision: Decision;
	/** Stable project, entry and round identity. Remount when the pinned form changes. */
	identity: string;
	keyboardActive: boolean;
	/** Optional window draft for this exact pin, read only on mount. */
	draftText?: string;
	draftMessage?: string;
	onSave: (text: string) => void;
	onSubmit: (text: string) => Promise<IntentOutcome>;
	onCheck: () => void;
}) {
	return (
		<InterviewForm
			decision={props.decision}
			identity={`scoped-attention/${props.identity}`}
			keyboardActive={props.keyboardActive}
			draftText={props.draftText}
			draftMessage={props.draftMessage}
			onSave={props.onSave}
			onSubmit={props.onSubmit}
			onCheck={props.onCheck}
		/>
	);
}

function InterviewForm(props: {
	decision: Decision;
	identity: string;
	keyboardActive: boolean;
	anchor?: (node: ViewRef) => void;
	initialize?: (text: string) => void;
	message?: string;
	draftText?: string;
	draftMessage?: string;
	onSave: (text: string) => string | void;
	onFlush?: () => void;
	onSubmit: (text: string) => Promise<IntentOutcome>;
	onCheck: () => void;
	onLater?: () => void;
	onFocus?: () => void;
}) {
	const d = () => props.decision;
	const interviewId = props.identity;
	const roundId = d().interviewRoundId;
	const answers = signal(initialAnswers(d(), props.draftText));
	const sending = signal(false);
	const submitted = signal(false);
	const draftMessage = signal("");
	const resultMessage = signal("");
	const contextOpen = signal<Record<string, boolean>>({});
	const composing = new Set<string>();
	const idle = () => !!roundId && d().delivery === "idle" && !sending() && !submitted();
	const serialized = () => JSON.stringify({ roundId, answers: answers() });
	props.initialize?.(serialized());

	function save(questionId: string) {
		if (!idle() || composing.has(questionId)) return;
		draftMessage.set(props.onSave(serialized()) ?? "");
	}
	function edit(questionId: string, patch: { selectedOptionId?: string | null; text?: string }) {
		if (!idle()) return;
		answers.set(answers().map((a) => (a.questionId === questionId ? { ...a, ...patch } : a)));
		save(questionId);
	}
	async function submit() {
		if (
			!idle() ||
			composing.size ||
			!answers().length ||
			answers().some((a) => a.selectedOptionId === null && !a.text.trim())
		)
			return;
		const text = serialized();
		sending.set(true);
		try {
			props.onFlush?.();
			const outcome = await props.onSubmit(text);
			resultMessage.set(outcome.message);
			if (outcome.status === "accepted") submitted.set(true);
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
			message: props.draftMessage || draftMessage() || props.message || resultMessage(),
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
						unsaved: d().draft.unsaved || !!props.draftMessage || draftMessage() !== "",
						message: props.draftMessage || draftMessage(),
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
					props.onFlush?.();
					break;
				case "submit":
					void submit();
					break;
				case "check":
					if (needsCheck(d()) && d().delivery !== "checking") props.onCheck();
					break;
				case "help":
					if (command.help === "context") toggleContext(command.questionId);
					break;
				case "focus":
					// Answering this round keeps it in front while it waits.
					props.onFocus?.();
					break;
			}
		},
		helpKeys: { context: "m" },
		questionHelp: (q) => (
			<If when={q.context}>
				<Chips>
					<Chip
						label="More context"
						shortcut="M"
						pressed={contextOpen()[q.id] === true}
						onChange={() => toggleContext(q.id)}
					/>
				</Chips>
				<If when={contextOpen()[q.id]}>
					<Quote testID={`context-${q.id}`} text={q.context} />
				</If>
			</If>
		),
		foot: () => (
			<If when={props.onLater}>
				<Button label="Later" disabled={!idle()} onPress={() => props.onLater?.()} />
			</If>
		),
	};
	return (
		<View testID="interview-card">
			<InterviewRenderer source={source} anchor={(node) => props.anchor?.(node)} />
		</View>
	);
}
