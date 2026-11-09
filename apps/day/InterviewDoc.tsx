// A saved interview. Pilot writes the whole question list first; the
// screen shows one question at a time. The user moves to any question with
// Back, Next or the numbers above it, skips and comes back, and ends on a
// page with every answer and the one Submit. Each question has suggested
// answers (one may be marked Recommended), "Something else", and a text
// field for the user's own answer or added detail. Answers save as drafts;
// a recommendation is never an answer.
import { computed, effect, keymap, Text, View, type ViewRef } from "nsh";
import { Button, Input, Radio, RadioGroup, Toggle } from "nsh/base";
import type { Interview, PlanPage, Question, QuestionSection } from "pilot-day/native";
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
import { answerKey, answerMessages, atQuestion, focusAsk, planMessages, put, seeAll, submitting } from "./planView";
import { Action, Mark, type MarkKind } from "./ui";

/** The page after the last question: every answer, and Submit. No question id can hold a NUL. */
const REVIEW = "\u0000answers";

const SECTION_WORDS: Record<QuestionSection, string> = {
	outcome: "What it should achieve",
	nonGoals: "What to leave out",
	constraints: "Limits",
	acceptance: "How you will know",
	authority: "What Pilot may do",
};
const SECTIONS = Object.keys(SECTION_WORDS) as QuestionSection[];

/** The keystroke that moves on, as the platform writes it. */
const NEXT_KEY = keymap.label("mod+enter");

/** Whether the answers are fixed: submitted, on their way, or not confirmed. */
function fixed(interview: Interview): boolean {
	return interview.submit !== "open" || interview.unconfirmed;
}

/** Whether the user gave this question an answer, saved or not yet. */
export function hasAnswer(interview: Interview, question: Question): boolean {
	if (question.state === "changed" && !unsaved(interview, question)) return false;
	const choice = shownChoice(interview, question);
	if (typeof choice === "string") return true;
	return answerText(interview, question).trim() !== "";
}

/** The question or page the interview shows: the user's place, else the first without an answer. */
export function place(interview: Interview): string {
	if (fixed(interview)) return REVIEW;
	const at = atQuestion()[interview.id];
	if (at === REVIEW || interview.questions.some((q) => q.id === at)) return at;
	return interview.questions.find((q) => q.state !== "answered")?.id ?? REVIEW;
}

/** Saves what the current question has, then shows `to`. */
function go(plans: Plans, interview: Interview, to: string) {
	const now = place(interview);
	const current = interview.questions.find((q) => q.id === now);
	if (current) void saveNow(plans, answerKey(interview, current));
	put(atQuestion, interview.id, to);
	const next = interview.questions.find((q) => q.id === to);
	focusAsk.set(next ? answerKey(interview, next) : null);
}

/** Moves `step` questions on or back; past the last is the answers page. */
function step(plans: Plans, interview: Interview, step: number) {
	const ids = interview.questions.map((q) => q.id);
	const now = place(interview);
	const at = now === REVIEW ? ids.length : ids.indexOf(now);
	const to = at + step;
	if (to < 0) return;
	go(plans, interview, to >= ids.length ? REVIEW : ids[to]);
}

function questionMark(interview: Interview, question: Question): MarkKind {
	if (question.state === "changed" && !unsaved(interview, question)) return "unknown";
	return hasAnswer(interview, question) ? "ready" : "unreported";
}

/** One line about a question's save, or nothing. */
function saveLine(interview: Interview, question: Question): string {
	if (question.saving === "sending") return "Saving…";
	if (unsaved(interview, question)) return "Not saved yet";
	if (question.state === "answered" && !fixed(interview)) return "Saved";
	return "";
}

function placeholder(choice: string | null | undefined): string {
	if (choice === null) return "Write your answer";
	if (choice === undefined) return "Or write your own answer";
	return "Add detail (optional)";
}

