// The feedback page's place and its one unsent draft: the words and, when
// the user kept one, the exact mission or chat they are about. Opening the
// page from a mission names that mission only when the draft is empty; a
// draft with words keeps its own origin until the user picks another.
// Leaving the page, closing or updating keeps the draft (updateView.ts);
// only Send sends it, once.
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

/** Starts from nothing, as a new window does. */
export function forgetFeedback() {
	feedbackOpen.set(false);
	feedbackDraft.set(EMPTY);
	feedbackOffer.set(null);
	feedbackMessage.set("");
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
