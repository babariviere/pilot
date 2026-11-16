// View-local interview navigation, shared by mission and standalone rounds.
import { type Signal, signal } from "nsh";
import type { Interview, Question } from "pilot-day/native";

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
/** The key of one answer: its interview and question. */
export function answerKey(interview: Interview, question: Question): string {
	return `${interview.id}/${question.id}`;
}

/** Sets one key's value in a keyed store. */
export function put<T>(store: Signal<Record<string, T>>, key: string, value: T) {
	store.update((all) => ({ ...all, [key]: value }));
}
