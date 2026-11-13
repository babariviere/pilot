// A thread's place in the window and the user's unsent words. A thread
// hangs off its mission's overview: Back goes to the mission. Drafts are
// kept by mission and thread, so a message is never sent to another thread
// or mission, and they stay across Back, other pages, close and update
// (updateView.ts). Only Send sends one, once.
import { signal } from "nsh";
import { glide } from "./motion";

/** The thread on screen, over its mission. */
export type ThreadPlace = { missionId: string; topicId: string };

export const threadRoute = signal<ThreadPlace | null>(null);

/** Unsent words by draftKey(mission, topic); topic "" is a new thread's title. */
export const threadDrafts = signal<Record<string, string>>({});

/** What the last write or Check said, by draftKey. */
export const threadMessages = signal<Record<string, string>>({});

/** Missions whose discarded threads are shown. */
export const showDiscarded = signal<Record<string, boolean>>({});

/** Threads whose "Link a task or decision" list is open. */
export const linkOpen = signal<Record<string, boolean>>({});

/** Missions where the user is naming a new thread. */
export const naming = signal<Record<string, boolean>>({});

export function draftKey(missionId: string, topicId: string): string {
	return `${missionId}/${topicId}`;
}

/** Opens thread `topicId` of mission `missionId`. Opening it only reads. */
export function openThread(missionId: string, topicId: string) {
	glide();
	threadRoute.set({ missionId, topicId });
}

/** Back to the mission. The draft stays. */
export function closeThread() {
	threadRoute.set(null);
}

export function setDraft(key: string, text: string) {
	threadDrafts.update((all) => ({ ...all, [key]: text }));
}

/** Forgets a draft after the service accepted it. */
export function clearDraft(key: string) {
	threadDrafts.update((all) => {
		const next = { ...all };
		delete next[key];
		return next;
	});
}

export function setMessage(key: string, message: string) {
	threadMessages.update((all) => ({ ...all, [key]: message }));
}

/** A mission or thread ID as the native root saves it. */
const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The thread on screen as a saved window keeps it, "<mission>/<thread>", or "". */
export function savedThread(): string {
	const at = threadRoute();
	return at && ID.test(at.missionId) && ID.test(at.topicId) ? `${at.missionId}/${at.topicId}` : "";
}

/** Unsent words as a saved window keeps them: "<mission>\n<thread>\n<text>". */
export function savedThreadDrafts(): string[] {
	const out: string[] = [];
	for (const [key, text] of Object.entries(threadDrafts())) {
		const at = key.indexOf("/");
		const mission = key.slice(0, at);
		const topic = key.slice(at + 1);
		if (at <= 0 || text === "" || !ID.test(mission) || (topic !== "" && !ID.test(topic))) continue;
		out.push(`${mission}\n${topic}\n${text}`);
	}
	return out;
}

/** Shows a kept thread and its unsent words again. Restoring sends nothing. */
export function restoreThreads(place: string, lines: readonly string[]) {
	const at = place.indexOf("/");
	const mission = place.slice(0, at);
	const topic = place.slice(at + 1);
	threadRoute.set(at > 0 && ID.test(mission) && ID.test(topic) ? { missionId: mission, topicId: topic } : null);
	const drafts: Record<string, string> = {};
	const names: Record<string, boolean> = {};
	for (const line of lines) {
		const first = line.indexOf("\n");
		const second = first < 0 ? -1 : line.indexOf("\n", first + 1);
		if (second < 0) continue;
		const m = line.slice(0, first);
		const t = line.slice(first + 1, second);
		if (!ID.test(m) || (t !== "" && !ID.test(t))) continue;
		drafts[draftKey(m, t)] = line.slice(second + 1);
		if (t === "") names[m] = true;
	}
	threadDrafts.set(drafts);
	naming.set(names);
	threadMessages.set({});
	linkOpen.set({});
	showDiscarded.set({});
}

/** A new window: no thread and no unsent words. */
export function forgetThreads() {
	restoreThreads("", []);
}
