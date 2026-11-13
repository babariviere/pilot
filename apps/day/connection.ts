// The connected window's feeds: adapters over the exact JSON calls the
// window's native root registered (bridge.ts). Screen code cannot choose a
// service; without a root this window says so and never shows mock data.
// Kept in its own module, like session.ts, so edits to the screens never
// reopen the feeds.
import { host, signal } from "nsh";
import type { RitualSnapshot, SavedView, Setup, Today } from "pilot-day/native";
import { ConnectedArtifacts } from "./artifactReads";
import { ConnectedPlans, ConnectedRituals, ConnectedToday, call, type Refusal, windowId } from "./bridge";
import { ConnectedChats, mirrorChats } from "./chatFeed";
import { connectedUpdates } from "./connectedUpdates";
import { type Day, mirrorDay } from "./day";
import { ConnectedDelivery, deliveryKey, mirrorDelivery, type VerificationSubject } from "./deliveryFeed";
import { deliveryTitles } from "./deliveryView";
import { ConnectedIntake, mirrorIntake } from "./intakeFeed";
import { ConnectedLinear, mirrorLinear } from "./linearFeed";
import { flushAll } from "./planCommands";
import { mirrorPlanning, type Plans } from "./planning";
import { answerDrafts, answerPicks } from "./planView";
import { ConnectedPreferences, mirrorPreferences } from "./preferencesFeed";
import { mirrorRituals, type Rituals, rootRecap } from "./ritualFeed";
import { ConnectedThreads, mirrorThreads } from "./threadFeed";
import { ConnectedScope, mirrorScope } from "./todayScope";
import type { Update } from "./updateFeed";
import { captureView, restoreView, saveForms } from "./updateView";

/** Whether this window has its feeds yet, and which. */
export type Connection =
	| { state: "opening" }
	| { state: "none"; reason: string; canRead: boolean }
	| { state: "open"; day: Day; plans: Plans; rituals: Rituals; update: Update | null };

/** The window's connection. Recovery never replaces an open set of feeds. */
export const connection = signal<Connection>({ state: "opening" });

