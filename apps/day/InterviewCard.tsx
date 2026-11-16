// Standalone attention round. Native projects saved JSON and resolves exact
// options/digests on Submit. This view only edits and presents draft answers.
import { cleanup, effect, signal, Text, View, type ViewRef } from "nsh";
import { Input, Radio, RadioGroup } from "nsh/base";
import type { Decision } from "pilot-day/native";
import { checkDecision, laterDecision, needsCheck, saveDecisionDraft } from "./commands";
import type { Day } from "./day";
import { Action, Mark } from "./ui";
import { anchors, focusFront, messages, replies, setFor } from "./view";

// Same plain section labels as the mission interview's InterviewDoc.
const SECTION_WORDS: Record<string, string> = {
	outcome: "What it should achieve",
	"non-goals": "What to leave out",
	constraints: "Limits",
	acceptance: "How you will know",
	authority: "What Pilot may do",
};

/** No answer, including a custom answer, is chosen merely by opening a round. */
export function customAnswerSelected(
	answer: { selectedOptionId: string | null; text: string },
	explicit = false,
): boolean {
	return answer.selectedOptionId === null && (explicit || answer.text.trim() !== "");
}

export function InterviewCard(props: { day: Day; decision: Decision; later: boolean }) {
	const d = () => props.decision;
	const id = d().id;
	const answers = signal(
		d().interviewQuestions.map((q) => ({
			questionId: q.id,
			selectedOptionId: q.selectedOptionId,
			text: q.text,
		})),
	);
	const review = signal(needsCheck(d()));
	const customChoices = signal<Record<string, boolean>>({});
	const sending = signal(false);
	const idle = () => d().delivery === "idle" && !sending();
	const complete = () =>
		answers().length > 0 && answers().every((a) => a.selectedOptionId !== null || a.text.trim() !== "");
	const serialized = () => JSON.stringify({ roundId: d().interviewRoundId, answers: answers() });
	const answer = (id: string) => answers().find((a) => a.questionId === id)!;
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

	function edit(questionId: string, patch: { selectedOptionId?: string | null; text?: string }) {
		if (!idle() || review()) return;
		answers.set(answers().map((a) => (a.questionId === questionId ? { ...a, ...patch } : a)));
		setFor(replies, id, serialized());
		saveDecisionDraft(props.day, d());
	}
	async function submit() {
		if (!idle() || !review() || !complete()) return;
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
			if (outcome.status === "accepted") focusFront.set(true);
		} finally {
			sending.set(false);
		}
	}
	return (
		<View testID="interview-card" class="gap-4 rounded-2xl border border-border-strong bg-card px-6 py-6">
			<Text role="header" class="text-xl font-semibold leading-snug text-card-foreground">
				Questions before proceeding
			</Text>
			<View class="flex-row items-center gap-1.5">
				<Mark kind={needsCheck(d()) ? "unknown" : "needs"} />
				<Text class="text-xs text-muted-foreground">{d().missionTitle}</Text>
			</View>
			<Text class="text-sm text-muted-foreground">
				Answer every question, then review the full round. Drafts do not continue the chat.
			</Text>
			<Each of={d().interviewQuestions} key={(q) => q.id}>
				{(q) => (
					<View testID={`interview-question-${q().id}`} class="gap-2 border-t border-border pt-4">
						<Text class="text-xs text-muted-foreground">{SECTION_WORDS[q().section] ?? q().section}</Text>
						<Text class="text-sm font-medium text-card-foreground">{q().prompt}</Text>
						<If when={q().context}>
							<Text class="text-sm text-muted-foreground">{q().context}</Text>
						</If>
						<If
							when={!review()}
							else={
								<View class="gap-1">
									<Text testID={`interview-review-${q().id}`} class="text-sm text-foreground">
										{q().options.find((o) => o.id === answer(q().id).selectedOptionId)?.meaning ??
											"Your own answer"}
									</Text>
									<If when={answer(q().id).text}>
										<Text class="text-sm text-foreground">{answer(q().id).text}</Text>
									</If>
								</View>
							}
						>
							<RadioGroup class="gap-1">
								<Each of={q().options} key={(o) => o.id}>
									{(o) => (
										<Radio
											testID={`interview-option-${q().id}-${o().id}`}
											checked={answer(q().id).selectedOptionId === o().id}
											disabled={!idle()}
											onChange={() => {
												if (!idle() || review()) return;
												customChoices.set({ ...customChoices(), [q().id]: false });
												edit(q().id, { selectedOptionId: o().id });
											}}
											class="group flex-row gap-3 rounded-xl px-3 py-2.5 checked:bg-selection hover:bg-accent checked:hover:bg-selection disabled:opacity-70 focus-visible:ring-2 focus-visible:ring-ring/40"
										>
											<View class="mt-0.5 size-4 items-center justify-center rounded-full border border-input group-checked:border-primary">
												<View class="size-2 rounded-full group-checked:bg-primary" />
											</View>
											<View class="min-w-0 flex-1 gap-0.5">
												<Text class="text-sm text-card-foreground">{o().meaning}</Text>
												<If when={q().recommendedOptionId === o().id}>
													<Text class="text-xs text-muted-foreground">Recommended</Text>
												</If>
											</View>
										</Radio>
									)}
								</Each>
								<Radio
									testID={`interview-custom-${q().id}`}
									checked={customAnswerSelected(answer(q().id), customChoices()[q().id])}
									disabled={!idle()}
									onChange={() => {
										if (!idle() || review()) return;
										customChoices.set({ ...customChoices(), [q().id]: true });
										edit(q().id, { selectedOptionId: null });
									}}
									class="group flex-row gap-3 rounded-xl px-3 py-2.5 checked:bg-selection hover:bg-accent checked:hover:bg-selection disabled:opacity-70 focus-visible:ring-2 focus-visible:ring-ring/40"
								>
									<View class="mt-0.5 size-4 items-center justify-center rounded-full border border-input group-checked:border-primary">
										<View class="size-2 rounded-full group-checked:bg-primary" />
									</View>
									<Text class="text-sm text-card-foreground">Answer in my own words</Text>
								</Radio>
							</RadioGroup>
							<Input
								testID={`interview-text-${q().id}`}
								multiline
								value={answer(q().id).text}
								disabled={!idle()}
								onChange={({ value }) => edit(q().id, { text: value })}
								onBlur={() => props.day.feed.flushDrafts()}
								placeholder="Your answer, or extra detail"
								class="min-h-8 rounded-lg border border-input bg-background px-3 py-1.5 text-sm text-foreground focus:border-primary"
							/>
						</If>
					</View>
				)}
			</Each>
			<If when={d().draft.unsaved}>
				<Text role="alert" class="text-sm text-needs-ink">
					Pilot could not save this draft. Copy your answers before closing.
				</Text>
			</If>
			<If when={messages()[id]}>
				<Text role="alert" class="text-sm text-needs-ink">
					{messages()[id] ?? ""}
				</Text>
			</If>
			<If when={d().delivery === "sending" || sending()}>
				<Text class="text-sm text-muted-foreground">Sending your answers…</Text>
			</If>
			<If when={needsCheck(d())}>
				<Text class="text-sm text-muted-foreground">
					Submission not confirmed. Check only reads its receipt; it never sends again.
				</Text>
			</If>
			<View class="flex-row flex-wrap items-center gap-2">
				<If
					when={needsCheck(d())}
					else={
						<If
							when={review()}
							else={
								<Action
									primary
									testID="interview-review"
									label="Review answers"
									anchor={(node) => {
										primary.set(node);
									}}
									disabled={!idle() || !complete()}
									onPress={() => review.set(true)}
								/>
							}
						>
							<Action
								primary
								testID="interview-submit"
								label="Submit"
								anchor={(node) => {
									primary.set(node);
								}}
								disabled={!idle() || !complete()}
								onPress={() => void submit()}
							/>
							<Action label="Edit answers" disabled={!idle()} onPress={() => review.set(false)} />
						</If>
					}
				>
					<Action
						primary
						label="Check again"
						disabled={d().delivery === "checking"}
						onPress={() => void checkDecision(props.day, d())}
					/>
				</If>
				<If when={props.later}>
					<Action label="Later" disabled={!idle()} onPress={() => laterDecision(props.day, d())} />
				</If>
			</View>
		</View>
	);
}
