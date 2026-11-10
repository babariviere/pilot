// State the screen owns: what the user is looking at and typing. Keyed by
// decision or action id, so it survives reordering, recycling and hot
// updates of the screens. Picks and unsent words also go to Rust as drafts
// (commands.ts), which saves them for the exact revision shown; after a
// restart the screen starts from those drafts.
import { type Signal, signal, type ViewRef } from "nsh";
import type { Decision, HumanAction, Today } from "pilot-day/native";

/** The help a decision card shows. */
export type Help = "simpler" | "more" | "visual" | "ask" | "details";

/** An option the user picked, and the decision's revision it was picked on. */
export type Pick = { option: string; revision: number };

/** The option the user picked, by decision. */
export const picks = signal<Record<string, Pick>>({});
/** Open help panels, by decision. */
export const help = signal<Record<string, Help[]>>({});
/** Unsent questions, exactly as typed, by decision. */
export const drafts = signal<Record<string, string>>({});
/** Unsent answers or detail in the user's own words, exactly as typed, by decision. */
export const replies = signal<Record<string, string>>({});
/** Unsent action notes and reports, exactly as typed, by action. */
export const reports = signal<Record<string, string>>({});
/** The last message an intent returned, by decision or action. */
export const messages = signal<Record<string, string>>({});
/** Questions on their way, by decision. */
export const asking = signal<Record<string, boolean>>({});
/** The decision or action the user brought to the front, if any. */
export const focused = signal<string | null>(null);
/** Set when the user's own triage changed the card in front: that card takes the keyboard focus once. */
export const focusFront = signal(false);
/** Set to the id whose question or report input should take the keyboard focus once. */
export const focusInput = signal<string | null>(null);

/** The focus target of a decision's own-words field. */
export function replyTarget(id: string): string {
	return `${id}#reply`;
}

/** The question typed on `decision`: this run's text, else its saved draft. */
export function questionText(decision: Decision): string {
	return drafts()[decision.id] ?? decision.draft.question;
}

/** The user's own words on `decision`: this run's text, else its saved draft. */
export function replyText(decision: Decision): string {
	return replies()[decision.id] ?? decision.draft.text;
}

/** The notes or report typed on `action`: this run's text, else its saved draft. */
export function reportText(action: HumanAction): string {
	return reports()[action.id] ?? action.draft.text;
}

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

/** Picks option `option` of `decision`, at the revision shown. */
export function pick(decision: Decision, option: string) {
	setFor(picks, decision.id, { option, revision: decision.revision });
}

/** Whether the user picked an option on an earlier revision of `decision`. That pick no longer counts. */
export function pickChanged(decision: Decision): boolean {
	const picked = picks()[decision.id];
	return !decision.sentOption && picked !== undefined && picked.revision !== decision.revision;
}

/**
 * The option the card shows as chosen: what was sent, else the user's pick
 * on this revision (this run's, else the saved draft's), else Pilot's
 * recommendation. A pick on an earlier revision chooses nothing: the user
 * picks again. A decision that takes the user's own words preselects
 * nothing: an agent's suggestion is not an answer until the user picks it.
 */
export function chosen(decision: Decision): string {
	if (decision.sentOption) return decision.sentOption;
	const saved = decision.draft.pick;
	const picked = picks()[decision.id] ?? (saved ? { option: saved, revision: decision.revision } : undefined);
	if (picked) {
		if (picked.revision !== decision.revision) return "";
		if (decision.options.some((o) => o.id === picked.option)) return picked.option;
	}
	if (decision.reply) return "";
	const recommended = decision.options.find((o) => o.recommended) ?? decision.options[0];
	return recommended ? recommended.id : "";
}

/** One thing in Today's queue: a decision or an action. */
export type Item =
	| { kind: "decision"; id: string; decision: Decision }
	| { kind: "action"; id: string; action: HumanAction };

/** Everything that waits for the user, decisions first, each in Rust's order. */
export function queue(today: Today): Item[] {
	return [
		...today.decisions.map((decision): Item => ({ kind: "decision", id: decision.id, decision })),
		...today.actions.map((action): Item => ({ kind: "action", id: action.id, action })),
	];
}

/** The item in front: the one the user brought forward, else the first. */
export function front(today: Today): Item | undefined {
	const all = queue(today);
	return all.find((item) => item.id === focused()) ?? all[0];
}

/** Brings the item `step` places from the front forward, around the ends, and gives it the keyboard focus. */
export function move(today: Today, step: number) {
	const all = queue(today);
	const now = front(today);
	if (!now || all.length < 2) return;
	const at = all.findIndex((item) => item.id === now.id);
	const next = all[(at + step + all.length) % all.length];
	focused.set(next.id);
	focusFront.set(true);
}

/** Where each card's keyboard focus goes, by card id. The cards set it. */
export const anchors = new Map<string, () => ViewRef | undefined>();
