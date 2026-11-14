// The connected window's feeds: adapters over the exact JSON calls the
// window's native root registered (bridge.ts). Screen code cannot choose a
// service; without a root this window says so and never shows mock data.
// Kept in its own module, like mockSession.ts, so edits to the screens never
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
import { ConnectedFeedback, mirrorFeedback } from "./feedbackFeed";
import { ConnectedIntake, mirrorIntake } from "./intakeFeed";
import { ConnectedLinear, mirrorLinear } from "./linearFeed";
import { flushAll } from "./planCommands";
import { mirrorPlanning, type Plans } from "./planning";
import { answerDrafts, answerPicks } from "./planView";
import { ConnectedPreferences, mirrorPreferences } from "./preferencesFeed";
import { mirrorRituals, type Rituals, rootRecap } from "./ritualFeed";
import { ConnectedThreads, mirrorThreads } from "./threadFeed";
import { ConnectedScope, mirrorScope, todayProject } from "./todayScope";
import type { Update } from "./updateFeed";
import { captureView, restoreView, saveForms } from "./updateView";

/** Whether this window has its feeds yet, and which. */
export type Connection =
	| { state: "opening" }
	/** A read failed for a passing reason; Pilot reads again on its own soon. */
	| { state: "waiting" }
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
/** The next automatic read after a passing failure, and its delay. */
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retries = 0;
/** 1 + 2 + 4 + 8 + 16 s: about 30 s, more than a service needs to start. */
const RETRIES = 5;
let scopeReading = false;
let scopeAgain = false;

/** Coalesce stream invalidations. No timer or service polling. */
async function refreshScope() {
	scopeAgain = true;
	if (scopeReading) return;
	scopeReading = true;
	try {
		while (scopeAgain) {
			scopeAgain = false;
			const open = connection();
			if (open.state !== "open" || !current()) return;
			await open.day.scope?.read(todayProject());
		}
	} finally {
		scopeReading = false;
	}
}

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
	void refreshScope().catch((error: unknown) => console.error("Pilot could not read its project scope:", error));
}

/** Answers a close for a window that never opened, with its saved view unchanged. */
async function closeUnopened(window: string, generation: number) {
	const saved = await call<SavedView | null>(window, "day.window.read", {});
	if (!saved.ok || generation !== latestFlush || windowId() !== window) return;
	await call(window, "day.flush.ack", { generation, view: saved.snapshot ?? captureView() });
}

function flushPending() {
	const open = connection();
	if (!window || pendingFlush === null || !current()) return;
	if (open.state === "none" || open.state === "waiting") {
		// No feeds or forms were opened, so there is nothing new to save. The
		// answer carries the window's last saved view back unchanged (or the
		// default view when none was saved), so no draft is lost. When the saved
		// view cannot be read, nothing is answered and the close is not proved.
		const generation = pendingFlush;
		pendingFlush = null;
		closeUnopened(window, generation).catch((error: unknown) => {
			console.error("Day could not answer a close while it shows no data:", error);
		});
		return;
	}
	if (!todayFeed || open.state !== "open") return;
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
	// The saved Linear issues, the project's preferences, a mission's threads,
	// the user's feedback and saved artifacts are read only when their page opens.
	const day = mirrorDay(
		today,
		intake,
		mirrorDelivery(deliveryFeed),
		mirrorLinear(new ConnectedLinear(window)),
		mirrorScope(new ConnectedScope(window)),
		mirrorPreferences(new ConnectedPreferences(window)),
		mirrorThreads(new ConnectedThreads(window)),
		mirrorFeedback(new ConnectedFeedback(window)),
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
			// whose saved window we could not read. Reading again opens afresh and
			// reads the saved window first. A service that is still starting
			// refuses for a moment, so a passing refusal can be read again.
			connection.set({
				state: "none",
				reason: unreadable(saved.refusal),
				canRead: !["denied", "identity", "closed", "busy"].includes(saved.refusal),
			});
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

/**
 * A window that could not open for a passing reason (its service is down or
 * still starting) waits and reads again on its own after 1 s, then 2, 4, 8 and
 * 16 s. Meanwhile it looks like opening: the warning shows only when Pilot will
 * not try again by itself. Changes from the root are not used for this: the
 * window's own startup reads cause them, and a service that becomes ready may
 * send none.
 */
function retryLater() {
	const now = connection();
	if (now.state !== "none" || !now.canRead || retries >= RETRIES) {
		if (now.state === "open") retries = 0;
		return;
	}
	const delay = 1000 * 2 ** retries;
	retries += 1;
	connection.set({ state: "waiting" });
	if (retryTimer !== undefined) clearTimeout(retryTimer);
	retryTimer = setTimeout(() => {
		retryTimer = undefined;
		void read();
	}, delay);
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
			retryLater();
			// A close asked for while opening is answered once the outcome is known.
			flushPending();
		});
	return opening;
}

/** Read Again: reads at once, with a fresh set of automatic tries. */
export function readAgain(): Promise<void> {
	const now = connection();
	if (now.state !== "waiting" && (now.state !== "none" || !now.canRead)) return opening ?? Promise.resolve();
	if (retryTimer !== undefined) clearTimeout(retryTimer);
	retryTimer = undefined;
	retries = 0;
	return read();
}

void read();
