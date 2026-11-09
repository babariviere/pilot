// State the screen owns: what the user is looking at and typing. Rust
// never sees it until an intent carries it. Keyed by decision or mission
// id, so it survives reordering, recycling and hot updates of the screens.
import { type Signal, signal } from "nsh";
import type { Decision } from "pilot-day/native";

/** The help a decision card shows. */
export type Help = "simpler" | "more" | "ask" | "details";

/** The option the user picked, by decision. */
export const picks = signal<Record<string, string>>({});
/** Open help panels, by decision. */
export const help = signal<Record<string, Help[]>>({});
/** Unsent questions, exactly as typed, by decision. */
export const drafts = signal<Record<string, string>>({});
/** The last message an intent returned, by decision. */
export const messages = signal<Record<string, string>>({});
/** Questions on their way, by decision. */
export const asking = signal<Record<string, boolean>>({});
/** The decision the user brought to the front, if any. */
export const focused = signal<string | null>(null);

/** The mission whose overview is open, or null for Today. */
export const route = signal<string | null>(null);
/** The mission whose Pause waits for the user's confirmation, if any. */
export const confirming = signal<string | null>(null);
/** The last message a control intent returned, by mission. */
export const controlMessages = signal<Record<string, string>>({});

/** Opens the overview of mission `id`. */
export function openMission(id: string) {
	confirming.set(null);
	route.set(id);
}

/** Goes back to Today. */
export function closeMission() {
	confirming.set(null);
	route.set(null);
}

/** Sets one decision's value in a keyed store. */
export function setFor<T>(store: Signal<Record<string, T>>, id: string, value: T) {
	store.update((all) => ({ ...all, [id]: value }));
}

/** Whether `kind` help is open on decision `id`. */
export function helpOpen(id: string, kind: Help): boolean {
	return (help()[id] ?? []).includes(kind);
}

/** Opens or closes `kind` help on decision `id`. */
export function setHelp(id: string, kind: Help, open: boolean) {
	const now = (help()[id] ?? []).filter((k) => k !== kind);
	setFor(help, id, open ? [...now, kind] : now);
}

/** The option the card shows as chosen: what was sent, else the user's pick, else Pilot's recommendation. */
export function chosen(decision: Decision): string {
	if (decision.sentOption) return decision.sentOption;
	const picked = picks()[decision.id];
	if (picked && decision.options.some((o) => o.id === picked)) return picked;
	const recommended = decision.options.find((o) => o.recommended) ?? decision.options[0];
	return recommended ? recommended.id : "";
}
