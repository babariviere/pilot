// A saved interview. Pilot writes the whole question list first; the
// screen shows one question at a time. The user moves to any question with
// Back, Next or the numbers above it, skips and comes back, and ends on a
// page with every answer and the one Submit. Each question has suggested
// answers (one may be marked Recommended), "Something else", and a text
// field for the user's own answer or added detail. Answers save as drafts;
// a recommendation is never an answer.
import { cleanup, computed, effect, keymap, signal, Text, View, type ViewRef } from "nsh";
import { Button, Input, Toggle } from "nsh/base";
import type { Interview, PlanPage, Question, QuestionSection } from "pilot-day/native";
import { Arrive, glide } from "./motion";
import {
	answerText,
	CLEARED,
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
import {
	answerKey,
	answerMessages,
	atQuestion,
	focusAsk,
	focusField,
	planMessages,
	put,
	seeAll,
	submitting,
	writing,
} from "./planView";
import { Action, KeyCap, KeyHint, Mark, type MarkKind } from "./ui";

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
	return interview.submit !== "open" || interview.unconfirmed || !interview.accepting;
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
	glide();
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

/** The key that picks choice `id` of `question`: 1 to 9, in order. */
function keyOf(question: Question, id: string): string {
	const n = question.choices.findIndex((c) => c.id === id) + 1;
	return n >= 1 && n <= 9 ? String(n) : "";
}

/** The keys that pick a suggestion of `question`, such as "1–3". */
function pickKeys(question: Question | undefined): string {
	const n = Math.min(9, question?.choices.length ?? 0);
	return n <= 1 ? "1" : `1–${n}`;
}

/** One question: its words, numbered suggestions and the user's own words. */
function QuestionView(props: {
	plans: Plans;
	page: PlanPage;
	interview: Interview;
	question: Question;
	/** The question's section and how much of it is answered, such as "Limits · 1 of 2". */
	section: string;
	/** Shown in the list of all questions: a smaller title, the text field always open. */
	compact?: boolean;
}) {
	const q = () => props.question;
	const iv = () => props.interview;
	const key = answerKey(props.interview, props.question);
	const choice = computed(() => shownChoice(iv(), q()));
	const text = computed(() => answerText(iv(), q()));
	const locked = () => fixed(iv());
	const picked = () => typeof choice() === "string";
	// The text field opens on 0, for own words or detail, and stays open while it holds text.
	const open = () => props.compact === true || writing()[key] === true || text().trim() !== "";
	// Answering keeps this question in front: the place no longer depends on what is unanswered.
	const stay = () => put(atQuestion, iv().id, q().id);
	// Pressing the chosen suggestion again clears it.
	const pick = (id: string) => {
		stay();
		pickAnswer(props.plans, props.page.missionId, iv(), q(), choice() === id ? CLEARED : id);
	};
	const write = () => {
		stay();
		put(writing, key, true);
		focusField.set(key);
	};
	const toggles: ViewRef[] = [];
	const field = signal<ViewRef | null>(null);
	let stopEscape: (() => void) | null = null;
	cleanup(() => stopEscape?.());
	effect(() => {
		const node = field();
		if (focusField() === key && node) {
			node.focus();
			focusField.set(null);
		}
	});
	// Escape leaves the field, keeps the text and returns to the suggestions.
	const leaveField = () => {
		field()?.blur();
		const at = q().choices.findIndex((c) => c.id === choice());
		toggles[Math.max(at, 0)]?.focus();
	};
	effect(() => {
		if (focusAsk() !== key) return;
		const at = q().choices.findIndex((c) => c.id === choice());
		const target = toggles[Math.max(at, 0)];
		if (target) {
			target.focus();
			focusAsk.set(null);
		}
	});
	return (
		<View testID={`question-${q().id}`} class="gap-3">
			<Text class="text-xs text-faint">{q().new ? `${props.section} · New this round` : props.section}</Text>
			<Text
				role="header"
				class={
					props.compact
						? "text-base font-semibold leading-snug text-foreground"
						: "text-xl font-semibold leading-snug text-card-foreground"
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
			<View class="gap-0.5" accessibilityLabel="Suggested answers">
				<Each of={q().choices} key={(c) => c.id}>
					{(c) => (
						<Toggle
							ref={(node) => {
								toggles[q().choices.findIndex((x) => x.id === c().id)] = node;
							}}
							testID={`choice-${q().id}-${c().id}`}
							pressed={choice() === c().id}
							disabled={locked()}
							accessibilityLabel={c().recommended ? `${c().meaning}, recommended` : c().meaning}
							onChange={() => pick(c().id)}
							class="group flex-row items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-accent aria-pressed:bg-selection aria-pressed:hover:bg-selection disabled:opacity-70 focus-visible:ring-2 focus-visible:ring-ring/40"
						>
							<KeyCap label={keyOf(q(), c().id)} on={choice() === c().id} />
							<View class="flex-1 flex-row flex-wrap items-baseline gap-2">
								<Text class="text-base text-foreground">{c().meaning}</Text>
								<If when={c().recommended}>
									<Text class="text-xs text-muted-foreground">Recommended</Text>
								</If>
							</View>
							<If when={!props.compact && choice() === c().id && !locked()}>
								<KeyHint keys="↩" label="next" />
							</If>
						</Toggle>
					)}
				</Each>
				<If
					when={open()}
					else={
						<Button
							testID={`own-${q().id}`}
							accessibilityLabel={picked() ? "Add detail to your choice" : "Answer in your own words"}
							disabled={locked()}
							onPress={write}
							class="flex-row items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-accent disabled:opacity-70 focus-visible:ring-2 focus-visible:ring-ring/40"
						>
							<KeyCap label="0" />
							<Text class="text-base text-muted-foreground">
								{picked() ? "Add detail" : "Something else: write your own"}
							</Text>
						</Button>
					}
				>
					<View class="gap-1.5 px-3 pt-1.5">
						<View class="flex-row items-center gap-3">
							<KeyCap label="0" on={choice() === null} />
							<Text class="text-sm text-muted-foreground">
								{picked() ? "Detail for your choice" : "Your own words"}
							</Text>
						</View>
						<View class="gap-1 pl-8">
							<Input
								ref={(node) => field.set(node)}
								testID={`answer-${q().id}`}
								accessibilityLabel={`Your answer to: ${q().prompt}`}
								multiline
								readonly={locked()}
								value={text()}
								placeholder={picked() ? "Optional" : "Say it your way"}
								onChange={({ value }) => {
									stay();
									editAnswer(props.plans, props.page.missionId, iv(), q(), value);
								}}
								onCompositionChange={({ composing }) => composeAnswer(props.plans, iv(), q(), composing)}
								onFocus={() => {
									stopEscape?.();
									stopEscape = keymap.bind("escape", leaveField, { when: "always" });
								}}
								onBlur={() => {
									stopEscape?.();
									stopEscape = null;
									void saveNow(props.plans, key);
								}}
								class="min-h-16 rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-primary"
							/>
							<If when={answerMessages()[key]}>
								<Text role="alert" class="text-xs text-needs-ink">
									{answerMessages()[key] ?? ""}
								</Text>
							</If>
							<If when={iv().room < 2048}>
								<Text class="text-xs text-needs-ink">
									{`Room left for all answers: about ${iv().room} characters.`}
								</Text>
							</If>
						</View>
					</View>
				</If>
				<If when={!open() && answerMessages()[key]}>
					<Text role="alert" class="px-3 text-xs text-needs-ink">
						{answerMessages()[key] ?? ""}
					</Text>
				</If>
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
 * Keys while one question shows: 1 to 9 pick a suggestion (again: clear it),
 * 0 opens the text field for own words or detail, Return or J
 * moves on and K moves back. Command-Return moves on from the text field
 * too. Letters and digits type into the field while it has the focus.
 * See all turns these keys off.
 */
function bindKeys(plans: Plans, missionId: string, interview: () => Interview) {
	const current = () => {
		const iv = interview();
		if (seeAll()[iv.id] === true) return undefined;
		return iv.questions.find((q) => q.id === place(iv));
	};
	const next = () => {
		if (seeAll()[interview().id] !== true) step(plans, interview(), 1);
	};
	const answer = (q: Question, choice: string | null) => {
		const iv = interview();
		if (fixed(iv)) return;
		put(atQuestion, iv.id, q.id);
		pickAnswer(plans, missionId, iv, q, choice);
	};
	// Bindings go with the component that made them.
	keymap.bind("mod+enter", next, { when: "always" });
	const keys: Record<string, () => void> = {
		enter: next,
		j: next,
		k: () => {
			if (seeAll()[interview().id] !== true) step(plans, interview(), -1);
		},
		"0": () => {
			const q = current();
			if (!q || fixed(interview())) return;
			put(atQuestion, interview().id, q.id);
			put(writing, answerKey(interview(), q), true);
			focusField.set(answerKey(interview(), q));
		},
	};
	for (let n = 1; n <= 9; n++) {
		keys[String(n)] = () => {
			const q = current();
			const c = q?.choices[n - 1];
			if (q && c) answer(q, shownChoice(interview(), q) === c.id ? CLEARED : c.id);
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
	const sectionLine = (q: Question) => {
		const all = iv().questions.filter((x) => x.section === q.section);
		const done = all.filter((x) => x.state === "answered").length;
		return `${SECTION_WORDS[q.section]} · ${done} of ${all.length}`;
	};
	return (
		<View testID="interview" class="gap-5 rounded-2xl border border-border-strong bg-card px-6 py-6">
			<View class="gap-2">
				<View class="flex-row flex-wrap items-baseline gap-x-3 gap-y-1">
					<Text role="header" class="text-sm font-semibold text-muted-foreground">
						{heading()}
					</Text>
					<View class="flex-1" />
					<Text testID="progress" class="text-xs text-muted-foreground">
						{at() === REVIEW
							? `${iv().answered} of ${total()} answered`
							: `Question ${number()} of ${total()} · ${iv().answered} answered`}
					</Text>
					<If when={total() > 1 && !fixed(iv()) && !all() && at() !== REVIEW}>
						<Button
							testID="goto-review"
							accessibilityLabel="All answers and Submit"
							onPress={() => go(props.plans, iv(), REVIEW)}
							class="rounded-md px-1.5 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40"
						>
							<Text class="text-xs text-primary">All answers</Text>
						</Button>
					</If>
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
							class="rounded-md px-1.5 hover:bg-accent aria-pressed:bg-selection focus-visible:ring-2 focus-visible:ring-ring/40"
						>
							<Text class="text-xs text-primary">See all questions</Text>
						</Toggle>
					</If>
				</View>
				<View class="h-1 flex-row overflow-hidden rounded-full bg-track">
					<View class="h-full bg-progress" style={{ flexGrow: iv().answered, flexBasis: 0 }} />
					<View class="h-full" style={{ flexGrow: total() - iv().answered, flexBasis: 0 }} />
				</View>
				<If when={!iv().accepting}>
					<Text class="text-xs text-needs-ink">
						Pilot is not ready to take answers yet. You can read the questions; answering opens soon.
					</Text>
				</If>
				<If when={iv().round > 1 && iv().kind === "mission"}>
					<Text class="text-xs text-faint">
						New questions only. Earlier answers stay as they were, under Earlier interview rounds.
					</Text>
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
								<QuestionView
									plans={props.plans}
									page={props.page}
									interview={iv()}
									question={q()}
									section={sectionLine(q())}
									compact
								/>
							</View>
						)}
					</Each>
				</View>
			</If>
			<If
				when={current()}
				else={
					<Arrive>
						<Answers plans={props.plans} page={props.page} interview={iv()} />
					</Arrive>
				}
			>
				<Each of={current() ? [current() as Question] : []} key={(q) => q.id}>
					{(q) => (
						<Arrive>
							<QuestionView
								plans={props.plans}
								page={props.page}
								interview={iv()}
								question={q()}
								section={sectionLine(q())}
							/>
						</Arrive>
					)}
				</Each>
				<View class="flex-row flex-wrap items-center gap-2 border-t border-border pt-4">
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
					<Text class="pl-1 text-xs text-faint">{current() ? saveLine(iv(), current() as Question) : ""}</Text>
					<View class="flex-1" />
					<If when={current()}>
						<View class="flex-row flex-wrap items-center gap-3.5">
							<KeyHint keys={pickKeys(current())} label="pick" />
							<KeyHint keys="0" label="write" />
							<KeyHint keys="↩" label="next" />
							<KeyHint keys="←" label="back" />
						</View>
					</If>
				</View>
			</If>
		</View>
	);
}
