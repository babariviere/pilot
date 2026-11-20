// Help on one interview question, as on a decision: its background, a question to a
// read-only chat, and notes for Pilot (say it simpler, reword it). Notes wait here and go
// together, with one note on the whole round, when the user sends them: Pilot then redoes
// the round. Nothing here answers a question or approves anything.
import { signal, View } from "nsh";
import type { Interview, PlanPage, Question } from "pilot-day/native";
import { errorText, logEvent } from "./dayLog";
import type { Plans } from "./planning";
import { put } from "./planView";
import { Body, Button, Buttons, Caption, Chip, Chips, Link, Quote, Spacer, TextField } from "./ui";

/** A note on one question: say it simpler, and the user's own words about it. */
export type QuestionNote = { simpler: boolean; text: string };

/** Which help panels are open, by answer key and panel. */
const panels = signal<Record<string, boolean>>({});
/** Notes by interview, then question. Kept while the app runs. */
export const questionNotes = signal<Record<string, Record<string, QuestionNote>>>({});
/** One note on the whole round, by interview. */
export const roundNotes = signal<Record<string, string>>({});
const askDrafts = signal<Record<string, string>>({});
const askBusy = signal<Record<string, boolean>>({});
const askMessages = signal<Record<string, string>>({});

const panel = (key: string, kind: string) => panels()[`${key}:${kind}`] === true;
/** Keys for the help on the question shown, as on the chips' tooltips. */
export const HELP_KEYS = { context: "m", simpler: "s", ask: "a", reword: "r" } as const;

/** Toggles one kind of help on a question, as its chip does. A key press calls it for the question shown. */
export function toggleQuestionHelp(
	interview: Interview,
	q: Question,
	helpKey: string,
	kind: keyof typeof HELP_KEYS,
	canAsk: boolean,
) {
	if (kind === "simpler") setNote(interview.id, q.id, { simpler: !noteOf(interview.id, q.id).simpler });
	else if (kind === "context" ? !!q.context : kind === "ask" ? canAsk : true) toggle(helpKey, kind);
}
/** Unsent question help as a saved window keeps it (see SavedView.questionHelp). */
export function savedQuestionHelp(): string[] {
	const lines: string[] = [];
	for (const [interview, notes] of Object.entries(questionNotes()))
		for (const [question, n] of Object.entries(notes))
			if (n.simpler || n.text.trim()) lines.push(`note\n${interview}\n${question}\n${n.simpler ? 1 : 0}\n${n.text}`);
	for (const [interview, text] of Object.entries(roundNotes()))
		if (text.trim()) lines.push(`round\n${interview}\n\n0\n${text}`);
	for (const [key, text] of Object.entries(askDrafts())) if (text.trim()) lines.push(`ask\n${key}\n\n0\n${text}`);
	return lines;
}

/** Shows kept question help again, each with its own interview and question. Restoring sends nothing. */
export function restoreQuestionHelp(saved: string[]) {
	const notes: Record<string, Record<string, QuestionNote>> = {};
	const rounds: Record<string, string> = {};
	const asks: Record<string, string> = {};
	for (const line of saved) {
		const [kind, at, question, simpler, ...rest] = line.split("\n");
		const text = rest.join("\n");
		if (!at) continue;
		if (kind === "note" && question)
			notes[at] = { ...(notes[at] ?? {}), [question]: { simpler: simpler === "1", text } };
		else if (kind === "round") rounds[at] = text;
		else if (kind === "ask") asks[at] = text;
	}
	questionNotes.set(notes);
	roundNotes.set(rounds);
	askDrafts.set(asks);
}

const toggle = (key: string, kind: string) => put(panels, `${key}:${kind}`, !panel(key, kind));

function noteOf(interview: string, question: string): QuestionNote {
	return questionNotes()[interview]?.[question] ?? { simpler: false, text: "" };
}
function setNote(interview: string, question: string, change: Partial<QuestionNote>) {
	const all = questionNotes();
	const mine = { ...(all[interview] ?? {}) };
	const next = { ...noteOf(interview, question), ...change };
	if (!next.simpler && !next.text.trim()) delete mine[question];
	else mine[question] = next;
	questionNotes.set({ ...all, [interview]: mine });
}

