// State the screen owns: what the user is looking at and typing. Keyed by
// decision or action id, so it survives reordering, recycling and hot
// updates of the screens. Picks and unsent words also go to Rust as drafts
// (commands.ts), which saves them for the exact revision shown; after a
// restart the screen starts from those drafts.
import { effect, type Signal, signal, type ViewRef } from "nsh";
import type { Decision, HumanAction, Today } from "pilot-day/native";
import type { DeliveryEntry } from "../missions/delivery/deliveryFeed";
import type { IntakeRow } from "../missions/intake/intakeFeed";
import { closeThread } from "../sessions/threadView";
import { glide } from "../ui";

/** The help a decision card shows. */
export type Help = "simpler" | "more" | "visual" | "ask" | "details";

/** An option the user picked, and the decision's revision it was picked on. */
export type Pick = { option: string; revision: number };

/** The option the user picked, by decision. */
export const picks = signal<Record<string, Pick>>({});
/** Options the user picked on a question that takes several, and the revision they were picked on. */
export type Picks = { options: string[]; revision: number };
/** The options the user picked on questions that take several, by decision. */
export const ticks = signal<Record<string, Picks>>({});
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
/** Where the window's read models come from: the Pilot service its native root chose, or mock worlds. Only the test-only mock fixtures (mockFeeds.tsx) switch it to "mock". */
export const dataSource = signal<"mock" | "pilot">("pilot");
/** The mission whose Pause waits for the user's confirmation, if any. */
export const confirming = signal<string | null>(null);
/** The last message a control intent returned, by mission. */
export const controlMessages = signal<Record<string, string>>({});
/** The mission whose Archive waits for the user's confirmation, if any. */
export const archiving = signal<string | null>(null);
/**
 * Archive and Reopen as this window saw them, by mission. "archived" shows
 * the archived page with Reopen (Today drops the mission on its next read);
 * "unknown" waits for Check, which only reads the status again; "active"
 * keeps the normal page with the last message.
 */
export type Lifecycle = {
	title: string;
	state: "active" | "busy" | "archived" | "unknown";
	action: "archive" | "reopen";
	message: string;
};
export const lifecycles = signal<Record<string, Lifecycle>>({});
/**
 * A mission title as this window renames it, by mission. "editing" shows the
 * field with the user's words; "busy" waits for the one send; "unknown"
 * waits for Check, which only reads the mission again.
 */
export type Rename = {
	draft: string;
	state: "editing" | "busy" | "unknown";
	message: string;
};
export const renames = signal<Record<string, Rename>>({});

/** Sets or drops one mission's rename. */
export function setRename(id: string, rename: Rename | null) {
	renames.update((all) => {
		const next = { ...all };
		if (rename) next[id] = rename;
		else delete next[id];
		return next;
	});
}

/** Closes open title fields. A rename on its way or waiting for Check stays. */
function stopEditing() {
	const all = renames();
	if (Object.values(all).some((r) => r.state === "editing"))
		renames.set(Object.fromEntries(Object.entries(all).filter(([, r]) => r.state !== "editing")));
}

/**
 * Where the user was on Today when they opened a mission, its planning or
 * Changes: Today's scroll offset, and the row they opened (its test ID),
 * which takes the keyboard focus again when Today comes back. Plain values:
 * keeping them changes nothing on screen.
 */
export const todayPlace: { y: number; row: string | null } = { y: 0, row: null };

/**
 * A Today row that opens another screen. Pressing it keeps its place, and
 * when Today comes back the row takes the keyboard focus again. Returns the
 * row's anchor and what its press does.
 */
export function placeRow(testID: string, open: () => void) {
	const node = signal<ViewRef | null>(null);
	effect(() => {
		const n = node();
		if (n && todayPlace.row === testID) {
			todayPlace.row = null;
			n.focus();
		}
	});
	return {
		anchor: (n: ViewRef) => node.set(n),
		press: () => {
			todayPlace.row = testID;
			open();
		},
	};
}

