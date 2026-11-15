// Help on one interview question, as on a decision: its background, a question to a
// read-only chat, and notes for Pilot (say it simpler, reword it). Notes wait here and go
// together, with one note on the whole round, when the user sends them: Pilot then redoes
// the round. Nothing here answers a question or approves anything.
import { signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import type { Interview, PlanPage, Question } from "pilot-day/native";
import { errorText, logEvent } from "./dayLog";
import type { Plans } from "./planning";
import { put } from "./planView";
import { Action, HelpChip } from "./ui";

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
			<View class="flex-row flex-wrap gap-1.5">
				<If when={q().context}>
					<HelpChip label="More context" pressed={panel(key, "context")} onChange={() => toggle(key, "context")} />
				</If>
				<HelpChip
					label="Say it simpler"
					pressed={note().simpler}
					onChange={(pressed) => setNote(props.interview.id, q().id, { simpler: pressed })}
				/>
				<If when={canAsk()}>
					<HelpChip
						label="Ask a question"
						pressed={panel(key, "ask") || q().asks.length > 0}
						onChange={() => toggle(key, "ask")}
					/>
				</If>
				<HelpChip
					label="Reword this"
					pressed={panel(key, "reword") || note().text.trim() !== ""}
					onChange={() => toggle(key, "reword")}
				/>
			</View>
			<If when={panel(key, "context") && q().context}>
				<View testID={`context-${q().id}`} class="rounded-xl bg-muted px-4 py-3">
					<Text class="text-sm leading-relaxed text-foreground">{q().context}</Text>
				</View>
			</If>
			<If when={note().simpler}>
				<Text testID={`simpler-${q().id}`} class="text-xs text-faint">
					Noted: Pilot says this one more simply when you send your notes.
				</Text>
			</If>
			<If when={canAsk() && (panel(key, "ask") || q().asks.length > 0)}>
				<View testID={`ask-${q().id}`} class="gap-3 rounded-xl bg-muted px-4 py-3">
					<Each of={q().asks} key={(a) => a.id}>
						{(a) => (
							<View class="gap-1">
								<Text class="text-sm text-muted-foreground">{a().text}</Text>
								<If when={a().state === "answered"}>
									<Text class="text-sm leading-relaxed text-foreground">{a().answer}</Text>
								</If>
								<If when={a().state === "asking"}>
									<Text class="text-sm text-faint">Pilot is writing an answer…</Text>
								</If>
								<If when={a().state === "failed"}>
									<Text class="text-sm text-needs-ink">{a().reason || "No answer came. Ask again."}</Text>
								</If>
							</View>
						)}
					</Each>
					<View class="flex-row items-center gap-2">
						<Input
							testID={`ask-text-${q().id}`}
							value={draft()}
							onChange={({ value }) => put(askDrafts, key, value)}
							onSubmit={() => void ask()}
							submitBehavior="submit"
							placeholder="What do you want to know?"
							accessibilityLabel="Ask about this question"
							class="min-h-8 flex-1 rounded-lg border border-input bg-background px-3 py-1.5 text-sm text-foreground focus:border-primary"
						/>
						<Action
							testID={`ask-send-${q().id}`}
							label={askBusy()[key] ? "Asking…" : "Ask"}
							disabled={askBusy()[key] === true || !draft().trim()}
							onPress={() => void ask()}
						/>
					</View>
					<If when={askMessages()[key]}>
						<Text class="text-xs text-needs-ink">{askMessages()[key] ?? ""}</Text>
					</If>
					<Text class="text-xs text-faint">
						A separate chat answers from the mission's records. It answers nothing for you.
					</Text>
				</View>
			</If>
			<If when={panel(key, "reword")}>
				<View class="gap-1.5 rounded-xl bg-muted px-4 py-3">
					<Text class="text-sm text-foreground">What should change about this question?</Text>
					<Input
						testID={`reword-${q().id}`}
						multiline
						value={note().text}
						onChange={({ value }) => setNote(props.interview.id, q().id, { text: value })}
						placeholder="For example: this mixes two things, or I don't know this term"
						accessibilityLabel="Your note on this question"
						class="min-h-8 rounded-lg border border-input bg-background px-3 py-1.5 text-sm text-foreground focus:border-primary"
					/>
					<Text class="text-xs text-faint">Notes wait here. Send them together at the end of the round.</Text>
				</View>
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
		<View testID="round-notes" class="gap-2 border-t border-border pt-4">
			<If when={writing() || round().trim()}>
				<Input
					testID="round-note"
					multiline
					value={round()}
					onChange={({ value }) => put(roundNotes, id(), value)}
					placeholder="A note on the whole round, for example: too technical overall"
					accessibilityLabel="Your note on the whole round"
					class="min-h-8 rounded-lg border border-input bg-background px-3 py-1.5 text-sm text-foreground focus:border-primary"
				/>
			</If>
			<View class="flex-row flex-wrap items-center gap-2">
				<If when={!writing() && !round().trim()}>
					<Action
						testID="round-note-open"
						label="Add a note on the whole round"
						onPress={() => writing.set(true)}
					/>
				</If>
				<View class="flex-1" />
				<If when={count() > 0}>
					<Action
						testID="notes-send"
						label={
							busy() ? "Sending…" : count() === 1 ? "Send 1 note to Pilot" : `Send ${count()} notes to Pilot`
						}
						accessibilityLabel="Send your notes: Pilot redoes this round with them. Your answers stay."
						disabled={busy() || !(props.page.canComment || busy())}
						onPress={() => void send()}
					/>
				</If>
			</View>
			<If when={count() > 0 && !props.page.canComment && !busy()}>
				<Text class="text-xs text-faint">Pilot is working. Send your notes when it stops.</Text>
			</If>
			<If when={message()}>
				<Text testID="notes-message" class="text-xs text-faint">
					{message()}
				</Text>
			</If>
		</View>
	);
}
