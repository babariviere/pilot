// State the start and end of day own: which ritual shows, its step, and how
// the user left each one today. Rust never sees it: a ritual only reads
// Today and sends no intent. Marks are kept per date for this run of the
// app, not saved across restarts.
import { signal } from "nsh";
import type { Today } from "pilot-day/native";
import { closeMission } from "./view";

/** The start or the end of the day. */
export type Ritual = "start" | "end";

/** How the user left a ritual: went through it, or skipped it. */
export type RitualMark = "done" | "skipped";

/** The ritual or standup notes on screen, or null for the other screens. */
export type RitualRoute = { kind: Ritual } | { kind: "standup"; from: Ritual | null } | null;

/** Where the ritual screens are. Null shows Today and the rest. */
export const ritualRoute = signal<RitualRoute>(null);
/** The step of the start of day, from 0. */
export const startStep = signal(0);
/** How the user left each ritual, by date and ritual. */
export const ritualMarks = signal<Record<string, RitualMark>>({});

function key(today: Today, ritual: Ritual): string {
	return `${today.date}/${ritual}`;
}

/** How the user left `ritual` on the date Today was read, if they did. */
export function markOf(today: Today, ritual: Ritual): RitualMark | undefined {
	return ritualMarks()[key(today, ritual)];
}

/** Keeps how the user left `ritual` on the date Today was read. */
export function mark(today: Today, ritual: Ritual, how: RitualMark) {
	ritualMarks.update((all) => ({ ...all, [key(today, ritual)]: how }));
}

/**
 * The ritual Today offers: the start in the morning, the end in the
 * evening, until the user goes through or skips it that day. Nothing when
 * the part of day is unknown or nothing could be read.
 */
export function offered(today: Today): Ritual | null {
	if (today.freshness.state === "unreadable") return null;
	const ritual = today.part === "morning" ? "start" : today.part === "evening" ? "end" : null;
	if (!ritual || markOf(today, ritual)) return null;
	return ritual;
}

/** Opens `ritual` at its first step. */
export function openRitual(ritual: Ritual) {
	closeMission();
	startStep.set(0);
	ritualRoute.set({ kind: ritual });
}

/** Opens the standup notes; Back returns to `from`, or to Today. */
export function openStandup(from: Ritual | null) {
	closeMission();
	ritualRoute.set({ kind: "standup", from });
}

/** Leaves the ritual screens for Today. Marks nothing. */
export function closeRitual() {
	ritualRoute.set(null);
}

/** Goes back from the standup notes to the ritual that opened them, else to Today. */
export function backFromStandup() {
	const at = ritualRoute();
	ritualRoute.set(at?.kind === "standup" && at.from ? { kind: at.from } : null);
}
