// The feedback page's place and its one unsent draft: the words and, when
// the user kept one, the exact mission or chat they are about. Opening the
// page from a mission names that mission only when the draft is empty; a
// draft with words keeps its own origin until the user picks another.
// Leaving the page, closing or updating keeps the draft (updateView.ts);
// only Send sends it, once.
// Unsent answers to a triage's question and the project the user chose for
// triage are kept the same way. Restoring them sends and starts nothing.
import { signal } from "nsh";
import type { UserFeedbackOriginRef } from "./feedbackFeed";
import { glide } from "./motion";

/** Whether the feedback page is open, over the screen it was opened from. */
export const feedbackOpen = signal(false);

/** Unsent feedback, exactly as typed, and the origin the user kept. */
export type FeedbackDraft = { text: string; origin: UserFeedbackOriginRef | null };

const EMPTY: FeedbackDraft = { text: "", origin: null };

/** The window's unsent feedback. Kept across pages, close and update. */
export const feedbackDraft = signal<FeedbackDraft>(EMPTY);

/**
 * Another origin the page was opened from, while the draft has words about
 * a different one. The user may switch to it; nothing switches by itself.
 */
export const feedbackOffer = signal<{ origin: UserFeedbackOriginRef | null } | null>(null);

/** What the last Send or Check said, or "". */
export const feedbackMessage = signal("");

/**
 * The project agents triage and fix feedback in, as the user chose it on
 * this page, or null. Nothing chooses it for the user. While one is chosen,
 * a saved Send also starts its triage there. Kept across close and update.
 */
export const feedbackProject = signal<string | null>(null);

/** An unsent answer to one triage question: the suggestions picked (from 0) and the user's own words. */
export type AnswerDraft = { picks: number[]; text: string };

/** Unsent answers by "<triage chat>/<question>". Only an accepted answer clears one. */
export const answerDrafts = signal<Record<string, AnswerDraft>>({});

export function setAnswerDraft(key: string, draft: AnswerDraft | null) {
	answerDrafts.update((all) => {
		const next = { ...all };
		if (draft && (draft.picks.length > 0 || draft.text !== "")) next[key] = draft;
		else delete next[key];
		return next;
	});
}

/** What the last step on each saved item said, by feedback ID. */
export const stepMessages = signal<Record<string, string>>({});

export function setStepMessage(feedbackId: string, message: string) {
	stepMessages.update((all) => ({ ...all, [feedbackId]: message }));
}

/** An origin as one key, such as "mission/<id>", or "" for Pilot in general. */
export function originKey(origin: UserFeedbackOriginRef | null): string {
	if (!origin) return "";
	return origin.kind === "mission" ? `mission/${origin.missionId}` : `chat/${origin.sessionId}`;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The origin a key names, or undefined when it is not valid. */
export function originFrom(key: string): UserFeedbackOriginRef | null | undefined {
	if (key === "") return null;
	const at = key.indexOf("/");
	const kind = key.slice(0, at);
	const id = key.slice(at + 1);
	if (at <= 0 || !ID.test(id)) return undefined;
	if (kind === "mission") return { kind: "mission", missionId: id };
	if (kind === "chat") return { kind: "chat", sessionId: id };
	return undefined;
}

/**
 * Opens the feedback page from `from`: a mission or chat, or null for Pilot
 * in general. Opening only reads; it never sends or moves typed words.
 */
export function openFeedback(from: UserFeedbackOriginRef | null) {
	glide();
	feedbackMessage.set("");
	const d = feedbackDraft();
	if (d.text.trim() === "") {
		feedbackDraft.set({ text: d.text, origin: from });
		feedbackOffer.set(null);
	} else {
		feedbackOffer.set(originKey(d.origin) === originKey(from) ? null : { origin: from });
	}
	feedbackOpen.set(true);
}

/** Back to the screen under it. The draft stays. */
export function closeFeedback() {
	feedbackOpen.set(false);
	feedbackOffer.set(null);
}

/** The draft as a saved window keeps it: "<origin>\n<text>", or "" without words. */
export function savedFeedback(): string {
	const d = feedbackDraft();
	return d.text === "" ? "" : `${originKey(d.origin)}\n${d.text}`;
}

/** Shows a kept draft again, as unsent words with their own origin. Restoring sends nothing. */
export function restoreFeedback(saved: string) {
	const at = saved.indexOf("\n");
	const origin = at < 0 ? undefined : originFrom(saved.slice(0, at));
	feedbackDraft.set(origin === undefined ? EMPTY : { text: saved.slice(at + 1), origin });
	feedbackOffer.set(null);
	feedbackMessage.set("");
}

/** Unsent answers as a saved window keeps them: "<chat>/<question>\n<picks from 1>\n<text>". */
export function savedAnswers(): string[] {
	return Object.entries(answerDrafts()).map(([key, d]) => `${key}\n${d.picks.map((n) => n + 1).join(",")}\n${d.text}`);
}

/** Shows kept answers again, each with its own question. Restoring sends nothing. */
export function restoreAnswers(saved: string[]) {
	const out: Record<string, AnswerDraft> = {};
	for (const line of saved) {
		const first = line.indexOf("\n");
		const second = line.indexOf("\n", first + 1);
		if (first <= 0 || second < 0) continue;
		const picks = line.slice(first + 1, second);
		out[line.slice(0, first)] = {
			picks: picks === "" ? [] : picks.split(",").map((n) => Number(n) - 1),
			text: line.slice(second + 1),
		};
	}
	answerDrafts.set(out);
}

/** Starts from nothing, as a new window does. */
export function forgetFeedback() {
	feedbackOpen.set(false);
	feedbackDraft.set(EMPTY);
	feedbackOffer.set(null);
	feedbackMessage.set("");
	feedbackProject.set(null);
	answerDrafts.set({});
	stepMessages.set({});
}

/** A local date such as "9 Nov", or "" when it cannot be read. */
export function dayOf(ms: number): string {
	if (!Number.isFinite(ms)) return "";
	try {
		return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
	} catch {
		return "";
	}
}
