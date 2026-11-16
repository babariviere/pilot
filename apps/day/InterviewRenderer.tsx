// The shared saved-round presentation. Adapters own drafts, authority, help,
// and submission. This renderer owns only layout, navigation and keys.
import { cleanup, computed, effect, type JSX, keymap, signal, Text, View, type ViewRef } from "nsh";
import type { Interview, Question, QuestionSection } from "pilot-day/native";
import { answerKey, atQuestion, focusAsk, focusField, put, seeAll, writing } from "./interviewView";
import { keepField } from "./kept";
import {
	Action,
	Arrive,
	glide,
	KeyCap,
	KeyHint,
	LinkAction,
	type MarkKind,
	MarkLine,
	Notice,
	Panel,
	Pressable,
	TextField,
	ToggleRow,
} from "./ui";

export type InterviewAnswerView = {
	choice: string | null | undefined;
	text: string;
	unsaved: boolean;
	message: string;
};
export type InterviewRead = {
	interview: Interview;
	fresh: boolean;
	keyboardActive: boolean;
	busy: boolean;
	message: string;
	routeKey: string;
	answers: Record<string, InterviewAnswerView>;
	heading: string;
	submitLabel: string;
	submissionHint: string;
	outdatedHint?: string;
	roundHint?: string;
	remainingRoom?: number;
};
export type InterviewCommand =
	| { kind: "choose"; questionId: string; choice: string | null }
	| { kind: "edit"; questionId: string; text: string }
	| { kind: "compose"; questionId: string; active: boolean }
	| { kind: "save"; questionId: string }
	| { kind: "submit" }
	| { kind: "check" }
	| { kind: "help"; questionId: string; help: string };
export interface InterviewSource {
	read(): InterviewRead;
	dispatch(command: InterviewCommand): void;
	helpKeys?: Record<string, string>;
	questionHelp?: (question: Question, key: string) => JSX.Element;
	roundNotes?: () => JSX.Element;
}

function answerView(source: InterviewSource, question: Question): InterviewAnswerView {
	return source.read().answers[question.id] ?? { choice: undefined, text: "", unsaved: false, message: "" };
}
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
function hasAnswer(source: InterviewSource, question: Question): boolean {
	if (question.state === "changed" && !answerView(source, question).unsaved) return false;
	const choice = answerView(source, question).choice;
	if (typeof choice === "string") return true;
	return answerView(source, question).text.trim() !== "";
}

/** The question or page the interview shows: the user's place, else the first without an answer. */
export function place(interview: Interview): string {
	if (fixed(interview)) return REVIEW;
	const at = atQuestion()[interview.id];
	if (at === REVIEW || interview.questions.some((q) => q.id === at)) return at;
	return interview.questions.find((q) => q.state !== "answered")?.id ?? REVIEW;
}

/** Saves what the current question has, then shows `to`. */
function go(source: InterviewSource, to: string) {
	const interview = source.read().interview;
	const now = place(interview);
	const current = interview.questions.find((q) => q.id === now);
	if (current) source.dispatch({ kind: "save", questionId: current.id });
	glide();
	put(atQuestion, interview.id, to);
	const next = interview.questions.find((q) => q.id === to);
	focusAsk.set(next ? answerKey(interview, next) : null);
}

/** Moves `step` questions on or back; past the last is the answers page. */
function step(source: InterviewSource, step: number) {
	const interview = source.read().interview;
	const ids = interview.questions.map((q) => q.id);
	const now = place(interview);
	const at = now === REVIEW ? ids.length : ids.indexOf(now);
	const to = at + step;
	if (to < 0) return;
	go(source, to >= ids.length ? REVIEW : ids[to]);
}

function questionMark(source: InterviewSource, question: Question): MarkKind {
	if (question.state === "changed" && !answerView(source, question).unsaved) return "unknown";
	return hasAnswer(source, question) ? "ready" : "unreported";
}