/** The numbers above the question: where each question is, and a way to reach it. */
function Index(props: { plans: Plans; interview: Interview }) {
	const iv = () => props.interview;
	return (
		<View class="flex-row flex-wrap gap-1">
			<Each of={iv().questions} key={(q) => q.id}>
				{(q) => {
					const n = () => iv().questions.findIndex((x) => x.id === q().id) + 1;
					const here = () => place(iv()) === q().id;
					const word = () =>
						questionMark(iv(), q()) === "ready"
							? "answered"
							: questionMark(iv(), q()) === "unknown"
								? "changed, answer again"
								: "not answered";
					return (
						<Button
							testID={`goto-${q().id}`}
							accessibilityLabel={`Question ${n()}, ${word()}`}
							onPress={() => go(props.plans, iv(), q().id)}
							class="size-7 items-center justify-center rounded-md hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40"
							classList={{ "bg-selection": here() }}
						>
							<Text
								class="text-xs"
								classList={{
									"text-foreground font-semibold": here(),
									"text-ok-ink": !here() && questionMark(iv(), q()) === "ready",
									"text-needs-ink": !here() && questionMark(iv(), q()) === "unknown",
									"text-faint": !here() && questionMark(iv(), q()) === "unreported",
								}}
							>
								{String(n())}
							</Text>
						</Button>
					);
				}}
			</Each>
			<Button
				testID="goto-review"
				accessibilityLabel="Your answers and Submit"
				onPress={() => go(props.plans, iv(), REVIEW)}
				class="h-7 items-center justify-center rounded-md px-2 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40"
				classList={{ "bg-selection": place(iv()) === REVIEW }}
			>
				<Text class="text-xs text-muted-foreground">Answers</Text>
			</Button>
		</View>
	);
}

/** One question: its words, suggestions, "Something else" and the text field. */
function QuestionView(props: {
	plans: Plans;
	page: PlanPage;
	interview: Interview;
	question: Question;
	/** Shown in the list of all questions: a smaller title. */
	compact?: boolean;
}) {
	const q = () => props.question;
	const iv = () => props.interview;
	const key = answerKey(props.interview, props.question);
	const choice = computed(() => shownChoice(iv(), q()));
	const text = computed(() => answerText(iv(), q()));
	const locked = () => fixed(iv());
	// Answering keeps this question in front: the place no longer depends on what is unanswered.
	const stay = () => put(atQuestion, iv().id, q().id);
	const pick = (id: string | null) => {
		stay();
		pickAnswer(props.plans, props.page.missionId, iv(), q(), id);
	};
	const radios: ViewRef[] = [];
	effect(() => {
		if (focusAsk() !== key) return;
		const at = q().choices.findIndex((c) => c.id === choice());
		const target = radios[Math.max(at, 0)];
		if (target) {
			target.focus();
			focusAsk.set(null);
		}
	});
	return (
		<View testID={`question-${q().id}`} class="gap-3">
			<Text class="text-xs text-faint">
				{q().new ? `${SECTION_WORDS[q().section]} · New this round` : SECTION_WORDS[q().section]}
			</Text>
			<Text
				role="header"
				class={
					props.compact
						? "text-base font-semibold leading-snug text-foreground"
						: "text-xl font-semibold leading-snug text-foreground"
				}
			>
				{q().prompt}
			</Text>
			<If when={q().state === "changed"}>
				<View class="gap-0.5 rounded-lg bg-muted px-3 py-2">
					<Text class="text-sm text-needs-ink">This question changed after you answered. Answer it again.</Text>
					<Text class="text-xs text-muted-foreground">{`Your earlier answer: ${q().earlier}`}</Text>
				</View>
			</If>
			<RadioGroup class="gap-0.5">
				<Each of={q().choices} key={(c) => c.id}>
					{(c) => (
						<Radio
							ref={(node) => {
								radios[q().choices.findIndex((x) => x.id === c().id)] = node;
							}}
							checked={choice() === c().id}
							disabled={locked()}
							accessibilityLabel={c().recommended ? `${c().meaning}, recommended` : c().meaning}
							onChange={() => pick(c().id)}
							class="group flex-row gap-3 rounded-lg px-2.5 py-2 checked:bg-selection hover:bg-accent checked:hover:bg-selection disabled:opacity-70 focus-visible:ring-2 focus-visible:ring-ring/40"
						>
							<View class="mt-0.5 size-4 items-center justify-center rounded-full border border-input group-checked:border-primary">
								<View class="size-2 rounded-full group-checked:bg-primary" />
							</View>
							<View class="flex-1 flex-row flex-wrap items-baseline gap-2">
								<Text class="text-sm text-foreground">{c().meaning}</Text>
								<If when={c().recommended}>
									<Text class="text-xs text-muted-foreground">Recommended</Text>
								</If>
							</View>
						</Radio>
					)}
				</Each>
				<Radio
					checked={choice() === null}
					disabled={locked()}
					onChange={() => pick(null)}
					class="group flex-row gap-3 rounded-lg px-2.5 py-2 checked:bg-selection hover:bg-accent checked:hover:bg-selection disabled:opacity-70 focus-visible:ring-2 focus-visible:ring-ring/40"
				>
					<View class="mt-0.5 size-4 items-center justify-center rounded-full border border-input group-checked:border-primary">
						<View class="size-2 rounded-full group-checked:bg-primary" />
					</View>
					<Text class="flex-1 text-sm text-muted-foreground">Something else</Text>
				</Radio>
			</RadioGroup>
			<View class="gap-1">
				<Input
					testID={`answer-${q().id}`}
					accessibilityLabel={`Your answer to: ${q().prompt}`}
					multiline
					readonly={locked()}
					value={text()}
					placeholder={placeholder(choice())}
					onChange={({ value }) => {
						stay();
						editAnswer(props.plans, props.page.missionId, iv(), q(), value);
					}}
					onCompositionChange={({ composing }) => composeAnswer(props.plans, iv(), q(), composing)}
					onBlur={() => void saveNow(props.plans, key)}
					class="min-h-16 rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-primary"
				/>
				<View class="flex-row gap-2">
					<If when={answerMessages()[key]}>
						<Text role="alert" class="flex-1 text-xs text-needs-ink">
							{answerMessages()[key] ?? ""}
						</Text>
					</If>
					<If when={iv().room < 2048}>
						<Text class="flex-1 text-xs text-needs-ink">
							{`Room left for all answers: about ${iv().room} characters.`}
						</Text>
					</If>
					<View class="flex-1" />
					<Text class="text-xs text-faint">{saveLine(iv(), q())}</Text>
				</View>
			</View>
		</View>
	);
}

