// State the start and end of day own on screen: which ritual shows and its
// step. How the user left each ritual (Done, Skip) and where to resume are
// not kept here: they are the ritual's saved progress (ritualFeed.ts), which
// only an explicit Next, Back, Done or Skip changes. Leaving a ritual, with
// Escape or Back, saves nothing.
import { signal } from "nsh";
import type { RitualSnapshot, Today } from "pilot-day/native";
import type { Rituals } from "./ritualFeed";
import { closeMission } from "./view";

/** The start or the end of the day. */
export type Ritual = "start" | "end";

/** The ritual or standup notes on screen, or null for the other screens. */
export type RitualRoute = { kind: Ritual } | { kind: "standup"; from: Ritual | null } | null;

/** How many steps the start of day has. */
export const START_STEPS = 3;

/** Where the ritual screens are. Null shows Today and the rest. */
export const ritualRoute = signal<RitualRoute>(null);
/** The step of the start of day on screen, from 0. */
export const startStep = signal(0);
/** The window's ritual progress. The window sets it once. */
export const ritualEntry = signal<Rituals | null>(null);

/**
 * The ritual Today offers: the start in the morning, the end in the
 * evening, until the user goes through or skips it that day. Nothing when
 * Today could not be read, when the saved progress is not confirmed, or
 * when the part of day is unknown.
 */
export function offered(today: Today, progress: RitualSnapshot, uncertain: boolean): Ritual | null {
	if (today.freshness.state === "unreadable" || uncertain) return null;
	if (progress.availability !== "available") return null;
	const ritual = progress.part === "morning" ? "start" : progress.part === "evening" ? "end" : null;
	if (!ritual || progress[ritual].mark !== "unmarked") return null;
	return ritual;
}

/** The step a saved start of day resumes at. A saved step is never Done. */
export function resumeStep(progress: RitualSnapshot): number {
	return Math.max(0, Math.min(START_STEPS - 1, progress.start.step));
}

/** Opens `ritual` where the user left it, and reads the results it lists. */
export function openRitual(ritual: Ritual) {
	const rituals = ritualEntry();
	closeMission();
	rituals?.message.set("");
	startStep.set(ritual === "start" && rituals ? resumeStep(rituals.progress()) : 0);
	ritualRoute.set({ kind: ritual });
	void rituals?.readResults();
}

/** Opens the standup notes; Back returns to `from`, or to Today. */
export function openStandup(from: Ritual | null) {
	closeMission();
	ritualRoute.set({ kind: "standup", from });
	if (!from) void ritualEntry()?.readResults();
}

/** Leaves the ritual screens for Today. Saves nothing. */
export function closeRitual() {
	ritualRoute.set(null);
}

/** Goes back from the standup notes to the ritual that opened them, else to Today. */
export function backFromStandup() {
	const at = ritualRoute();
	ritualRoute.set(at?.kind === "standup" && at.from ? { kind: at.from } : null);
}
