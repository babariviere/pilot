// The shared saved-round presentation. Adapters own drafts, authority, help,
// and submission. This renderer owns only layout, navigation and keys.
import { cleanup, computed, effect, type JSX, keymap, signal, View, type ViewRef } from "nsh";
import type { Interview, Question, QuestionSection } from "pilot-day/native";
import { answerKey, atQuestion, focusAsk, focusField, put, seeAll, writing } from "./interviewView";
import { keepField } from "./kept";
import {
	Arrive,
	Body,
	BodyStrong,
	Button,
	Caption,
	glide,
	KeyHints,
	Link,
	type MarkKind,
	Notice,
	Num,
	Option,
	Options,
	Question as QuestionPart,
	Row,
	RowGroup,
	Rows,
	Spacer,
	TextField,
} from "./ui";

export type InterviewAnswerView = {
	deferred?: boolean;
	choice: string | null | undefined;
	/** Optional multi-select adapter. Mission interviews remain single-choice. */
	choices?: string[];
	text: string;
	unsaved: boolean;
	message: string;
	/** Words written for an earlier wording of the question. Pilot did not send them. */
	kept?: string;
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
	| { kind: "focus"; questionId: string }
	| { kind: "submit" }
	| { kind: "check" }
	| { kind: "help"; questionId: string; help: string };
export interface InterviewSource {
	/** Optional mission-only deferral; never a saved answer or submission. */
	defer?: (question: Question) => void;
	read(): InterviewRead;
	dispatch(command: InterviewCommand): void;
	helpKeys?: Record<string, string>;
	questionHelp?: (question: Question, key: string) => JSX.Element;
	choiceDetail?: (question: Question, choiceId: string) => string;
	roundNotes?: () => JSX.Element;
	/** More secondary buttons for the Question's foot, after its own, such as Later. */
	foot?: () => JSX.Element;
}

function answerView(source: InterviewSource, question: Question): InterviewAnswerView {
	return source.read().answers[question.id] ?? { choice: undefined, text: "", unsaved: false, message: "" };
}

function selected(source: InterviewSource, question: Question, id: string): boolean {
	const answer = answerView(source, question);
	return answer.choices ? answer.choices.includes(id) : answer.choice === id;
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
	if (answerView(source, question).choices?.length) return true;
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

/** One line about a question's save, or nothing. */
function saveLine(source: InterviewSource, question: Question): string {
	const interview = source.read().interview;
	if (question.saving === "sending") return "Saving…";
	if (answerView(source, question).unsaved) return "Not saved yet";
	if (question.state === "answered" && !fixed(interview)) return "Saved";
	return "";
}

/** The keys that pick a suggestion of `question`, such as "1–3". */
function pickKeys(question: Question | undefined): string {
	const n = Math.min(9, question?.choices.length ?? 0);
	return n <= 1 ? "1" : `1–${n}`;
}

/** One question: its help, suggestions and the user's own words. The Question around it shows its words. */
function QuestionView(props: {
	source: InterviewSource;
	question: Question;
	/** The question's section and how much of it is answered, such as "Limits · 1 of 2". */
	section: string;
	/** Shown in the list of all questions: its words and section here, the text field always open. */
	compact?: boolean;
}) {
	const q = () => props.question;
	const iv = () => props.source.read().interview;
	const key = answerKey(iv(), props.question);
	const choice = computed(() => answerView(props.source, q()).choice);
	const text = computed(() => answerView(props.source, q()).text);
	const locked = () => fixed(iv()) || !props.source.read().fresh;
	const picked = () => typeof choice() === "string" || !!answerView(props.source, q()).choices?.length;
	const several = () => !!answerView(props.source, q()).choices;
	// The text field opens on 0, for own words or detail, and stays open while it holds text.
	const open = () => props.compact === true || writing()[key] === true || text().trim() !== "";
	// Answering keeps this question in front: the place no longer depends on what is unanswered.
	const stay = () => put(atQuestion, iv().id, q().id);
	// Pressing the chosen suggestion again clears it.
	const pick = (id: string) => {
		stay();
		props.source.dispatch({
			kind: "choose",
			questionId: q().id,
			choice: answerView(props.source, q()).choices ? id : choice() === id ? "" : id,
		});
	};
	const write = () => {
		stay();
		props.source.dispatch({ kind: "focus", questionId: q().id });
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
	const label = (c: Question["choices"][number]) =>
		[c.meaning, props.source.choiceDetail?.(q(), c.id), c.recommended ? "recommended" : ""]
			.filter(Boolean)
			.join(". ");
	const anchor = (id: string) => (node: ViewRef) => {
		toggles[q().choices.findIndex((x) => x.id === id)] = node;
	};
	return (
		<View testID={`question-${q().id}`} class="gap-3">
			<If when={props.compact}>
				<View class="gap-0.5">
					<Caption tone="faint">{q().new ? `${props.section} · New this round` : props.section}</Caption>
					<BodyStrong role="header">{q().prompt}</BodyStrong>
				</View>
			</If>
			<If when={!locked()}>{props.source.questionHelp?.(q(), key)}</If>
			<If when={answerView(props.source, q()).deferred}>
				<Body tone="muted">Decide later. Your draft stays; choose or edit an answer when ready.</Body>
			</If>
			<If when={q().state === "changed"}>
				<Notice
					text="This question changed after you answered. Answer it again."
					detail={`Your earlier answer: ${q().earlier}`}
				/>
			</If>
			<If when={!locked() && answerView(props.source, q()).kept}>
				<Notice
					text="This question changed before your words were saved. Pilot did not send them."
					detail={`Your words: ${answerView(props.source, q()).kept ?? ""}`}
					action={
						<Link
							label="Use these words"
							onPress={() =>
								props.source.dispatch({
									kind: "edit",
									questionId: q().id,
									text: answerView(props.source, q()).kept ?? "",
								})
							}
						/>
					}
				/>
			</If>
			{/* A plain list, not a radio group: each suggestion is its own Tab stop and clears when pressed again. */}
			<Options multiple testID={`choices-${q().id}`}>
				<Each of={q().choices} key={(c) => c.id}>
					{(c) => (
						<If
							when={several()}
							else={
								<Option
									clearable
									anchor={anchor(c().id)}
									testID={`choice-${q().id}-${c().id}`}
									title={c().meaning}
									tag={c().recommended ? "Recommended" : undefined}
									hint={props.source.choiceDetail?.(q(), c().id) || undefined}
									checked={selected(props.source, q(), c().id)}
									disabled={locked()}
									accessibilityLabel={label(c())}
									onChange={() => pick(c().id)}
								/>
							}
						>
							<Option
								multiple
								anchor={anchor(c().id)}
								testID={`choice-${q().id}-${c().id}`}
								title={c().meaning}
								tag={c().recommended ? "Recommended" : undefined}
								hint={props.source.choiceDetail?.(q(), c().id) || undefined}
								checked={selected(props.source, q(), c().id)}
								disabled={locked()}
								accessibilityLabel={label(c())}
								onChange={() => pick(c().id)}
							/>
						</If>
					)}
				</Each>
				<If when={!open()}>
					<Option
						clearable
						testID={`own-${q().id}`}
						title={picked() ? "Add detail" : "Something else: write your own"}
						accessibilityLabel={picked() ? "Add detail to your choice" : "Answer in your own words"}
						checked={false}
						disabled={locked()}
						onChange={write}
					/>
				</If>
			</Options>
			<If when={open()}>
				<View class="gap-1">
					<Caption>{picked() ? "Detail for your choice" : "Your own words"}</Caption>
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
							props.source.dispatch({ kind: "focus", questionId: q().id });
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
					<If when={(props.source.read().remainingRoom ?? Infinity) < 2048}>
						<Caption tone="needs">
							{`Room left for all answers: about ${props.source.read().remainingRoom} characters.`}
						</Caption>
					</If>
				</View>
			</If>
			<If when={answerView(props.source, q()).message}>
				<Caption role="alert" tone="needs">
					{answerView(props.source, q()).message ?? ""}
				</Caption>
			</If>
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
			return "Checking that your answers arrived…";
		case "unknown":
			return "Pilot could not confirm your answers yet. It will not send them again. Check again only reads.";
		case "submitted":
			return "Submitted. These answers are fixed.";
		default:
			return "";
	}
}

/** The answer to `question` in words, for the answers page. */
function answerWords(source: InterviewSource, question: Question): string {
	if (answerView(source, question).deferred) return "Decide later. Draft kept; decision still open.";
	if (question.state === "changed" && !answerView(source, question).unsaved) return "Changed. Answer it again.";
	const choice = answerView(source, question).choice;
	const answer = answerView(source, question);
	const meaning = answer.choices
		? question.choices
				.filter((c) => answer.choices!.includes(c.id))
				.map((c) => c.meaning)
				.join("; ")
		: (question.choices.find((c) => c.id === choice)?.meaning ?? "");
	const text = answerView(source, question).text.trim();
	if (!meaning && !text) return "Not answered";
	return [meaning, text].filter(Boolean).join(". ");
}

/** The mark of a question on the answers page: done when answered, Needs you when it waits for an answer. */
function questionMark(source: InterviewSource, question: Question): MarkKind {
	return hasAnswer(source, question) ? "done" : "needs";
}

/** Every answer, by section, as rows that open their question, and how the one submission stands. */
function Answers(props: { source: InterviewSource; all: boolean }) {
	const iv = () => props.source.read().interview;
	const groups = computed(() =>
		SECTIONS.map((section) => ({ section, questions: iv().questions.filter((q) => q.section === section) })).filter(
			(g) => g.questions.length > 0,
		),
	);
	return (
		<View testID="answers" class="gap-3">
			{/* Below every question, the answers name themselves; alone, the Question's title does. */}
			<If when={props.all}>
				<BodyStrong role="header">{iv().submit === "open" ? "Check your answers" : "Your answers"}</BodyStrong>
			</If>
			<Rows flush>
				<Each of={groups()} key={(g) => g.section}>
					{(g) => (
						<>
							<RowGroup
								label={`${SECTION_WORDS[g().section]} · ${g().questions.filter((q) => q.state === "answered").length} of ${g().questions.length}`}
							/>
							<Rows>
								<Each of={g().questions} key={(q) => q.id}>
									{(q) => (
										<Row
											testID={`review-${q().id}`}
											mark={questionMark(props.source, q())}
											title={q().prompt}
											meta={answerWords(props.source, q())}
											wrap
											accessibilityLabel={`${q().prompt}. ${answerWords(props.source, q())}. Open the question.`}
											onPress={fixed(iv()) ? undefined : () => go(props.source, q().id)}
										/>
									)}
								</Each>
							</Rows>
						</>
					)}
				</Each>
			</Rows>
			<If when={!iv().current}>
				<Notice
					text={
						props.source.read().outdatedHint ??
						"These questions changed. Read the current round before submitting."
					}
				/>
			</If>
			<If when={submitLine(iv())}>
				<Body role="alert" tone="muted">
					{submitLine(iv())}
				</Body>
			</If>
			<If when={props.source.read().message}>
				<Body role="alert" tone="needs">
					{props.source.read().message ?? ""}
				</Body>
			</If>
		</View>
	);
}

/** The answers page's foot: the one Submit (or Check again), Next unanswered, and what Submit does. */
function AnswersFoot(props: { source: InterviewSource; anchor?: (node: ViewRef) => void }) {
	const iv = () => props.source.read().interview;
	const left = () => iv().questions.length - iv().answered;
	const busy = () => props.source.read().busy;
	const ready = () => props.source.read().fresh && iv().current && !fixed(iv()) && left() === 0 && !busy();
	const unanswered = () => iv().questions.find((q) => q.state !== "answered");
	return (
		<>
			<If
				when={
					iv().submit === "unknown" || iv().submit === "checking" || (iv().unconfirmed && iv().submit === "open")
				}
				else={
					<If when={iv().submit !== "submitted"}>
						<Button
							kind="primary"
							testID="submit"
							label={busy() || iv().submit === "submitting" ? "Submitting…" : props.source.read().submitLabel}
							disabled={!ready()}
							anchor={(node) => props.anchor?.(node)}
							onPress={() => props.source.dispatch({ kind: "submit" })}
						/>
					</If>
				}
			>
				{/* Pilot checks by itself first; the button is the fallback after its tries. */}
				<If when={iv().submit !== "checking"}>
					<Button
						kind="primary"
						label="Check again"
						anchor={(node) => props.anchor?.(node)}
						onPress={() => props.source.dispatch({ kind: "check" })}
					/>
				</If>
			</If>
			<If when={iv().submit === "open" && unanswered()}>
				<Button
					label="Next unanswered"
					onPress={() => {
						const q = unanswered();
						if (q) go(props.source, q.id);
					}}
				/>
			</If>
			<If when={iv().submit === "open"}>
				<Caption tone="faint" grow>
					{left() > 0
						? `${left() === 1 ? "One question" : `${left()} questions`} left. Pilot continues only after you submit.`
						: props.source.read().submissionHint}
				</Caption>
			</If>
		</>
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
				choice: answerView(source, q).choices ? c.id : answerView(source, q).choice === c.id ? "" : c.id,
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

/**
 * One question at a time, then every answer and the one Submit, as one Question: its title is the question shown
 * (or the answers page), its place is how far the round is, and its foot holds the one primary step.
 */
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
	const title = () => {
		const q = current();
		if (q) return q.prompt;
		if (all()) return props.source.read().heading;
		return iv().submit === "open" ? "Check your answers" : "Your answers";
	};
	const hints = (): [string, string][] => [
		[pickKeys(current()), "pick"],
		["0", "write"],
		["↩", "next"],
		["←", "back"],
	];
	return (
		<QuestionPart
			testID="interview"
			title={title()}
			position={
				at() === REVIEW
					? `${iv().answered} of ${total()} answered`
					: `Question ${number()} of ${total()} · ${iv().answered} answered`
			}
			meta={
				<>
					<If when={!all()}>
						<Caption>{props.source.read().heading}</Caption>
					</If>
					{/* Each part is its own words, so a screen reader and a search find them whole. */}
					<If when={current()}>
						<Caption tone="faint">·</Caption>
						<Caption tone="faint">
							{(current() as Question).new
								? `${sectionLine(current() as Question)} · New this round`
								: sectionLine(current() as Question)}
						</Caption>
					</If>
					<If when={props.source.read().roundHint}>
						<Caption tone="faint">·</Caption>
						<Caption tone="faint">{props.source.read().roundHint ?? ""}</Caption>
					</If>
					<If when={total() > 1 && !fixed(iv())}>
						<Spacer />
						<If when={!all() && at() !== REVIEW}>
							<Link
								label="All answers"
								testID="goto-review"
								accessibilityLabel="All answers and Submit"
								onPress={() => go(props.source, REVIEW)}
							/>
						</If>
						<Link
							label={all() ? "One question at a time" : "See all questions"}
							testID="see-all"
							onPress={() => {
								const now = place(iv());
								const q = iv().questions.find((x) => x.id === now);
								if (q) props.source.dispatch({ kind: "save", questionId: q.id });
								put(seeAll, iv().id, !all());
							}}
						/>
					</If>
				</>
			}
			foot={
				<If
					when={current()}
					else={
						<>
							<AnswersFoot source={props.source} anchor={(node) => props.anchor?.(node)} />
							{props.source.foot?.()}
						</>
					}
				>
					<Button
						kind="primary"
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
					<Button label="‹ Back" disabled={number() <= 1} onPress={() => step(props.source, -1)} />
					<If when={props.source.defer && current() && !fixed(iv())}>
						<Button
							label="Decide later"
							testID="decide-later"
							disabled={props.source.read().busy || !props.source.read().fresh}
							onPress={() => {
								const q = current();
								if (q) {
									props.source.defer?.(q);
									step(props.source, 1);
								}
							}}
						/>
					</If>
					{props.source.foot?.()}
					<Caption tone="faint">{current() ? saveLine(props.source, current() as Question) : ""}</Caption>
					<Spacer />
					<KeyHints hints={hints()} />
				</If>
			}
		>
			<If when={!iv().accepting && iv().submit === "open"}>
				<Caption tone="needs">
					Pilot is not ready to take answers yet. You can read the questions; answering opens soon.
				</Caption>
			</If>
			<If when={all()}>
				<View testID="all-questions" class="gap-6">
					<Each of={iv().questions} key={(q) => q.id}>
						{(q) => (
							<View class="gap-1">
								<Num>{`Question ${iv().questions.findIndex((x) => x.id === q().id) + 1} of ${total()}`}</Num>
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
						<Answers source={props.source} all={all()} />
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
			</If>
			<If when={iv().questions.some((q) => answerView(props.source, q).deferred)}>
				<Body testID="deferred-note" tone="muted">
					Deferred decisions stay open. Your drafts are kept. Work that needs those decisions must wait; other
					missions and drafts stay available. Return and choose or edit an answer before submitting this round.
				</Body>
			</If>
			{props.source.roundNotes?.()}
		</QuestionPart>
	);
}