/** Opens the overview of mission `id`. */
export function openMission(id: string) {
	confirming.set(null);
	archiving.set(null);
	stopEditing();
	// A mission opens on its overview, never on a thread left open earlier.
	closeThread();
	route.set(id);
}

/** Goes back to Today. */
export function closeMission() {
	confirming.set(null);
	archiving.set(null);
	stopEditing();
	closeThread();
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
	glide();
	setFor(help, id, open ? [...now, kind] : now);
}

/** Picks option `option` of `decision`, at the revision shown. */
export function pick(decision: Decision, option: string) {
	setFor(picks, decision.id, { option, revision: decision.revision });
}

/** Whether the user picked an option on an earlier revision of `decision`. That pick no longer counts. */
export function pickChanged(decision: Decision): boolean {
	if (decision.multiple) {
		const ticked = ticks()[decision.id];
		return decision.sentOptions.length === 0 && ticked !== undefined && ticked.revision !== decision.revision;
	}
	const picked = picks()[decision.id];
	return !decision.sentOption && picked !== undefined && picked.revision !== decision.revision;
}

/**
 * The option the card shows as chosen: what was sent, else the user's pick
 * on this revision (this run's, else the saved draft's), else Pilot's
 * recommendation. A pick on an earlier revision chooses nothing: the user
 * picks again. A decision that takes the user's own words preselects
 * nothing: an agent's suggestion is not an answer until the user picks it.
 * A question that takes several has no one chosen option; see `picked`.
 */
