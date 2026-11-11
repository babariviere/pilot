// The connected window's feeds: adapters over the exact JSON calls the
// window's native root registered (bridge.ts). Screen code cannot choose a
// service; without a root this window says so and never shows mock data.
// Kept in its own module, like session.ts, so edits to the screens never
// reopen the feeds.
import { host, signal } from "nsh";
import type { RitualSnapshot, Setup, Today } from "pilot-day/native";
import { ConnectedPlans, ConnectedRituals, ConnectedToday, call, type Refusal, windowId } from "./bridge";
import { connectedUpdates } from "./connectedUpdates";
import { type Day, mirrorDay } from "./day";
import { flushAll } from "./planCommands";
import { mirrorPlanning, type Plans } from "./planning";
import { answerDrafts, answerPicks } from "./planView";
import { mirrorRituals, type Rituals, rootRecap } from "./ritualFeed";
import type { Update } from "./updateFeed";
import { captureView, saveForms } from "./updateView";

/** Whether this window has its feeds yet, and which. */
export type Connection =
	| { state: "opening" }
	| { state: "none"; reason: string }
	| { state: "open"; day: Day; plans: Plans; rituals: Rituals; update: Update | null };

/** The window's connection. Only `connect` sets it. */
export const connection = signal<Connection>({ state: "opening" });

/** Why the first read failed, in one calm sentence. */
function unreadable(refusal: Refusal): string {
	switch (refusal) {
		case "offline":
			return "Pilot could not reach its service. Nothing is shown rather than a guess.";
		case "denied":
			return "This window may not read Pilot's service. Nothing is shown rather than examples.";
		case "identity":
			return "The Pilot service this window was opened for changed. Open Day again.";
		default:
			return "Pilot could not read its service. Nothing is shown rather than a guess.";
	}
}

/** The window's own envelope field, checked on every event. */
function forWindow(payload: unknown, window: string): payload is { version: 1; window: string; generation?: unknown } {
	const p = payload as { version?: unknown; window?: unknown } | null;
	return !!p && p.version === 1 && p.window === window;
}

/** The newest flush generation the root asked for. An older one is not answered. */
let latestFlush = -1;

/**
 * Saves every form, then tells the root they are saved for `generation`.
 * Without an answer for every save, it says nothing: the root's lifecycle
 * owner then never sees the forms as saved, and nothing is closed on a guess.
 * A request the root replaced while the saves ran is not answered either: its
 * answer would be stale, and the newer request answers for the same forms.
 */
async function flushForms(window: string, generation: number, today: ConnectedToday, plans: Plans, day: Day) {
	const forms = await saveForms(day, plans);
	if (!forms.saved) return;
	const drafts = await today.saveDrafts();
	await flushAll(plans);
	const waiting = Object.keys(answerDrafts()).length + Object.keys(answerPicks()).length;
	if (!drafts || waiting > 0 || generation !== latestFlush) return;
	await call(window, "day.flush.ack", { generation, view: captureView(day.today()) });
}

async function connect() {
	const window = windowId();
	if (!window) {
		connection.set({
			state: "none",
			reason: "This window was not opened for a Pilot service, so it shows nothing rather than examples.",
		});
		return;
	}
	// Asks the root to include what needs the user in its reads; it sends nothing.
	await call(window, "day.attention.read", {});
	// The start and end of day's saved progress, with the root's clock sample,
	// before Today shows its part of day. Passive: it records no visit. When
	// the root has no clock, its cached view says unavailable.
	const progress = await call<RitualSnapshot>(window, "day.ritual.read", {});
	const ritualFeed = new ConnectedRituals(window, progress.ok ? progress.snapshot : null);
	if (!progress.ok) await ritualFeed.sync();
	const first = await call<Today>(window, "day.today.read", {});
	if (!first.ok) {
		connection.set({ state: "none", reason: unreadable(first.refusal) });
		return;
	}
	const setup = await call<Setup | null>(window, "day.plan.prepare", {});
	const today = new ConnectedToday(window, first.snapshot);
	const planFeed = new ConnectedPlans(
		window,
		setup.ok ? (setup.snapshot ?? null) : null,
		setup.ok ? null : setup.refusal,
	);
	// Every mission in planning, read once before Today shows, so a valid empty
	// list and one that could not be read never look alike. Later changes
	// arrive as invalidations and read the root's cached list.
	await planFeed.readInventory();
	const day = mirrorDay(today);
	const plans = mirrorPlanning(planFeed);
	const rituals = mirrorRituals(ritualFeed, rootRecap);
	const update = await connectedUpdates(window);
	// An invalidation carries no data: read again, never poll.
	host.on("day.changed", (payload) => {
		if (!forWindow(payload, window)) return;
		void today.refresh();
		void planFeed.refresh();
		// The root's cached ritual view only: a fresh read samples the clock and
		// would invalidate again.
		void ritualFeed.sync();
	});
	host.on("day.flush", (payload) => {
		if (!forWindow(payload, window) || typeof payload.generation !== "number") return;
		latestFlush = payload.generation;
		// A failure sends no answer, so nothing closes on a guess; it is still said.
		flushForms(window, payload.generation, today, plans, day).catch((error: unknown) => {
			console.error("Day could not save its forms before a close or an update:", error);
		});
	});
	connection.set({ state: "open", day, plans, rituals, update });
	// A change the root sent while the first reads ran, before these listeners
	// existed, is not lost: read the cached views once more. This reads no service.
	void today.refresh();
	void planFeed.refresh();
	void ritualFeed.sync();
}

void connect();
