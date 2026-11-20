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
/** Explicitly deferred questions, pinned to their displayed meaning. Not answers. */
export const deferredQuestions = signal<Record<string, string>>({});

export function deferred(interview: Interview, question: Question): boolean {
	return deferredQuestions()[answerKey(interview, question)] === question.digest;
}

export function returnToQuestion(interview: Interview, question: Question) {
	const key = answerKey(interview, question);
	deferredQuestions.update((all) => Object.fromEntries(Object.entries(all).filter(([id]) => id !== key)));
}
/** The key of one answer: its interview and question. */
export function answerKey(interview: Interview, question: Question): string {
	return `${interview.id}/${question.id}`;
}

type SavedInterviewView = Pick<import("pilot-day/native").SavedView, "questions" | "seeAll" | "deferredQuestions">;

/** Encodes round-scoped question identities without splitting their scope. */
export function captureInterviewView(): SavedInterviewView {
	return {
		deferredQuestions: Object.entries(deferredQuestions()).map((entry) => JSON.stringify(entry)),
		questions: Object.entries(atQuestion()).map(([interview, question]) => `${interview}/${question}`),
		seeAll: Object.entries(seeAll())
			.filter(([, all]) => all)
			.map(([interview]) => interview),
	};
}

/** Restores disclosure state, not answers or submissions. */
export function restoreInterviewView(view: SavedInterviewView) {
	const deferred: Record<string, string> = {};
	for (const entry of view.deferredQuestions ?? []) {
		try {
			const pair: unknown = JSON.parse(entry);
			if (Array.isArray(pair) && pair.length === 2 && pair.every((v) => typeof v === "string"))
				deferred[pair[0]] = pair[1];
		} catch {
			/* Invalid local disclosure state carries no answer. */
		}
	}
	deferredQuestions.set(deferred);
	const shown: Record<string, string> = {};
	for (const entry of view.questions) {
		// Scope and round identities can contain slashes; question IDs cannot.
		const at = entry.lastIndexOf("/");
		if (at > 0) shown[entry.slice(0, at)] = entry.slice(at + 1);
	}
	atQuestion.set(shown);
	seeAll.set(Object.fromEntries((view.seeAll ?? []).map((interview) => [interview, true])));
}

export function resetInterviewView() {
	deferredQuestions.set({});
	atQuestion.set({});
	writing.set({});
	seeAll.set({});
}

/** Sets one key's value in a keyed store. */
export function put<T>(store: Signal<Record<string, T>>, key: string, value: T) {
	store.update((all) => ({ ...all, [key]: value }));
}