/** How many notes wait for the interview: one per question with a note, and the round's own note. */
export function noteCount(interview: Interview): number {
	const mine = questionNotes()[interview.id] ?? {};
	const asked = interview.questions.filter((q) => mine[q.id]).length;
	return asked + ((roundNotes()[interview.id] ?? "").trim() ? 1 : 0);
}

/**
 * The notes as one message for Pilot's planning agent, word for word. Each question is
 * named by its id and words, so Pilot knows which one; questions the user asked about it
 * show where it was unclear.
 */
export function notesFeedback(interview: Interview, notes: Record<string, QuestionNote>, round: string): string {
	const lines: string[] = [];
	for (const q of interview.questions) {
		const note = notes[q.id];
		if (!note) continue;
		const parts = [note.simpler ? "Say it in simpler words." : "", note.text.trim()].filter(Boolean);
		const asked = q.asks.map((a) => `“${a.text}”`);
		lines.push(
			`- Question ${q.id} “${q.prompt}”: ${parts.join(" ")}${asked.length ? ` The user asked about it: ${asked.join("; ")}.` : ""}`,
		);
	}
	if (round.trim()) lines.push(`- The whole round: ${round.trim()}`);
	return lines.length ? `Notes from the user on this round:\n${lines.join("\n")}` : "";
}

/** The help row under one question, and its open panels. */
export function QuestionHelp(props: {
	plans: Plans;
	page: PlanPage;
	interview: Interview;
	question: Question;
	helpKey: string;
}) {
	const q = () => props.question;
	const key = props.helpKey;
	const note = () => noteOf(props.interview.id, q().id);
	const canAsk = () => props.plans.feed.askQuestion !== undefined && props.page.fresh;
	const draft = () => askDrafts()[key] ?? "";
	const ask = async () => {
		const text = draft().trim();
		const feed = props.plans.feed;
		if (!text || askBusy()[key] || !feed.askQuestion) return;
		put(askBusy, key, true);
		put(askMessages, key, "");
		try {
			// Called on the feed: the connected feed's methods use their own private state.
			const outcome = await feed.askQuestion({ missionId: props.page.missionId, questionId: q().id, text });
			if (outcome.status === "accepted") put(askDrafts, key, "");
			else put(askMessages, key, outcome.message);
		} catch (error) {
			logEvent("ui.error", errorText(error));
			put(askMessages, key, "Pilot could not send this. Nothing was sent; your words stay.");
		} finally {
			put(askBusy, key, false);
		}
	};
	return (
		<View testID={`help-${q().id}`} class="gap-3">
			<Chips>
				<If when={q().context}>
					<Chip
						label="More context"
						shortcut={HELP_KEYS.context}
						pressed={panel(key, "context")}
						onChange={() => toggle(key, "context")}
					/>
				</If>
				<Chip
					label="Say it simpler"
					shortcut={HELP_KEYS.simpler}
					pressed={note().simpler}
					onChange={(pressed) => setNote(props.interview.id, q().id, { simpler: pressed })}
				/>
				<If when={canAsk()}>
					<Chip
						label="Ask a question"
						shortcut={HELP_KEYS.ask}
						pressed={panel(key, "ask") || q().asks.length > 0}
						onChange={() => toggle(key, "ask")}
					/>
				</If>
				<Chip
					label="Reword this"
					shortcut={HELP_KEYS.reword}
					pressed={panel(key, "reword") || note().text.trim() !== ""}
					onChange={() => toggle(key, "reword")}
				/>
			</Chips>
			<If when={panel(key, "context") && q().context}>
				<Quote testID={`context-${q().id}`} text={q().context} />
			</If>
			<If when={note().simpler}>
				<Caption testID={`simpler-${q().id}`} tone="faint">
					Noted: Pilot says this one more simply when you send your notes.
				</Caption>
			</If>
			<If when={canAsk() && (panel(key, "ask") || q().asks.length > 0)}>
				<Quote testID={`ask-${q().id}`}>
					<View class="gap-3">
						<Each of={q().asks} key={(a) => a.id}>
							{(a) => (
								<View class="gap-1">
									<Body tone="muted">{a().text}</Body>
									<If when={a().state === "answered"}>
										<Body>{a().answer}</Body>
									</If>
									<If when={a().state === "asking"}>
										<Body tone="faint">Pilot is writing an answer…</Body>
									</If>
									<If when={a().state === "failed"}>
										<Body tone="needs">{a().reason || "No answer came. Ask again."}</Body>
									</If>
								</View>
							)}
						</Each>
						<View class="flex-row items-center gap-2">
							<TextField
								testID={`ask-text-${q().id}`}
								value={draft()}
								onChange={({ value }) => put(askDrafts, key, value)}
								onSubmit={() => void ask()}
								submitBehavior="submit"
								placeholder="What do you want to know?"
								accessibilityLabel="Ask about this question"
								class="flex-1"
							/>
							<Button
								testID={`ask-send-${q().id}`}
								label={askBusy()[key] ? "Asking…" : "Ask"}
								disabled={askBusy()[key] === true || !draft().trim()}
								onPress={() => void ask()}
							/>
						</View>
						<If when={askMessages()[key]}>
							<Caption tone="needs">{askMessages()[key] ?? ""}</Caption>
						</If>
						<Caption tone="faint">
							A separate chat answers from the mission's records. It answers nothing for you.
						</Caption>
					</View>
				</Quote>
			</If>
			<If when={panel(key, "reword")}>
				<Quote>
					<Body>What should change about this question?</Body>
					<TextField
						testID={`reword-${q().id}`}
						multiline
						value={note().text}
						onChange={({ value }) => setNote(props.interview.id, q().id, { text: value })}
						placeholder="For example: this mixes two things, or I don't know this term"
						accessibilityLabel="Your note on this question"
					/>
					<Caption tone="faint">Notes wait here. Send them together at the end of the round.</Caption>
				</Quote>
			</If>
		</View>
	);
}