/** Where the one submission is, in a sentence, or nothing while open. */
function submitLine(interview: Interview): string {
	if (interview.unconfirmed && interview.submit === "open")
		return "An answer was sent but not confirmed. Pilot only checks it; it sends nothing more until then.";
	switch (interview.submit) {
		case "submitting":
			return "Submitting your answers…";
		case "checking":
			return "Checking. This only reads; it sends nothing again.";
		case "unknown":
			return "Pilot sent your answers but heard nothing back. It will not send them again until it checks.";
		case "submitted":
			return "Submitted. These answers are fixed.";
		default:
			return "";
	}
}

/** The answer to `question` in words, for the answers page. */
function answerWords(interview: Interview, question: Question): string {
	if (question.state === "changed" && !unsaved(interview, question)) return "Changed. Answer it again.";
	const choice = shownChoice(interview, question);
	const meaning = question.choices.find((c) => c.id === choice)?.meaning ?? "";
	const text = answerText(interview, question).trim();
	if (!meaning && !text) return "Not answered";
	return [meaning, text].filter(Boolean).join(". ");
}

/** Every answer, by section, and the one Submit. */
function Answers(props: { plans: Plans; page: PlanPage; interview: Interview }) {
	const iv = () => props.interview;
	const left = () => iv().questions.length - iv().answered;
	const busy = () => submitting()[iv().id] === true;
	const review = () => iv().kind === "review";
	const ready = () => iv().current && iv().submit === "open" && !iv().unconfirmed && left() === 0 && !busy();
	const groups = computed(() =>
		SECTIONS.map((section) => ({ section, questions: iv().questions.filter((q) => q.section === section) })).filter(
			(g) => g.questions.length > 0,
		),
	);
	const unanswered = () => iv().questions.find((q) => q.state !== "answered");
	return (
		<View testID="answers" class="gap-4">
			<Text role="header" class="text-xl font-semibold leading-snug text-foreground">
				{iv().submit === "open" ? "Check your answers" : "Your answers"}
			</Text>
			<Each of={groups()} key={(g) => g.section}>
				{(g) => (
					<View class="gap-0.5">
						<Text class="pb-1 text-xs font-semibold text-muted-foreground">
							{`${SECTION_WORDS[g().section]} · ${g().questions.filter((q) => q.state === "answered").length} of ${g().questions.length}`}
						</Text>
						<Each of={g().questions} key={(q) => q.id}>
							{(q) => (
								<Button
									testID={`review-${q().id}`}
									disabled={fixed(iv())}
									onPress={() => go(props.plans, iv(), q().id)}
									class="flex-row gap-3 rounded-lg px-2 py-2 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40"
								>
									<View class="pt-1.5">
										<Mark kind={questionMark(iv(), q())} />
									</View>
									<View class="flex-1 gap-0.5">
										<Text class="text-sm text-muted-foreground">{q().prompt}</Text>
										<Text
											class="text-sm"
											classList={{
												"text-foreground": hasAnswer(iv(), q()),
												"text-needs-ink": !hasAnswer(iv(), q()),
											}}
										>
											{answerWords(iv(), q())}
										</Text>
									</View>
								</Button>
							)}
						</Each>
					</View>
				)}
			</Each>
			<If when={!iv().current}>
				<View class="flex-row items-center gap-2.5 rounded-xl bg-muted px-4 py-3">
					<Mark kind="unknown" />
					<Text class="flex-1 text-sm text-foreground">
						The plan changed since these questions were asked. Your answers are kept, but they cannot be
						submitted. Pilot will ask again.
					</Text>
				</View>
			</If>
			<If when={submitLine(iv())}>
				<Text role="alert" class="text-sm text-muted-foreground">
					{submitLine(iv())}
				</Text>
			</If>
			<If when={planMessages()[props.page.missionId]}>
				<Text role="alert" class="text-sm text-needs-ink">
					{planMessages()[props.page.missionId] ?? ""}
				</Text>
			</If>
			<View class="flex-row flex-wrap items-center gap-3">
				<If
					when={
						iv().submit === "unknown" ||
						iv().submit === "checking" ||
						(iv().unconfirmed && iv().submit === "open")
					}
					else={
						<Action
							primary
							testID="submit"
							label={
								busy() || iv().submit === "submitting"
									? "Submitting…"
									: review()
										? "Send review"
										: "Submit answers"
							}
							disabled={!ready()}
							onPress={() => void submit(props.plans, props.page)}
						/>
					}
				>
					<Action
						primary
						label="Check again"
						disabled={iv().submit === "checking"}
						onPress={() => void checkSubmit(props.plans, props.page)}
					/>
				</If>
				<If when={iv().submit === "open" && unanswered()}>
					<Action
						label="Next unanswered"
						onPress={() => {
							const q = unanswered();
							if (q) go(props.plans, iv(), q.id);
						}}
					/>
				</If>
				<Text class="flex-1 text-xs text-faint">
					{iv().submit !== "open"
						? ""
						: left() > 0
							? `${left() === 1 ? "One question" : `${left()} questions`} left. Pilot continues only after you submit.`
							: "Submitting sends every answer at once. Nothing starts building."}
				</Text>
			</View>
		</View>
	);
}