/** One line about a question's save, or nothing. */
function saveLine(source: InterviewSource, question: Question): string {
	const interview = source.read().interview;
	if (question.saving === "sending") return "Saving…";
	if (answerView(source, question).unsaved) return "Not saved yet";
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
	source: InterviewSource;
	question: Question;
	/** The question's section and how much of it is answered, such as "Limits · 1 of 2". */
	section: string;
	/** Shown in the list of all questions: a smaller title, the text field always open. */
	compact?: boolean;
}) {
	const q = () => props.question;
	const iv = () => props.source.read().interview;
	const key = answerKey(iv(), props.question);
	const choice = computed(() => answerView(props.source, q()).choice);
	const text = computed(() => answerView(props.source, q()).text);
	const locked = () => fixed(iv()) || !props.source.read().fresh;
	const picked = () => typeof choice() === "string";
	// The text field opens on 0, for own words or detail, and stays open while it holds text.
	const open = () => props.compact === true || writing()[key] === true || text().trim() !== "";
	// Answering keeps this question in front: the place no longer depends on what is unanswered.
	const stay = () => put(atQuestion, iv().id, q().id);
	// Pressing the chosen suggestion again clears it.
	const pick = (id: string) => {
		stay();
		props.source.dispatch({ kind: "choose", questionId: q().id, choice: choice() === id ? "" : id });
	};
	const write = () => {
		stay();
		put(writing, key, true);
		focusField.set(key);
	};
	const toggles: ViewRef[] = [];
	const field = signal<ViewRef | null>(null);
	// The field keeps its focus and selection for an update's saved view.
	const kept = keepField(
		`answer:${key}`,
		() => props.source.read().routeKey,
		text,
		(node) => field.set(node),
	);
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
			<If when={!locked()}>{props.source.questionHelp?.(q(), key)}</If>
			<If when={q().state === "changed"}>
				<Panel size="sm" class="gap-0.5">
					<Text class="text-sm text-needs-ink">This question changed after you answered. Answer it again.</Text>
					<Text class="text-xs text-muted-foreground">{`Your earlier answer: ${q().earlier}`}</Text>
				</Panel>
			</If>
			<View class="gap-0.5" accessibilityLabel="Suggested answers">
				<Each of={q().choices} key={(c) => c.id}>
					{(c) => (
						<ToggleRow
							anchor={(node) => {
								toggles[q().choices.findIndex((x) => x.id === c().id)] = node;
							}}
							testID={`choice-${q().id}-${c().id}`}
							pressed={choice() === c().id}
							disabled={locked()}
							accessibilityLabel={c().recommended ? `${c().meaning}, recommended` : c().meaning}
							onChange={() => pick(c().id)}
							size="lg"
							indicator={<KeyCap label={keyOf(q(), c().id)} on={choice() === c().id} />}
						>
							{/* min-w-0 lets a long answer wrap inside the card instead of running past it. */}
							<View class="min-w-0 flex-1 gap-0.5">
								<Text class="text-base text-foreground">{c().meaning}</Text>
								<If when={c().recommended}>
									<Text class="text-xs text-muted-foreground">Recommended</Text>
								</If>
							</View>
							<If when={!props.compact && choice() === c().id && !locked()}>
								<KeyHint keys="↩" label="next" />
							</If>
						</ToggleRow>
					)}
				</Each>
				<If
					when={open()}
					else={
						<Pressable
							testID={`own-${q().id}`}
							accessibilityLabel={picked() ? "Add detail to your choice" : "Answer in your own words"}
							disabled={locked()}
							onPress={write}
							class="flex-row items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-accent disabled:opacity-70"
						>
							<KeyCap label="0" />
							<Text class="text-base text-muted-foreground">
								{picked() ? "Add detail" : "Something else: write your own"}
							</Text>
						</Pressable>
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
							<TextField
								ref={kept.ref}
								testID={`answer-${q().id}`}
								accessibilityLabel={`Your answer to: ${q().prompt}`}
								multiline
								readonly={locked()}
								value={text()}
								placeholder={picked() ? "Optional" : "Say it your way"}
								onChange={({ value }) => {
									stay();
									props.source.dispatch({ kind: "edit", questionId: q().id, text: value });
								}}
								onCompositionChange={({ composing }) =>
									props.source.dispatch({ kind: "compose", questionId: q().id, active: composing })
								}
								onSelectionChange={kept.select}
								onFocus={() => {
									kept.focus();
									stopEscape?.();
									stopEscape = keymap.bind("escape", leaveField, { when: "always" });
								}}
								onBlur={() => {
									stopEscape?.();
									stopEscape = null;
									props.source.dispatch({ kind: "save", questionId: q().id });
								}}
								rows={2}
							/>
							<If when={answerView(props.source, q()).message}>
								<Text role="alert" class="text-xs text-needs-ink">
									{answerView(props.source, q()).message ?? ""}
								</Text>
							</If>
							<If when={(props.source.read().remainingRoom ?? Infinity) < 2048}>
								<Text class="text-xs text-needs-ink">
									{`Room left for all answers: about ${props.source.read().remainingRoom} characters.`}
								</Text>
							</If>
						</View>
					</View>
				</If>
				<If when={!open() && answerView(props.source, q()).message}>
					<Text role="alert" class="px-3 text-xs text-needs-ink">
						{answerView(props.source, q()).message ?? ""}
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
function answerWords(source: InterviewSource, question: Question): string {
	if (question.state === "changed" && !answerView(source, question).unsaved) return "Changed. Answer it again.";
	const choice = answerView(source, question).choice;
	const meaning = question.choices.find((c) => c.id === choice)?.meaning ?? "";
	const text = answerView(source, question).text.trim();
	if (!meaning && !text) return "Not answered";
	return [meaning, text].filter(Boolean).join(". ");
}

/** Every answer, by section, and the one Submit. */
function Answers(props: { source: InterviewSource; anchor?: (node: ViewRef) => void }) {
	const iv = () => props.source.read().interview;
	const left = () => iv().questions.length - iv().answered;
	const busy = () => props.source.read().busy;
	const ready = () => props.source.read().fresh && iv().current && !fixed(iv()) && left() === 0 && !busy();
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
								<Pressable
									testID={`review-${q().id}`}
									disabled={fixed(iv())}
									onPress={() => go(props.source, q().id)}
									class="rounded-lg px-2 py-2 hover:bg-accent"
								>
									<MarkLine kind={questionMark(props.source, q())}>
										<Text class="text-sm text-muted-foreground">{q().prompt}</Text>
										<Text
											class="text-sm"
											classList={{
												"text-foreground": hasAnswer(props.source, q()),
												"text-needs-ink": !hasAnswer(props.source, q()),
											}}
										>
											{answerWords(props.source, q())}
										</Text>
									</MarkLine>
								</Pressable>
							)}
						</Each>
					</View>
				)}
			</Each>
			<If when={!iv().current}>
				<Notice
					text={
						props.source.read().outdatedHint ??
						"These questions changed. Read the current round before submitting."
					}
				/>
			</If>
			<If when={submitLine(iv())}>
				<Text role="alert" class="text-sm text-muted-foreground">
					{submitLine(iv())}
				</Text>
			</If>
			<If when={props.source.read().message}>
				<Text role="alert" class="text-sm text-needs-ink">
					{props.source.read().message ?? ""}
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
						<If when={iv().submit !== "submitted"}>
							<Action
								variant="primary"
								testID="submit"
								label={busy() || iv().submit === "submitting" ? "Submitting…" : props.source.read().submitLabel}
								disabled={!ready()}
								anchor={(node) => props.anchor?.(node)}
								onPress={() => props.source.dispatch({ kind: "submit" })}
							/>
						</If>
					}
				>
					<Action
						variant="primary"
						label="Check again"
						disabled={iv().submit === "checking"}
						anchor={(node) => props.anchor?.(node)}
						onPress={() => props.source.dispatch({ kind: "check" })}
					/>
				</If>
				<If when={iv().submit === "open" && unanswered()}>
					<Action
						label="Next unanswered"
						onPress={() => {
							const q = unanswered();
							if (q) go(props.source, q.id);
						}}
					/>
				</If>
				<Text class="flex-1 text-xs text-faint">
					{iv().submit !== "open"
						? ""
						: left() > 0
							? `${left() === 1 ? "One question" : `${left()} questions`} left. Pilot continues only after you submit.`
							: props.source.read().submissionHint}
				</Text>
			</View>
		</View>
	);
}