/**
 * The round's notes: one note on the whole round, and the action that sends every note
 * together. Pilot then redoes the round; saved answers stay.
 */
export function RoundNotes(props: { plans: Plans; page: PlanPage; interview: Interview }) {
	const id = () => props.interview.id;
	const busy = signal(false);
	const message = signal("");
	const writing = signal(false);
	const count = () => noteCount(props.interview);
	const round = () => roundNotes()[id()] ?? "";
	const send = async () => {
		const feed = props.plans.feed;
		const feedback = notesFeedback(props.interview, questionNotes()[id()] ?? {}, round());
		if (busy() || !feedback || !feed.continuePlanning) return;
		busy.set(true);
		message.set("");
		try {
			// Called on the feed: the connected feed's methods use their own private state.
			const outcome = await feed.continuePlanning({ missionId: props.page.missionId, feedback });
			message.set(outcome.message);
			if (outcome.status === "accepted") {
				questionNotes.set({ ...questionNotes(), [id()]: {} });
				put(roundNotes, id(), "");
				writing.set(false);
			}
		} catch (error) {
			logEvent("ui.error", errorText(error));
			message.set("Pilot could not send this. Nothing was sent; your notes stay.");
		} finally {
			busy.set(false);
		}
	};
	return (
		<View testID="round-notes" class="gap-2">
			<If when={writing() || round().trim()}>
				<TextField
					testID="round-note"
					multiline
					value={round()}
					onChange={({ value }) => put(roundNotes, id(), value)}
					placeholder="A note on the whole round, for example: too technical overall"
					accessibilityLabel="Your note on the whole round"
				/>
			</If>
			<Buttons>
				<If when={!writing() && !round().trim()}>
					<Link testID="round-note-open" label="Add a note on the whole round" onPress={() => writing.set(true)} />
				</If>
				<Spacer />
				<If when={count() > 0}>
					<Button
						testID="notes-send"
						label={
							busy() ? "Sending…" : count() === 1 ? "Send 1 note to Pilot" : `Send ${count()} notes to Pilot`
						}
						accessibilityLabel="Send your notes: Pilot redoes this round with them. Your answers stay."
						disabled={busy() || !(props.page.canComment || busy())}
						onPress={() => void send()}
					/>
				</If>
			</Buttons>
			<If when={count() > 0 && !props.page.canComment && !busy()}>
				<Caption tone="faint">Pilot is working. Send your notes when it stops.</Caption>
			</If>
			<If when={message()}>
				<Caption testID="notes-message" tone="faint">
					{message()}
				</Caption>
			</If>
		</View>
	);
}
