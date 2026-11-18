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
import { connectedConnectionControls } from "./connectionControls";
import { connectedDatabaseControls } from "./databaseControls";
import { type Day, mirrorDay } from "./day";
import { errorText, logEvent, setLogSink } from "./dayLog";
import { ConnectedDelivery, deliveryKey, mirrorDelivery, type VerificationSubject } from "./deliveryFeed";
import { deliveryTitles } from "./deliveryView";
import { connectedDiagnosisControls } from "./diagnosisControls";
import { ConnectedFeedback, mirrorFeedback } from "./feedbackFeed";
import { autoRead, FAILED_TRIES, retryDelay } from "./freshness";
import { ConnectedIntake, type IntakeMirror, mirrorIntake } from "./intakeFeed";
import { ConnectedLinear, mirrorLinear } from "./linearFeed";
import { connectedModelControls } from "./modelControls";
import { flushAll } from "./planCommands";
import { mirrorPlanning, type Plans } from "./planning";
import { pendingAnswers } from "./planView";
import { connectedPower } from "./power";
import { ConnectedPreferences, mirrorPreferences } from "./preferencesFeed";
import { settingsOpen } from "./preferencesView";
import { mirrorRituals, type Rituals, rootRecap } from "./ritualFeed";
import { connectedScheduleControls } from "./scheduleControls";
import { ConnectedSessionChat, mirrorSessionChat } from "./sessionChat";
import { connectedSlackControls } from "./slackControls";
import { ConnectedThreads, mirrorThreads } from "./threadFeed";
import { refreshOpenThread } from "./threadView";
import { ConnectedScope, mirrorScope, todayProject } from "./todayScope";
import type { Update } from "./updateFeed";
import { captureView, restoreView, saveForms } from "./windowState";

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
	if (!forms.saved) {
		logEvent("forms.unsaved", forms.message);
		return;
	}
	const drafts = await today.saveDrafts();
	await flushAll(plans);
	const waiting = pendingAnswers();
	if (!drafts) logEvent("forms.unsaved", "Today's drafts could not be saved.");
	if (waiting > 0) logEvent("forms.unsaved", `${waiting} interview answers could not be saved.`);
	if (!drafts || waiting > 0 || generation !== latestFlush || windowId() !== window) return;
	await call(window, "day.flush.ack", { generation, view: captureView(day.today()) });
}

// Pinned once. Read again never chooses another root, reopens feeds, or repeats
// startup calls. The native bridge checks this same identity on every call too.
const window = windowId();
if (window) setLogSink((event, message) => void call(window, "day.log.event", { event, message }));
let opening: Promise<void> | null = null;
let began = false;
let ritualFeed: ConnectedRituals | null = null;
let todayFeed: ConnectedToday | null = null;
let planFeed: ConnectedPlans | null = null;
let feedbackFeed: ConnectedFeedback | null = null;
let connectedFeeds: OpeningFeeds | null = null;
let pendingFlush: number | null = null;
/** The next automatic read after a passing failure, and how many failed in a row. */
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retries = 0;
let scopeReading = false;
let scopeAgain = false;

// Before admission the attempt owns partial construction. After admission the
// window keeps the same owner. Mirrors take ownership of their source exactly once.
class OpeningFeeds {
	readonly today: ConnectedToday;
	readonly plan: ConnectedPlans;
	intake: IntakeMirror | null = null;
	day: Day | null = null;
	plans: Plans | null = null;
	rituals: Rituals | null = null;
	update: Update | null = null;
	closed = false;

	constructor(today: ConnectedToday, plan: ConnectedPlans) {
		this.today = today;
		this.plan = plan;
	}

	close() {
		if (this.closed) return;
		this.closed = true;
		if (this.day) this.day.close();
		else {
			this.today.dispose();
			this.intake?.close();
		}
		if (this.plans) this.plans.close();
		else this.plan.dispose();
		this.rituals?.close();
		this.update?.close();
	}
}

/** Coalesce stream invalidations. No timer or service polling. */
async function refreshScope() {
	const open = connection();
	if (open.state === "open") open.day.scope?.invalidate();
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
	connectedFeeds?.close();
	connection.set({ state: "none", reason: unreadable("identity"), canRead: false });
	return false;
}