/**
 * Keys while one question shows: 1 to 9 pick a suggestion (again: clear it),
 * 0 opens the text field for own words or detail, Return or J
 * moves on and K moves back. Command-Return moves on from the text field
 * too. M, S, A and R toggle the question's help: more context, say it simpler,
 * ask a question, reword this. Letters and digits type into the field while it has the focus.
 * See all turns these keys off.
 */
function bindKeys(source: InterviewSource) {
	const interview = () => source.read().interview;
	const current = () => {
		const iv = interview();
		if (seeAll()[iv.id] === true) return undefined;
		return iv.questions.find((q) => q.id === place(iv));
	};
	const next = () => {
		if (seeAll()[interview().id] !== true) step(source, 1);
	};

	const keys: Record<string, () => void> = {
		enter: next,
		j: next,
		k: () => {
			if (seeAll()[interview().id] !== true) step(source, -1);
		},
		"0": () => {
			const q = current();
			if (!q || fixed(interview()) || !source.read().fresh) return;
			put(atQuestion, interview().id, q.id);
			put(writing, answerKey(interview(), q), true);
			focusField.set(answerKey(interview(), q));
		},
	};
	for (const [help, key] of Object.entries(source.questionHelp ? (source.helpKeys ?? {}) : {}))
		keys[key] = () => {
			const q = current();
			if (!q || fixed(interview())) return;
			source.dispatch({ kind: "help", questionId: q.id, help });
		};
	for (let n = 1; n <= 9; n++)
		keys[String(n)] = () => {
			const q = current();
			const c = q?.choices[n - 1];
			if (!q || !c || fixed(interview()) || !source.read().fresh) return;
			put(atQuestion, interview().id, q.id);
			source.dispatch({
				kind: "choose",
				questionId: q.id,
				choice: answerView(source, q).choice === c.id ? "" : c.id,
			});
		};
	const active = computed(() => source.read().keyboardActive);
	effect(() => {
		if (!active()) return;
		const stopNext = keymap.bind("mod+enter", next, { when: "always" });
		const stopKeys = keymap.bind(keys);
		return () => {
			stopNext();
			stopKeys();
		};
	});
}