/** Why the first read failed, in one calm sentence. */
function unreadable(refusal: Refusal): string {
	switch (refusal) {
		case "offline":
			return "Pilot could not reach its service. Nothing is shown rather than a guess.";
		case "denied":
			return "This window may not read Pilot's service. Nothing is shown rather than examples.";
		case "identity":
			return "The Pilot service this window was opened for changed. Open Pilot again.";
		case "closed":
			return "This Pilot window is closing. Nothing more was read.";
		case "busy":
			return "Pilot is saving this window before a close or an update. Nothing more was read.";
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
	if (!drafts || waiting > 0 || generation !== latestFlush || windowId() !== window) return;
	await call(window, "day.flush.ack", { generation, view: captureView(day.today()) });
}

// Pinned once. Read again never chooses another root, reopens feeds, or repeats
// startup calls. The native bridge checks this same identity on every call too.
const window = windowId();
let opening: Promise<void> | null = null;
let began = false;
let ritualFeed: ConnectedRituals | null = null;
let todayFeed: ConnectedToday | null = null;
let planFeed: ConnectedPlans | null = null;
let pendingFlush: number | null = null;

function current(): boolean {
	if (window && windowId() === window) return true;
	connection.set({ state: "none", reason: unreadable("identity"), canRead: false });
	return false;
}

function refresh() {
	if (connection().state !== "open" || !current()) return;
	// These are cached native projections, not service/provider startup.
	void Promise.all([todayFeed?.refresh(), planFeed?.refresh(), ritualFeed?.sync()]).catch((error: unknown) => {
		console.error("Pilot could not read this window again:", error);
	});
}

function flushPending() {
	const open = connection();
	if (!window || !todayFeed || open.state !== "open" || pendingFlush === null || !current()) return;
	const generation = pendingFlush;
	pendingFlush = null;
	flushForms(window, generation, todayFeed, open.plans, open.day).catch((error: unknown) => {
		console.error("Day could not save its forms before a close or an update:", error);
	});
}

// Install exactly once, BEFORE any read can yield. Opening has no saved-view
// proof yet: keep the newest flush until the feeds/forms exist, never ACK empty.
if (window) {
	host.on("day.changed", (payload) => {
		if (forWindow(payload, window)) refresh();
	});
	host.on("day.flush", (payload) => {
		if (!forWindow(payload, window) || typeof payload.generation !== "number") return;
		if (!Number.isSafeInteger(payload.generation) || payload.generation <= latestFlush) return;
		latestFlush = payload.generation;
		pendingFlush = payload.generation;
		flushPending();
	});
}

async function connect() {
	if (!window) {
		connection.set({
			state: "none",
			reason: "This window was not opened for a Pilot service, so it shows nothing rather than examples.",
			canRead: false,
		});
		return;
	}
	if (!current()) return;
	if (!began) {
		began = true;
		// Asks the root to include what needs the user in its reads; it sends nothing.
		await call(window, "day.attention.read", {});
		if (!current()) return;
		// The start and end of day's saved progress, with the root's clock sample,
		// before Today shows its part of day. Passive: it records no visit. When
		// the root has no clock, its cached view says unavailable.
		const progress = await call<RitualSnapshot>(window, "day.ritual.read", {});
		if (!current()) return;
		ritualFeed = new ConnectedRituals(window, progress.ok ? progress.snapshot : null);
		if (!progress.ok) await ritualFeed.sync();
	}
	if (!current()) return;
	if (!ritualFeed) throw new Error("Missing window ritual feed");
	const first = await call<Today>(window, "day.today.read", {});
	if (!current()) return;
	if (!first.ok) {
		connection.set({
			state: "none",
			reason: unreadable(first.refusal),
			canRead: !["denied", "identity", "closed", "busy"].includes(first.refusal),
		});
		return;
	}
	const setup = await call<Setup | null>(window, "day.plan.prepare", {});
	if (!current()) return;
	const today = new ConnectedToday(window, first.snapshot);
	todayFeed = today;
	planFeed = new ConnectedPlans(window, setup.ok ? (setup.snapshot ?? null) : null, setup.ok ? null : setup.refusal);
	// Every mission in planning, read once before Today shows, so a valid empty
	// list and one that could not be read never look alike. Later changes
	// arrive as invalidations and read the root's cached list.
	await planFeed.readInventory();
	if (!current()) return;
	// The selected project's requests, read once before Today shows, so an
	// unreadable page and having none never look alike. Rust picks the project.
	const intakeFeed = new ConnectedIntake(window);
	await intakeFeed.read();
	if (!current()) return;
	const intake = mirrorIntake(intakeFeed);
	// Requests started as standalone chats: their results join To check once
	// the chat says it is done. Their titles name them there.
	const started = (): VerificationSubject[] => {
		const v = intake.view();
		if (!v.projectId) return [];
		const subjects: VerificationSubject[] = [];
		const titles: Record<string, string> = {};
		for (const op of v.started) {
			if (!op.sessionId) continue;
			const subject: VerificationSubject = { kind: "chat", projectId: v.projectId, sessionId: op.sessionId };
			subjects.push(subject);
			if (op.title) titles[deliveryKey(subject)] = op.title;
		}
		if (Object.keys(titles).length > 0) deliveryTitles.update((all) => ({ ...titles, ...all }));
		return subjects;
	};
	const deliveryFeed = new ConnectedDelivery(window, started);
	let starts = intake.view().started.length;
	intakeFeed.onChange((next) => {
		if (next.started.length === starts) return;
		starts = next.started.length;
		void deliveryFeed.readSaved();
	});
	// Invalidations read only the root's cached Today. When its request
	// preview changed, the request pages are read once more; nothing is sent.
	let requests = JSON.stringify(first.snapshot.intake);
	today.onChange((next) => {
		const now = JSON.stringify(next.intake);
		if (now === requests) return;
		requests = now;
		void intakeFeed.read();
	});
	// The saved Linear issues, the project's preferences, a mission's threads and
	// saved artifacts are read only when their page opens.
	const day = mirrorDay(
		today,
		intake,
		mirrorDelivery(deliveryFeed),
		mirrorLinear(new ConnectedLinear(window)),
		mirrorScope(new ConnectedScope(window)),
		mirrorPreferences(new ConnectedPreferences(window)),
		mirrorThreads(new ConnectedThreads(window)),
		new ConnectedArtifacts(window),
	);
	// New's projects are read when New opens; reading sends nothing.
	const plans = mirrorPlanning(planFeed, mirrorChats(new ConnectedChats(window)));
	const rituals = mirrorRituals(ritualFeed, rootRecap);
	const update = await connectedUpdates(window);
	if (!current()) return;
	// An actual updater successor uses its verified restore/ACK path. Ordinary
	// startup uses only this source's close capture, never a historical update ACK.
	if (!update?.service().restore) {
		const saved = await call<SavedView | null>(window, "day.window.read", {});
		if (!current()) return;
		if (!saved.ok) {
			// Do not admit forms or a close capture that could overwrite a draft
			// whose saved window we could not read. Recovery is a fresh open.
			connection.set({ state: "none", reason: unreadable(saved.refusal), canRead: false });
			return;
		}
		if (saved.snapshot) restoreView(saved.snapshot, undefined, day.today(), !!day.linear, !!day.preferences);
	}
	connection.set({ state: "open", day, plans, rituals, update });
	flushPending();
	// Changes received while opening are not lost: read the cached views once
	// more after the feeds exist. This reads no service.
	refresh();
}

function read(): Promise<void> {
	if (opening) return opening;
	connection.set({ state: "opening" });
	opening = connect()
		.catch(() => {
			// An unexpected startup failure is not permission to run setup again.
			connection.set({
				state: "none",
				reason: "Pilot could not open this window. Open Pilot again.",
				canRead: false,
			});
		})
		.finally(() => {
			opening = null;
		});
	return opening;
}

/** Explicit recovery of the failed first cached read, not a startup retry. */
export function readAgain(): Promise<void> {
	const now = connection();
	return now.state === "none" && now.canRead ? read() : (opening ?? Promise.resolve());
}

void read();