/**
 * Keys while a question shows: Command-Return moves on (from the text field
 * too), J and K move on and back, 1 to 9 pick a suggestion. Letters and
 * digits type into the field instead while it has the focus.
 */
function bindKeys(plans: Plans, missionId: string, interview: () => Interview) {
	const current = () => {
		const iv = interview();
		return iv.questions.find((q) => q.id === place(iv));
	};
	// Bindings go with the component that made them.
	keymap.bind("mod+enter", () => step(plans, interview(), 1), { when: "always" });
	const keys: Record<string, () => void> = {
		j: () => step(plans, interview(), 1),
		k: () => step(plans, interview(), -1),
	};
	for (let n = 1; n <= 9; n++) {
		keys[String(n)] = () => {
			const iv = interview();
			const q = current();
			const c = q?.choices[n - 1];
			if (q && c && !fixed(iv)) {
				put(atQuestion, iv.id, q.id);
				pickAnswer(plans, missionId, iv, q, c.id);
			}
		};
	}
	keymap.bind(keys);
}

/** The interview of `props.page`: one question at a time, then every answer and Submit. */
export function InterviewDoc(props: { plans: Plans; page: PlanPage; interview: Interview }) {
	const iv = () => props.interview;
	const total = () => iv().questions.length;
	const all = () => seeAll()[iv().id] === true && !fixed(iv());
	const at = () => (all() ? REVIEW : place(iv()));
	const number = () => iv().questions.findIndex((q) => q.id === at()) + 1;
	const current = () => iv().questions.find((q) => q.id === at());
	const review = () => iv().kind === "review";
	bindKeys(props.plans, props.page.missionId, iv);
	const heading = () => {
		if (review()) return "Your review";
		if (iv().kind === "topic") return `Questions about “${iv().topic}”`;
		return iv().round > 1 ? `Questions, round ${iv().round}` : "Questions";
	};
	return (
		<View testID="interview" class="gap-5 rounded-2xl border border-border-strong bg-card px-6 py-5">
			<View class="gap-2">
				<View class="flex-row items-baseline gap-2">
					<Text role="header" class="text-sm font-semibold text-muted-foreground">
						{heading()}
					</Text>
					<View class="flex-1" />
					<Text testID="progress" class="text-xs text-muted-foreground">
						{at() === REVIEW
							? `${iv().answered} of ${total()} answered`
							: `Question ${number()} of ${total()} · ${iv().answered} answered`}
					</Text>
					<If when={total() > 1 && !fixed(iv())}>
						<Toggle
							testID="see-all"
							pressed={all()}
							onChange={() => {
								const now = place(iv());
								const q = iv().questions.find((x) => x.id === now);
								if (q) void saveNow(props.plans, answerKey(iv(), q));
								put(seeAll, iv().id, !all());
							}}
							class="rounded-md px-2 py-0.5 hover:bg-accent aria-pressed:bg-selection focus-visible:ring-2 focus-visible:ring-ring/40"
						>
							<Text class="text-xs text-primary">See all questions</Text>
						</Toggle>
					</If>
				</View>
				<View class="h-1 flex-row overflow-hidden rounded-full bg-track">
					<View class="h-full bg-progress" style={{ flexGrow: iv().answered, flexBasis: 0 }} />
					<View class="h-full" style={{ flexGrow: total() - iv().answered, flexBasis: 0 }} />
				</View>
				<If when={total() > 1 && !all()}>
					<Index plans={props.plans} interview={iv()} />
				</If>
			</View>
			<If when={all()}>
				<View testID="all-questions" class="gap-6">
					<Each of={iv().questions} key={(q) => q.id}>
						{(q) => (
							<View class="gap-2 border-t border-border pt-5">
								<Text class="text-xs text-faint">
									{`Question ${iv().questions.findIndex((x) => x.id === q().id) + 1} of ${total()}`}
								</Text>
								<QuestionView plans={props.plans} page={props.page} interview={iv()} question={q()} compact />
							</View>
						)}
					</Each>
				</View>
			</If>
			<If when={current()} else={<Answers plans={props.plans} page={props.page} interview={iv()} />}>
				<Each of={current() ? [current() as Question] : []} key={(q) => q.id}>
					{(q) => <QuestionView plans={props.plans} page={props.page} interview={iv()} question={q()} />}
				</Each>
				<View class="flex-row flex-wrap items-center gap-2">
					<Action label="‹ Back" disabled={number() <= 1} onPress={() => step(props.plans, iv(), -1)} />
					<Action
						primary
						testID="next"
						shortcut={NEXT_KEY}
						label={
							number() === total()
								? "Check answers"
								: current() && hasAnswer(iv(), current() as Question)
									? "Next"
									: "Skip for now"
						}
						onPress={() => step(props.plans, iv(), 1)}
					/>
					<View class="flex-1" />
					<Text class="text-xs text-faint">
						{review()
							? "Read the whole plan above first."
							: "Recommended suggestions are not answers until you pick them."}
					</Text>
				</View>
			</If>
		</View>
	);
}