export function chosen(decision: Decision): string {
	if (decision.multiple) return "";
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

/**
 * The options picked on `decision`, which takes several, in the order shown:
 * what was sent, else this run's picks on this revision, else the saved
 * draft's. Picks on an earlier revision count for nothing, and nothing is
 * picked for the user: a suggestion is not an answer.
 */
export function picked(decision: Decision): string[] {
	if (decision.sentOptions.length > 0) return decision.sentOptions;
	const ticked = ticks()[decision.id];
	const ids = ticked ? (ticked.revision === decision.revision ? ticked.options : []) : decision.draft.picks;
	return decision.options.filter((o) => ids.includes(o.id)).map((o) => o.id);
}

/** Picks `option` on `decision`, which takes several, or unpicks it when it was picked. Picking is not answering. */
export function toggle(decision: Decision, option: string) {
	const now = picked(decision);
	const next = now.includes(option) ? now.filter((id) => id !== option) : [...now, option];
	setFor(ticks, decision.id, {
		options: decision.options.filter((o) => next.includes(o.id)).map((o) => o.id),
		revision: decision.revision,
	});
}

/** One thing in Today's queue: a decision or an action. */
/** A question or action from Rust's read. */
export type Work =
	| { kind: "decision"; id: string; decision: Decision }
	| { kind: "action"; id: string; action: HumanAction };

/** One card of Needs you: a question, an action, a result to check or a Slack request. */
export type Item =
	| Work
	| { kind: "result"; id: string; entry: DeliveryEntry }
	| { kind: "request"; id: string; row: IntakeRow };

/** Results the user put off in this window, oldest first. Local only: nothing is sent or saved. */
export const laterResults = signal<string[]>([]);

/** Puts result `key` after the other results waiting, in this window only. */
export function laterResult(key: string) {
	laterResults.set([...laterResults().filter((k) => k !== key), key]);
	releaseFront();
	focusFront.set(true);
}

/**
 * Everything that waits for the user: decisions, then actions, each in Rust's order, then the results to
 * check, those put off in this window last, then new requests, newest first.
 */
export function queue(today: Today): Work[];
export function queue(today: Today, results: DeliveryEntry[], requests?: IntakeRow[]): Item[];
export function queue(today: Today, results: DeliveryEntry[] = [], requests: IntakeRow[] = []): Item[] {
	const later = laterResults();
	const place = (e: DeliveryEntry) => {
		const n = later.indexOf(e.key);
		return n < 0 ? -1 : n;
	};
	const ordered = [...results].sort((a, b) => place(a) - place(b));
	return [
		...today.decisions.map((decision): Item => ({ kind: "decision", id: decision.id, decision })),
		...today.actions.map((action): Item => ({ kind: "action", id: action.id, action })),
		...ordered.map((entry): Item => ({ kind: "result", id: `result:${entry.key}`, entry })),
		...requests.map((row): Item => ({ kind: "request", id: `request:${row.request.id}`, row })),
	];
}

/**
 * The card the user started answering (a field took the focus). It stays in
 * front while it waits, so a new arrival or a read in another order never
 * swaps it for another card under the user's typing.
 */
const engaged = signal<string | null>(null);

/** The item in front: the one the user brought forward, else the one the user is answering, else the first. */
export function front(today: Today, results: DeliveryEntry[] = [], requests: IntakeRow[] = []): Item | undefined {
	const all = queue(today, results, requests);
	return all.find((item) => item.id === focused()) ?? all.find((item) => item.id === engaged()) ?? all[0];
}

/** The user started answering card `id`: it keeps the front while it waits. */
export function holdFront(id: string) {
	if (engaged() !== id) engaged.set(id);
}

/** Lets the first waiting item take the front again, as after Later. */
export function releaseFront() {
	engaged.set(null);
	focused.set(null);
}

/** Brings the item `step` places from the front forward, around the ends, and gives it the keyboard focus. */
export function move(today: Today, step: number, results: DeliveryEntry[] = [], requests: IntakeRow[] = []) {
	const all = queue(today, results, requests);
	const now = front(today, results, requests);
	if (!now || all.length < 2) return;
	const at = all.findIndex((item) => item.id === now.id);
	const next = all[(at + step + all.length) % all.length];
	glide();
	focused.set(next.id);
	focusFront.set(true);
}

/** Where each card's keyboard focus goes, by card id. The cards set it. */
export const anchors = new Map<string, () => ViewRef | undefined>();

type SavedTodayView = {
	focused: string;
	help?: string[];
	todayY?: number;
	todayRow?: string;
};

/** Today's disclosures and return position, without draft text owned by Rust. */
export function captureTodayView(): SavedTodayView {
	return {
		focused: focused() ?? "",
		help: Object.entries(help()).flatMap(([item, kinds]) => kinds.map((kind) => `${item}/${kind}`)),
		todayY: Math.max(0, todayPlace.y),
		todayRow: todayPlace.row ?? "",
	};
}

/** Restores the mission place without invoking its navigation actions. */
export function restoreMissionPlace(view: { place: import("pilot-day/native").SavedView["place"]; id: string }) {
	route.set(view.place === "mission" ? view.id : null);
}

/** Restores only valid disclosures; it never answers a decision. */
export function restoreTodayView(view: SavedTodayView) {
	focused.set(view.focused || null);
	const kinds: readonly Help[] = ["simpler", "more", "visual", "ask", "details"];
	const open: Record<string, Help[]> = {};
	for (const entry of view.help ?? []) {
		const at = entry.lastIndexOf("/");
		const kind = entry.slice(at + 1) as Help;
		if (at > 0 && kinds.includes(kind)) open[entry.slice(0, at)] = [...(open[entry.slice(0, at)] ?? []), kind];
	}
	help.set(open);
}

/** Restores Today's return position before scroll and field restoration. */
export function restoreTodayPosition(view: { todayY?: number; todayRow?: string }): number {
	todayPlace.y = Math.max(0, view.todayY ?? 0);
	todayPlace.row = view.todayRow || null;
	return todayPlace.y;
}

/** A fresh window clears view-local state; durable drafts return separately. */
export function resetTodayView() {
	picks.set({});
	help.set({});
	drafts.set({});
	replies.set({});
	reports.set({});
	messages.set({});
	asking.set({});
	controlMessages.set({});
	laterResults.set([]);
	releaseFront();
	route.set(null);
	confirming.set(null);
}