/** One question at a time, then every answer and the one Submit. */
export function InterviewRenderer(props: { source: InterviewSource; anchor?: (node: ViewRef) => void }) {
	const iv = () => props.source.read().interview;
	const total = () => iv().questions.length;
	const all = () => seeAll()[iv().id] === true && !fixed(iv());
	const at = () => (all() ? REVIEW : place(iv()));
	const number = () => iv().questions.findIndex((q) => q.id === at()) + 1;
	const current = () => iv().questions.find((q) => q.id === at());
	bindKeys(props.source);
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
						{props.source.read().heading}
					</Text>
					<View class="flex-1" />
					<Text testID="progress" class="text-xs text-muted-foreground">
						{at() === REVIEW
							? `${iv().answered} of ${total()} answered`
							: `Question ${number()} of ${total()} · ${iv().answered} answered`}
					</Text>
					<If when={total() > 1 && !fixed(iv()) && !all() && at() !== REVIEW}>
						<LinkAction
							label="All answers"
							testID="goto-review"
							accessibilityLabel="All answers and Submit"
							onPress={() => go(props.source, REVIEW)}
						/>
					</If>
					<If when={total() > 1 && !fixed(iv())}>
						<LinkAction
							label="See all questions"
							testID="see-all"
							pressed={all()}
							onPress={() => {
								const now = place(iv());
								const q = iv().questions.find((x) => x.id === now);
								if (q) props.source.dispatch({ kind: "save", questionId: q.id });
								put(seeAll, iv().id, !all());
							}}
						/>
					</If>
				</View>
				<View class="h-1 flex-row overflow-hidden rounded-full bg-track">
					<View class="h-full bg-progress" style={{ flexGrow: iv().answered, flexBasis: 0 }} />
					<View class="h-full" style={{ flexGrow: total() - iv().answered, flexBasis: 0 }} />
				</View>
				<If when={!iv().accepting && iv().submit === "open"}>
					<Text class="text-xs text-needs-ink">
						Pilot is not ready to take answers yet. You can read the questions; answering opens soon.
					</Text>
				</If>
				<If when={props.source.read().roundHint}>
					<Text class="text-xs text-faint">{props.source.read().roundHint}</Text>
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
								<QuestionView source={props.source} question={q()} section={sectionLine(q())} compact />
							</View>
						)}
					</Each>
				</View>
			</If>
			<If
				when={current()}
				else={
					<Arrive>
						<Answers source={props.source} anchor={(node) => props.anchor?.(node)} />
					</Arrive>
				}
			>
				<Each of={current() ? [current() as Question] : []} key={(q) => q.id}>
					{(q) => (
						<Arrive>
							<QuestionView source={props.source} question={q()} section={sectionLine(q())} />
						</Arrive>
					)}
				</Each>
				<View class="flex-row flex-wrap items-center gap-2 border-t border-border pt-4">
					<Action label="‹ Back" disabled={number() <= 1} onPress={() => step(props.source, -1)} />
					<Action
						variant="primary"
						testID="next"
						anchor={(node) => props.anchor?.(node)}
						shortcut={NEXT_KEY}
						label={
							number() === total()
								? "Check answers"
								: current() && hasAnswer(props.source, current() as Question)
									? "Next"
									: "Skip for now"
						}
						onPress={() => step(props.source, 1)}
					/>
					<Text class="pl-1 text-xs text-faint">
						{current() ? saveLine(props.source, current() as Question) : ""}
					</Text>
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
			{props.source.roundNotes?.()}
		</View>
	);
}