function refresh() {
	if (connection().state !== "open" || !current()) return;
	const open = connection();
	// These are cached native projections, not service/provider startup.
	void Promise.all([
		todayFeed?.refresh(),
		planFeed?.refresh(),
		ritualFeed?.sync(),
		feedbackFeed?.read(true),
		open.state === "open" ? open.day.chat?.source.refresh() : undefined,
		open.state === "open" && settingsOpen() ? open.day.connections?.read() : undefined,
		open.state === "open" ? open.day.databases?.read() : undefined,
		open.state === "open" ? open.day.power?.read() : undefined,
		open.state === "open" && settingsOpen() ? open.day.slack?.read() : undefined,
		// The thread on screen reads its newest messages again: a chat's reply changes no thread revision.
		open.state === "open" ? refreshOpenThread(open.day.threads) : undefined,
	]).catch((error: unknown) => {
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
		logEvent("forms.unsaved", errorText(error));
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
	const plan = new ConnectedPlans(window, setup.ok ? (setup.snapshot ?? null) : null, setup.ok ? null : setup.refusal);
	const feeds = new OpeningFeeds(today, plan);
	let admitted = false;
	try {
		// Every mission in planning, read once before Today shows, so a valid empty
		// list and one that could not be read never look alike. Later changes
		// arrive as invalidations and read the root's cached list.
		await plan.readInventory();
		if (!current()) return;
		// The selected project's requests, read once before Today shows, so an
		// unreadable page and having none never look alike. Rust picks the project.
		const intakeFeed = new ConnectedIntake(window);
		const intake = mirrorIntake(intakeFeed);
		feeds.intake = intake;
		await intakeFeed.read();
		if (!current()) return;
		// Requests started as standalone chats: their results join To check once
		// the chat says it is done. Their titles name them there.
		const started = (): VerificationSubject[] => {
			if (feeds.closed) return [];
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
			if (feeds.closed) return;
			if (next.started.length === starts) return;
			starts = next.started.length;
			void deliveryFeed.readSaved();
		});
		// Invalidations read only the root's cached Today. When its request
		// preview changed, the request pages are read once more; nothing is sent.
		let requests = JSON.stringify(first.snapshot.intake);
		today.onChange((next) => {
			if (feeds.closed) return;
			const now = JSON.stringify(next.intake);
			if (now === requests) return;
			requests = now;
			void intakeFeed.read();
		});
		// The saved Linear issues, the project's preferences, a mission's threads,
		// saved artifacts and a chat Pilot started are read only when their page
		// opens. Feedback also supplies Today's New section and follows the same
		// stream invalidations.
		const feedback = new ConnectedFeedback(window);
		void feedback.read();
		// Today's automatic service reads: after a failure, with backoff, and
		// when the window comes back. Today shows its last good read meanwhile.
		const freshness = autoRead(
			() => today.serviceRead(),
			first.snapshot.freshness.state === "live" ? Date.now() : null,
		);
		// Another project's read starts its own age: the previous one's never counts for it.
		let project = first.snapshot.project ?? "";
		const follow = (next: Today) => {
			if ((next.project ?? "") !== project) {
				project = next.project ?? "";
				freshness.restart(Date.now());
			}
			if (next.freshness.state === "live") freshness.current();
			else freshness.behind();
		};
		follow(first.snapshot);
		today.onChange(follow);
		const day = mirrorDay(today, {
			intake,
			delivery: mirrorDelivery(deliveryFeed),
			linear: mirrorLinear(new ConnectedLinear(window)),
			scope: mirrorScope(new ConnectedScope(window)),
			preferences: mirrorPreferences(new ConnectedPreferences(window)),
			threads: mirrorThreads(new ConnectedThreads(window)),
			feedback: mirrorFeedback(feedback),
			artifacts: new ConnectedArtifacts(window),
			chat: mirrorSessionChat(new ConnectedSessionChat(window)),
			freshness,
		});
		feeds.day = day;
		// New's projects are read when New opens; reading sends nothing.
		day.models = connectedModelControls(window);
		day.diagnosis = connectedDiagnosisControls(window);
		day.schedules = connectedScheduleControls(window);
		day.connections = connectedConnectionControls(window);
		day.databases = connectedDatabaseControls(window);
		void day.databases.refresh();
		day.power = connectedPower(window);
		void day.power.read();
		day.slack = connectedSlackControls(window, () => void intakeFeed.read());
		const plans = mirrorPlanning(plan, mirrorChats(new ConnectedChats(window)));
		feeds.plans = plans;
		const rituals = mirrorRituals(ritualFeed, rootRecap);
		feeds.rituals = rituals;
		const update = await connectedUpdates(window);
		feeds.update = update;
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
		connectedFeeds = feeds;
		todayFeed = today;
		planFeed = plan;
		feedbackFeed = feedback;
		admitted = true;
		connection.set({ state: "open", day, plans, rituals, update });
		flushPending();
		// Changes received while opening are not lost: read the cached views once
		// more after the feeds exist. This reads no service.
		refresh();
	} finally {
		if (!admitted) feeds.close();
	}
}

/**
 * A window that could not open for a passing reason (its service is down or
 * still starting) reads again on its own, with the shared backoff
 * (freshness.ts). For the first 3 tries it looks like opening; after that it
 * says why nothing shows, and keeps trying. Changes from the root are not used
 * for this: the window's own startup reads cause them, and a service that
 * becomes ready may send none.
 */
function retryLater() {
	const now = connection();
	if (now.state !== "none" || !now.canRead) {
		if (now.state === "open") retries = 0;
		return;
	}
	const delay = retryDelay(retries);
	retries += 1;
	if (retries <= FAILED_TRIES) connection.set({ state: "waiting" });
	if (retryTimer !== undefined) clearTimeout(retryTimer);
	retryTimer = setTimeout(() => {
		retryTimer = undefined;
		void read();
	}, delay);
}

function read(): Promise<void> {
	if (opening) return opening;
	// Once the window says why nothing shows, a background try keeps saying it.
	if (connection().state !== "none") connection.set({ state: "opening" });
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

/** Try now: reads at once. Automatic tries go on after it. */
export function readAgain(): Promise<void> {
	const now = connection();
	if (now.state !== "waiting" && (now.state !== "none" || !now.canRead)) return opening ?? Promise.resolve();
	if (retryTimer !== undefined) clearTimeout(retryTimer);
	retryTimer = undefined;
	return read();
}

void read();
