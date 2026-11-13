// State the New and planning screens own: what the user is looking at and
// typing, before an intent carries it to Rust. Keyed by interview and
// question, so it survives reordering, new rounds and hot updates.
import { type Signal, signal } from "nsh";
import type { ChatChoice, Interview, Question } from "pilot-day/native";
import type { ChatMode } from "./chatFeed";
import { closeMission } from "./view";

/** New, or one mission's planning, or null for Today and missions. */
export type PlanRoute = { kind: "new" } | { kind: "plan"; missionId: string } | null;

/** Where the planning screens are. Null shows Today or a mission. */
export const planRoute = signal<PlanRoute>(null);

/** What the user wrote on New, exactly. */
export const goalDraft = signal("");
/** Whether New waits for the user to confirm a direct start. */
export const confirmingStart = signal(false);
/** The last message New's intents returned. */
export const newMessage = signal("");
/** Whether New sent something and waits for its answer. */
export const newBusy = signal(false);

/**
 * The project and access the user chose on New, themselves. Null until they
 * choose: New never chooses one for them (not the window's own project,
 * Today's or the last one used). A choice stays with New's words; it never
 * changes an existing chat.
 */
export const chatPick = signal<{ projectId: string; mode: ChatMode } | null>(null);
/** Pilot's passive selection for that choice: what a new chat names, and what a close saves. */
export const chatChoice = signal<ChatChoice | null>(null);
/** Whether Pilot is reading the chosen project's setup. */
export const chatSelecting = signal(false);
/** Why the chosen project cannot be used now, or "". */
export const chatNote = signal("");
/** Whether the project list is open: Escape closes it, not New. */
export const projectsOpen = signal(false);
/** The draft a restored window had chosen. If Pilot saved its creation, New shows how it ended. */
export const restoredDraft = signal<string | null>(null);

/** Unsaved answer text, exactly as typed, by answer key. */
export const answerDrafts = signal<Record<string, string>>({});
/** The suggestion the user picked and Rust has not saved yet, by answer key. Null is "Something else". */
export const answerPicks = signal<Record<string, string | null>>({});
/** The last message a save returned, by answer key. */
export const answerMessages = signal<Record<string, string>>({});
/** The last message a submission or check returned, by mission. */
export const planMessages = signal<Record<string, string>>({});
/** Whether a submission waits for its saves and its answer, by interview. */
export const submitting = signal<Record<string, boolean>>({});
/** Whether the fog of war is open, by mission. */
export const fogOpen = signal<Record<string, boolean>>({});
/** Whether a map question shows its full record, by mission and question. */
export const mapOpen = signal<Record<string, boolean>>({});
/** Whether the map's settled questions are open, by mission. */
export const settledOpen = signal<Record<string, boolean>>({});
/** Whether an earlier round's answers are open, by mission and round. */
export const roundOpen = signal<Record<string, boolean>>({});
/** The question each interview shows, or "review" for its answers page, by interview. */
export const atQuestion = signal<Record<string, string>>({});
/** Set to an answer key whose first choice should take the keyboard focus once. */
export const focusAsk = signal<string | null>(null);
/** Set to an answer key whose text field should take the keyboard focus once. */
export const focusField = signal<string | null>(null);
/** Whether the user opened a question's text field, by answer key. */
export const writing = signal<Record<string, boolean>>({});
/** Whether an interview shows all its questions at once, by interview. One at a time is the default. */
export const seeAll = signal<Record<string, boolean>>({});
/** The revision whose confirmation the user opened, exactly as shown, by mission. */
export const revisionShown = signal<Record<string, { revisionId: string; digest: string }>>({});
/** Whether a Revisit intent waits for its answer, by mission. */
export const revisitBusy = signal<Record<string, boolean>>({});
/** The last message a Revisit intent returned, by mission. */
export const revisitMessages = signal<Record<string, string>>({});
/** Whether a part of the Revisit is open, by mission and part. */
export const revisitOpen = signal<Record<string, boolean>>({});

/** The key of one answer: its interview and question. */
export function answerKey(interview: Interview, question: Question): string {
	return `${interview.id}/${question.id}`;
}

/** Sets one key's value in a keyed store. */
export function put<T>(store: Signal<Record<string, T>>, key: string, value: T) {
	store.update((all) => ({ ...all, [key]: value }));
}

/** Removes one key from a keyed store. */
export function drop<T>(store: Signal<Record<string, T>>, key: string) {
	if (!(key in store())) return;
	store.update((all) => {
		const next = { ...all };
		delete next[key];
		return next;
	});
}

/** Opens New. */
export function openNew() {
	closeMission();
	confirmingStart.set(false);
	planRoute.set({ kind: "new" });
}

/** Opens one mission's planning. */
export function openPlan(missionId: string) {
	closeMission();
	planRoute.set({ kind: "plan", missionId });
}

/** Back to Today. Drafts stay. */
export function closePlanning() {
	confirmingStart.set(false);
	planRoute.set(null);
}
