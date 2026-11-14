// The connected window's adapter to its native root: exact-name JSON calls
// through NSH's host channel (docs/technical/day-public-bridge.md). Each
// call names this window and the native types' exact fields; Rust picks
// the service, checks authority and journals effects. A mutation whose
// reply is lost is Unknown and is never sent again: only Check looks it up.
// Invalidations carry no data; they only ask for a fresh read.
import { host } from "nsh";
import type {
	ActionCheck,
	ActionRef,
	AnswerIntent,
	AnswerRef,
	AskIntent,
	CompleteIntent,
	DecideIntent,
	DecisionRef,
	DraftIntent,
	IntentOutcome,
	InterviewRef,
	LifecycleIntent,
	MissionPage,
	MissionRef,
	NewIntent,
	OutcomeStatus,
	PauseIntent,
	PlanChat,
	Planning,
	PlanOutcome,
	PlanPage,
	PlanRow,
	ProgressIntent,
	RenameIntent,
	ReplyIntent,
	ResumeIntent,
	RitualSnapshot,
	RitualVisit,
	RitualWrite,
	Setup,
	StopReplanningIntent,
	SubmitIntent,
	Today,
} from "pilot-day/native";
import type { DayFeed, PlanningFeed } from "./feeds";
import { olderThanList } from "./planCurrent";
import { NO_PROGRESS, type RitualSource } from "./ritualFeed";

/** Why the root refused a call, or "lost" when no reply came. */
export type Refusal =
	| "identity"
	| "offline"
	| "unavailable"
	| "invalid"
	| "stale"
	| "storage"
	| "unknown"
	| "closed"
	| "busy"
	| "capacity"
	| "denied"
	| "lost";

/** `value` is the root's whole answer, for calls whose answer holds more than a snapshot and an outcome. */
export type Reply<T> =
	| { ok: true; snapshot: T; outcome: IntentOutcome | null; value: Record<string, unknown> }
	| { ok: false; refusal: Refusal };

const REFUSALS = new Set<string>([
	"identity",
	"offline",
	"unavailable",
	"invalid",
	"stale",
	"storage",
	"unknown",
	"closed",
	"busy",
	"capacity",
]);

/** This window's ID from its launch parameters, or null when no native root opened it. */
export function windowId(): string | null {
	const params = host.params as Record<string, unknown> | undefined;
	const day = params?.day as { version?: unknown; window?: unknown } | undefined;
	return day && day.version === 1 && typeof day.window === "string" && day.window !== "" ? day.window : null;
}

/** Whether this app installed the local native preview component, not an access grant. */
export function artifactPreviewsAvailable(): boolean {
	const day = (host.params as { day?: { artifactPreview?: unknown } } | undefined)?.day;
	return day?.artifactPreview === true;
}

/** One exact call. It never throws; a lost reply is "lost", never a refusal. */
export async function call<T>(window: string, name: string, args: unknown): Promise<Reply<T>> {
	let reply: unknown;
	try {
		// No deadline: the root always answers or closes the channel, and a
		// timeout would turn an entered effect into a guess.
		reply = await host.call(name, { version: 1, window, args }, { timeout: 0 });
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		// A denied or missing method never reached the root: nothing happened.
		const notSent =
			code === "ERR_ACCESS_DENIED" ||
			code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" ||
			code === "ERR_NSH_HOST_ERROR";
		return { ok: false, refusal: notSent ? "denied" : "lost" };
	}
	const r = reply as { version?: unknown; value?: { snapshot?: unknown; outcome?: unknown }; error?: unknown } | null;
	if (r && r.version === 1 && r.value && typeof r.value === "object") {
		return {
			ok: true,
			snapshot: r.value.snapshot as T,
			outcome: (r.value.outcome ?? null) as IntentOutcome | null,
			value: r.value as Record<string, unknown>,
		};
	}
	if (r && r.version === 1 && typeof r.error === "string" && REFUSALS.has(r.error)) {
		return { ok: false, refusal: r.error as Refusal };
	}
	return { ok: false, refusal: "invalid" };
}

/** What a refused or lost mutation means for the user, in one sentence. */
export function refusalOutcome(refusal: Refusal, revision: number): IntentOutcome {
	const outcome = (status: OutcomeStatus, message: string): IntentOutcome => ({ status, revision, message });
	switch (refusal) {
		case "unknown":
		case "lost":
			return outcome(
				"unknown",
				"Pilot sent this but heard nothing back. It will not send it again; Check again only reads.",
			);
		case "stale":
			return outcome("stale", "This changed since you read it. Nothing was sent; your words stay.");
		case "busy":
			return outcome("rejected", "Pilot is saving your work before it closes. Nothing was sent; try again after.");
		case "closed":
			return outcome("rejected", "Pilot is closing. Nothing was sent.");
		case "offline":
			return outcome("rejected", "Pilot could not reach its service. Nothing was sent.");
		case "identity":
			return outcome("rejected", "The Pilot service changed. Open Day again to go on. Nothing was sent.");
		case "unavailable":
		case "denied":
			return outcome("rejected", "This is not available here yet. Nothing was sent.");
		default:
			return outcome("rejected", "Pilot could not send this. Nothing was sent; your words stay.");
	}
}

/** How long typed drafts rest before they are saved. */
const DRAFT_AFTER_MS = 700;

/** Today over the root: the latest read, this run's Later order and sends on their way. */
export class ConnectedToday implements DayFeed {
	#window: string;
	#today: Today;
	#missions = new Map<string, MissionPage | null>();
	#later: string[] = [];
	#sending = new Set<string>();
	#drafts = new Map<string, DraftIntent>();
	#draftTimer: ReturnType<typeof setTimeout> | undefined;
	#saving: Promise<boolean> = Promise.resolve(true);
	#listeners = new Map<number, (today: Today) => void>();
	#next = 0;
	#reading: Promise<void> | null = null;
	#readVersion = 0;
	#again = false;

	constructor(window: string, first: Today) {
		this.#window = window;
		this.#today = first;
	}

	snapshot(): Today {
		const t = this.#today;
		const later = this.#later.filter((id) => t.decisions.some((d) => d.id === id));
		const rank = (id: string) => later.indexOf(id);
		const decisions = [...t.decisions]
			.sort((a, b) => rank(a.id) - rank(b.id))
			.map((d) => (this.#sending.has(d.id) && d.delivery === "idle" ? { ...d, delivery: "sending" as const } : d));
		const actions = t.actions.map((a) =>
			this.#sending.has(a.id) && a.delivery === "idle" ? { ...a, delivery: "sending" as const } : a,
		);
		return { ...t, decisions, actions };
	}

	onChange(listener: (today: Today) => void): () => void {
		const id = this.#next++;
		this.#listeners.set(id, listener);
		return () => {
			this.#listeners.delete(id);
		};
	}

	#publish() {
		const today = this.snapshot();
		for (const listener of this.#listeners.values()) listener(today);
	}

	#take(today: Today | null | undefined) {
		if (today && typeof today === "object") this.#today = today;
		this.#publish();
	}

	/** Reads Today again after an invalidation. Bursts collapse into one more read. */
	refresh(): Promise<void> {
		this.#readVersion += 1;
		// The shown read stays until the next one lands. Marking it stale on
		// every notice repainted Today on each daemon event (flicker). Rust
		// says when a read is really stale or failed, and every action is
		// checked again natively before it is sent.
		if (this.#reading) {
			this.#again = true;
			return this.#reading;
		}
		this.#reading = (async () => {
			do {
				this.#again = false;
				const version = this.#readVersion;
				const r = await call<Today>(this.#window, "day.today.read", {});
				if (version !== this.#readVersion) continue;
				if (r.ok) this.#take(r.snapshot);
				else {
					const reason = "Pilot could not read this window again. Showing the earlier read.";
					this.#take({
						...this.#today,
						freshness: { ...this.#today.freshness, state: "stale", reason },
						attention: { ...this.#today.attention, state: "stale", reason },
					});
				}
			} while (this.#again);
		})().finally(() => {
			this.#reading = null;
		});
		return this.#reading;
	}

	mission(missionId: string): MissionPage | null {
		return this.#missions.get(missionId) ?? null;
	}

	async openMission(intent: MissionRef): Promise<IntentOutcome> {
		const r = await call<MissionPage | null>(this.#window, "day.mission.read", intent);
		if (!r.ok) {
			this.#publish();
			return {
				status: "rejected",
				revision: this.#today.revision,
				message: "Pilot could not read this mission again. What was read before stays on screen.",
			};
		}
		this.#missions.set(intent.missionId, r.snapshot ?? null);
		this.#publish();
		return r.outcome ?? { status: "accepted", revision: this.#today.revision, message: "" };
	}

	/** Sends one mutation, marks its item as sending meanwhile, and reads again after a refusal. */
	async #send(item: string, name: string, args: unknown): Promise<IntentOutcome> {
		this.#sending.add(item);
		this.#publish();
		const r = await call<Today>(this.#window, name, args);
		this.#sending.delete(item);
		if (r.ok) {
			this.#take(r.snapshot);
			return r.outcome ?? { status: "accepted", revision: this.#today.revision, message: "" };
		}
		// The read shows a lost send as Unknown; it never resends.
		void this.refresh();
		return refusalOutcome(r.refusal, this.#today.revision);
	}

	decide(intent: DecideIntent): Promise<IntentOutcome> {
		return this.reply({
			decisionId: intent.decisionId,
			revision: intent.revision,
			optionId: intent.optionId,
			optionIds: [],
			text: "",
		});
	}

	reply(intent: ReplyIntent): Promise<IntentOutcome> {
		return this.#send(intent.decisionId, "day.attention.reply", intent);
	}

	saveDraft(intent: DraftIntent): IntentOutcome {
		this.#drafts.set(intent.itemId, intent);
		if (this.#draftTimer !== undefined) clearTimeout(this.#draftTimer);
		this.#draftTimer = setTimeout(() => {
			this.#draftTimer = undefined;
			void this.saveDrafts();
		}, DRAFT_AFTER_MS);
		return { status: "accepted", revision: this.#today.revision, message: "" };
	}

	flushDrafts(): void {
		void this.saveDrafts();
	}

	/** Saves every waiting draft, one at a time. Resolves true once each was saved, false if any was not. */
	saveDrafts(): Promise<boolean> {
		if (this.#draftTimer !== undefined) clearTimeout(this.#draftTimer);
		this.#draftTimer = undefined;
		const run = this.#saving.then(async () => {
			let saved = true;
			while (this.#drafts.size > 0) {
				const [id, draft] = this.#drafts.entries().next().value as [string, DraftIntent];
				const r = await call<Today>(this.#window, "day.attention.draft", draft);
				if (r.ok) {
					if (this.#drafts.get(id) === draft) this.#drafts.delete(id);
					this.#take(r.snapshot);
				} else {
					// Keep the exact failed local draft. A later empty flush must
					// not turn a failed save into an all-form persistence ACK.
					saved = false;
					break;
				}
			}
			return saved;
		});
		this.#saving = run;
		return run;
	}

	openLink(_intent: ActionRef): Promise<IntentOutcome> {
		return Promise.resolve({
			status: "rejected",
			revision: this.#today.revision,
			message: "Pilot cannot open links here. Copy the link instead; this reports nothing.",
		});
	}

	/** Moves a decision after the others in this window. The Later itself is saved with its draft (commands.ts). */
	later(intent: DecisionRef): IntentOutcome {
		this.#later = [...this.#later.filter((id) => id !== intent.decisionId), intent.decisionId];
		this.#publish();
		return { status: "accepted", revision: this.#today.revision, message: "" };
	}

	check(intent: DecisionRef): Promise<IntentOutcome> {
		return this.#send(intent.decisionId, "day.attention.check", { id: intent.decisionId, action: false });
	}

	ask(_intent: AskIntent): Promise<IntentOutcome> {
		return Promise.resolve(refusalOutcome("unavailable", this.#today.revision));
	}

	checkAnswer(_intent: AnswerRef): Promise<IntentOutcome> {
		return Promise.resolve(refusalOutcome("unavailable", this.#today.revision));
	}

	saveProgress(intent: ProgressIntent): Promise<IntentOutcome> {
		const action = { actionId: intent.actionId, revision: intent.revision };
		return this.#send(intent.actionId, "day.attention.action", { action, ask: "progress", text: intent.progress });
	}

	actionLater(intent: ActionRef): Promise<IntentOutcome> {
		return this.#send(intent.actionId, "day.attention.action", { action: intent, ask: "later", text: "" });
	}

	complete(intent: CompleteIntent): Promise<IntentOutcome> {
		const action = { actionId: intent.actionId, revision: intent.revision };
		return this.#send(intent.actionId, "day.attention.action", { action, ask: "complete", text: intent.report });
	}

	checkAction(intent: ActionCheck): Promise<IntentOutcome> {
		return this.#send(intent.actionId, "day.attention.check", { id: intent.actionId, action: true });
	}

	/** Pause, Resume and Check name the mission; the outcome says what the service did, then both reads follow. */
	async #control(missionId: string, name: string, args: unknown): Promise<IntentOutcome> {
		const r = await call<null>(this.#window, name, args);
		await Promise.all([this.refresh(), this.openMission({ missionId })]);
		if (!r.ok) return refusalOutcome(r.refusal, this.#today.revision);
		return r.outcome ?? { status: "accepted", revision: this.#today.revision, message: "" };
	}

	pause(intent: PauseIntent): Promise<IntentOutcome> {
		return this.#control(intent.missionId, "day.mission.pause", intent);
	}

	resume(intent: ResumeIntent): Promise<IntentOutcome> {
		return this.#control(intent.missionId, "day.mission.resume", intent);
	}

	checkControl(intent: MissionRef): Promise<IntentOutcome> {
		return this.#control(intent.missionId, "day.mission.check", intent);
	}

	stopReplanning(intent: StopReplanningIntent): Promise<IntentOutcome> {
		return this.#control(intent.missionId, "day.mission.stopReplanning", intent);
	}

	/** Archive and Reopen name only the mission; the root builds the request. Today is read again after. */
	async #lifecycle(name: string, intent: LifecycleIntent): Promise<IntentOutcome> {
		const r = await call<null>(this.#window, name, intent);
		await this.refresh();
		if (!r.ok) return refusalOutcome(r.refusal, this.#today.revision);
		return r.outcome ?? { status: "accepted", revision: this.#today.revision, message: "" };
	}

	archive(intent: LifecycleIntent): Promise<IntentOutcome> {
		return this.#lifecycle("day.mission.archive", intent);
	}

	reopen(intent: LifecycleIntent): Promise<IntentOutcome> {
		return this.#lifecycle("day.mission.reopen", intent);
	}

	/** Rename names the mission and the words; the root checks and sends them. Today and the page are read again after. */
	rename(intent: RenameIntent): Promise<IntentOutcome> {
		return this.#control(intent.missionId, "day.mission.rename", intent);
	}

	pulse(_everyMs?: number | null, _count?: number | null): Promise<number> {
		return Promise.resolve(0);
	}

	dispose(): void {
		if (this.#draftTimer !== undefined) clearTimeout(this.#draftTimer);
		this.#listeners.clear();
	}
}

const NO_SETUP: Setup = { project: "", model: "", access: "", digest: "", unconfirmed: false };

/**
 * The start and end of day's saved progress over the root. Reads sample the
 * root's clock and write nothing; a visit or save sends the exact context and
 * revision once. After any refusal the root's last confirmed view is read
 * again from its cache, which samples, writes and invalidates nothing.
 */
export class ConnectedRituals implements RitualSource {
	#window: string;
	#view: RitualSnapshot;
	#listeners = new Map<number, (view: RitualSnapshot) => void>();
	#next = 0;

	constructor(window: string, first: RitualSnapshot | null) {
		this.#window = window;
		this.#view = first ?? NO_PROGRESS;
	}

	snapshot(): RitualSnapshot {
		return this.#view;
	}

	onChange(listener: (view: RitualSnapshot) => void): () => void {
		const id = this.#next++;
		this.#listeners.set(id, listener);
		return () => {
			this.#listeners.delete(id);
		};
	}

	#take(view: RitualSnapshot | null | undefined) {
		if (view && typeof view === "object") this.#view = view;
		for (const listener of this.#listeners.values()) listener(this.#view);
	}

	/** The root's last confirmed view, from its cache. Run after an invalidation. */
	async sync(): Promise<void> {
		const r = await call<RitualSnapshot>(this.#window, "day.ritual.snapshot", {});
		if (r.ok) this.#take(r.snapshot);
	}

	async #call(name: string, args: unknown, write: boolean): Promise<IntentOutcome> {
		const r = await call<RitualSnapshot>(this.#window, name, args);
		if (r.ok) {
			this.#take(r.snapshot);
			return r.outcome ?? { status: "accepted", revision: this.#view.revision, message: "" };
		}
		await this.sync();
		// A read that got no answer changed nothing; only a write's lost answer is Unknown.
		if (!write && r.refusal === "lost") return refusalOutcome("unavailable", this.#view.revision);
		return refusalOutcome(r.refusal, this.#view.revision);
	}

	refresh(): Promise<IntentOutcome> {
		return this.#call("day.ritual.read", {}, false);
	}

	refreshResults(): Promise<IntentOutcome> {
		return this.#call("day.ritual.results", {}, false);
	}

	visit(intent: RitualVisit): Promise<IntentOutcome> {
		return this.#call("day.ritual.visit", { context: intent.context, revision: intent.revision }, true);
	}

	save(intent: RitualWrite): Promise<IntentOutcome> {
		const { context, revision, ritual, mark, step } = intent;
		return this.#call("day.ritual.save", { context, revision, ritual, mark, step }, true);
	}

	dispose(): void {
		this.#listeners.clear();
	}
}

/** Says a planning page is older than the latest read, as Rust says it for its own pages. */
const OLDER = "This is an older read. Pilot checks again before it saves anything.";

/**
 * The missions in planning as the root last read them. Complete earlier
 * rows can be stale display data; an unavailable read is never an empty list.
 * `at` orders it among this window's reads.
 */
type Inventory =
	| { state: "live" | "stale"; rows: PlanRow[]; at: number; reason: string }
	| { state: "off"; refusal: Refusal };

/** Why the missions in planning are not shown, in one calm sentence. */
export function inventoryReason(refusal: Refusal): string {
	switch (refusal) {
		case "capacity":
			return "More missions are in planning than one read holds, so Pilot shows none of them.";
		case "stale":
			return "They changed while Pilot read them.";
		case "offline":
			return "Pilot could not reach its service.";
		case "identity":
			return "The Pilot service changed. Open Day again to see them.";
		case "closed":
		case "busy":
			return "Pilot is closing.";
		default:
			return "Pilot could not read them.";
	}
}

/** A complete inventory read: every row names its current interview. Anything else is refused. */
function inventoryRows(planning: Planning | null | undefined): PlanRow[] | null {
	if (!planning || typeof planning !== "object" || !["live", "stale"].includes(planning.availability)) return null;
	if (!Array.isArray(planning.plans)) return null;
	return planning.plans.every((p) => p && typeof p.missionId === "string" && p.identity) ? planning.plans : null;
}

/** Planning over the root: the setup, every mission in planning, the pages opened here and saves on their way. */
export class ConnectedPlans implements PlanningFeed {
	#window: string;
	#setup: Setup | null;
	#setupRead = 0;
	#newUnknown = false;
	#selected: string | null = null;
	#pages = new Map<string, PlanPage>();
	/** When each page was read, in this window's read order. */
	#pageAt = new Map<string, number>();
	/** Pages a change may have made older, until they are read again. */
	#older = new Set<string>();
	#inventory: Inventory = { state: "off", refusal: "unavailable" };
	#inventoryReading: Promise<void> | null = null;
	#inventoryVersion = 0;
	#refreshing: Promise<void> | null = null;
	#refreshVersion = 0;
	#again = false;
	#reads = 0;
	#saving = new Set<string>();
	#revision = 0;
	#listeners = new Map<number, (planning: Planning) => void>();
	#next = 0;
	/** The open planning chat, by mission. Only one is open at a time. */
	#chats = new Map<string, PlanChat>();
	#chatOpen: string | null = null;

	constructor(window: string, setup: Setup | null, refusal: Refusal | null = null) {
		this.#window = window;
		this.#setup = setup;
		this.#newUnknown = refusal === "unknown";
	}

	snapshot(): Planning {
		const setup = this.#setup;
		const inventory = this.#inventory;
		return {
			revision: this.#revision,
			availability: inventory.state === "off" ? "unavailable" : inventory.state,
			reason: inventory.state === "off" ? inventoryReason(inventory.refusal) : inventory.reason,
			setup: setup ?? NO_SETUP,
			// An unconfirmed creation can be checked; it never blocks a new one.
			canCreate: setup !== null,
			createReason: this.#newUnknown
				? "An earlier mission creation is not confirmed. Check it, or plan a new one anyway."
				: setup
					? ""
					: "This Pilot service has no planning setup for new missions here.",
			canStart: false,
			// Standalone chats start through New's project choice (chatFeed.ts), not this feed.
			startReason: "",
			plans: inventory.state === "off" ? [] : inventory.rows,
			started: [],
		};
	}

	onChange(listener: (planning: Planning) => void): () => void {
		const id = this.#next++;
		this.#listeners.set(id, listener);
		return () => {
			this.#listeners.delete(id);
		};
	}

	#publish() {
		this.#revision += 1;
		const planning = this.snapshot();
		for (const listener of this.#listeners.values()) listener(planning);
	}
	#starting = new Set<string>();
	#unknownStarts = new Set<string>();

	#take(missionId: string, page: PlanPage | null | undefined) {
		if (page && typeof page === "object") {
			this.#pages.set(missionId, page);
			this.#pageAt.set(missionId, ++this.#reads);
			this.#older.delete(missionId);
		}
		this.#publish();
	}

	/** Keeps a complete read; a refusal drops every row. A cached read that is not current keeps the earlier reason. */
	#takeInventory(r: Reply<Planning>) {
		const rows = r.ok ? inventoryRows(r.snapshot) : null;
		if (rows && r.ok)
			this.#inventory = {
				state: r.snapshot.availability === "stale" ? "stale" : "live",
				rows,
				at: ++this.#reads,
				reason: r.snapshot.reason ?? "",
			};
		else if (!r.ok) this.#inventory = { state: "off", refusal: r.refusal };
		else if (this.#inventory.state !== "off") this.#inventory = { state: "off", refusal: "unavailable" };
		this.#publish();
	}

	/**
	 * Asks the root to read every mission in planning from its service.
	 * Passive: it answers, saves and starts nothing. Runs at open and on Read again.
	 */
	readInventory(): Promise<void> {
		if (this.#inventoryReading) return this.#inventoryReading;
		const version = ++this.#inventoryVersion;
		this.#inventoryReading = (async () => {
			const reply = await call<Planning>(this.#window, "day.plan.inventory", {});
			if (version === this.#inventoryVersion || (!reply.ok && this.#inventory.state === "off")) {
				// A read's own notice can deliver its unavailable cache first.
				// Keep the exact refusal, but never replace newer valid rows.
				this.#takeInventory(reply);
			}
		})().finally(() => {
			this.#inventoryReading = null;
		});
		return this.#inventoryReading;
	}

	/** Whether reading the list again could help. Not after the service changed or while Pilot closes. */
	canReadInventory(): boolean {
		const inventory = this.#inventory;
		return inventory.state !== "off" || !["identity", "closed", "busy"].includes(inventory.refusal);
	}

	/**
	 * The mission whose read page shows interview `interviewId`: where a save,
	 * submission or check of it belongs, whichever mission is open now. Null
	 * when no read page, or more than one, shows it.
	 */
	#missionOf(interviewId: string): string | null {
		const owners = [...this.#pages.entries()].filter(([, page]) => page.interview?.id === interviewId);
		return owners.length === 1 ? owners[0][0] : null;
	}

	/**
	 * Whether a page is still what the latest reads say. A page is older when
	 * a change reached it and it was not read again, or when a later inventory
	 * names a newer interview revision or round than the page shows. An
	 * inventory that only lags behind a newer page read does not age it.
	 */
	#current(missionId: string, page: PlanPage): boolean {
		if (this.#older.has(missionId) || !page.fresh) return false;
		const inventory = this.#inventory;
		if (inventory.state !== "live" || inventory.at < (this.#pageAt.get(missionId) ?? 0)) return true;
		return !olderThanList(
			page,
			inventory.rows.find((p) => p.missionId === missionId),
		);
	}

	page(missionId: string): PlanPage | null {
		const read = this.#pages.get(missionId);
		if (!read) return null;
		// The older-read words come first, so a page with its own note still says it is older.
		let page = this.#current(missionId, read)
			? read
			: { ...read, fresh: false, note: read.note ? `${OLDER} ${read.note}` : OLDER };
		if (page.work)
			page = {
				...page,
				work: {
					...page.work,
					canStart:
						page.fresh &&
						page.work.canStart &&
						!this.#starting.has(missionId) &&
						!this.#unknownStarts.has(missionId),
					canCheck: page.work.canCheck || this.#unknownStarts.has(missionId),
				},
			};
		const iv = page.interview;
		if (!iv || this.#saving.size === 0) return page;
		const questions = iv.questions.map((q) =>
			this.#saving.has(`${iv.id}/${q.id}`) ? { ...q, saving: "sending" as const } : q,
		);
		return { ...page, interview: { ...iv, questions } };
	}

	/** Reads the setup for New again: passive, it creates nothing. */
	async prepare(): Promise<void> {
		await this.prepareNew();
	}

	/** Reads setup only. Pending creation stays lookup-only, including after reopen. */
	async prepareNew(): Promise<PlanOutcome> {
		const version = ++this.#setupRead;
		this.#setup = null;
		this.#publish();
		const r = await call<Setup | null>(this.#window, "day.plan.prepare", {});
		if (version !== this.#setupRead) return this.#refused("stale", null);
		if (r.ok) {
			this.#setup = r.snapshot ?? null;
			this.#newUnknown = r.snapshot?.unconfirmed === true;
		} else {
			this.#setup = null;
			// A lost passive setup read cannot itself have created a mission.
			if (r.refusal === "unknown") this.#newUnknown = true;
		}
		this.#publish();
		return r.ok ? this.#outcome(r.outcome, null) : this.#refused(r.refusal, null);
	}

	canCheckNew(): boolean {
		return this.#newUnknown;
	}

	/** Checks the root's exact saved enrollment. Never resends the goal. */
	async checkNew(): Promise<PlanOutcome> {
		const r = await call<{ missionId: string; page: PlanPage | null } | null>(this.#window, "day.plan.checkNew", {});
		if (!r.ok) return this.#refused(r.refusal, null);
		if (r.outcome?.status === "accepted" || r.outcome?.status === "rejected") this.#newUnknown = false;
		const made = r.snapshot;
		if (r.outcome?.status === "accepted" && made) {
			this.#selected = made.missionId;
			this.#take(made.missionId, made.page);
		}
		this.#publish();
		void this.prepare();
		return this.#outcome(r.outcome, r.outcome?.status === "accepted" ? (made?.missionId ?? null) : null);
	}

	/** Dismisses unconfirmed creations on New. It sends nothing to the service. */
	async dismissNew(): Promise<PlanOutcome> {
		const r = await call<null>(this.#window, "day.plan.dismissNew", {});
		if (!r.ok) return this.#refused(r.refusal, null);
		this.#newUnknown = false;
		this.#publish();
		void this.prepare();
		return this.#outcome(r.outcome, null);
	}

	/**
	 * After an invalidation: the root's latest inventory, then the opened
	 * mission's planning. Both are cached reads, so they cause no further
	 * invalidation. Pages not read again are older from now on. Bursts
	 * collapse into one more read.
	 */
	refresh(): Promise<void> {
		// The open page is read again below; other pages are marked older
		// there. Not marking the open page first keeps it from flickering.
		this.#refreshVersion += 1;
		this.#inventoryVersion += 1;
		if (this.#refreshing) {
			this.#again = true;
			return this.#refreshing;
		}
		this.#refreshing = (async () => {
			do {
				this.#again = false;
				await this.#readCached();
			} while (this.#again);
		})().finally(() => {
			this.#refreshing = null;
		});
		return this.#refreshing;
	}

	async #readCached(): Promise<void> {
		const version = this.#refreshVersion;
		const id = this.#selected;
		for (const missionId of this.#pages.keys()) if (missionId !== id) this.#older.add(missionId);
		const inventory = await call<Planning>(this.#window, "day.plan.inventorySnapshot", {});
		if (version !== this.#refreshVersion) return;
		this.#takeInventory(inventory);
		if (!id) return;
		const r = await call<PlanPage>(this.#window, "day.plan.snapshot", { missionId: id });
		if (this.#selected !== id || version !== this.#refreshVersion) return;
		if (r.ok) this.#take(id, r.snapshot);
		else {
			this.#older.add(id);
			this.#publish();
		}
		// The open chat, as the root last read it with this page.
		if (this.#chatOpen !== id) return;
		const chat = await call<PlanChat | null>(this.#window, "day.plan.chatSnapshot", { missionId: id });
		if (this.#chatOpen !== id || !chat.ok || !chat.snapshot) return;
		this.#chats.set(id, chat.snapshot);
		this.#publish();
	}

	#outcome(o: IntentOutcome | null, missionId: string | null): PlanOutcome {
		return {
			status: o?.status ?? "accepted",
			revision: this.#revision,
			message: o?.message ?? "",
			missionId,
		};
	}

	#refused(refusal: Refusal, missionId: string | null): PlanOutcome {
		const o = refusalOutcome(refusal, this.#revision);
		return { status: o.status, revision: this.#revision, message: o.message, missionId };
	}

	async readSource(
		request: import("./mapSourceContract").MapSourceRequest,
	): Promise<import("./mapSourceContract").MapSourceRead> {
		const r = await call<import("./mapSourceContract").MapSourceDetail>(this.#window, "day.plan.source", request);
		return r.ok ? { status: "available", detail: r.snapshot } : { status: "unavailable" };
	}

	async open(missionId: string): Promise<PlanOutcome> {
		this.#selected = missionId;
		// Navigation does not renew a cached page. Until this read succeeds,
		// its answers and Start must not look current even without a notice.
		this.#older.add(missionId);
		this.#publish();
		const r = await call<PlanPage>(this.#window, "day.plan.read", { missionId });
		if (!r.ok) {
			return {
				status: "rejected",
				revision: this.#revision,
				message: "Pilot could not read this mission's planning. What was read before stays on screen.",
				missionId,
			};
		}
		this.#take(missionId, r.snapshot);
		return this.#outcome(r.outcome?.status === "accepted" ? r.outcome : null, missionId);
	}

	async plan(intent: NewIntent): Promise<PlanOutcome> {
		const r = await call<{ missionId: string; page: PlanPage | null } | null>(
			this.#window,
			"day.plan.create",
			intent,
		);
		if ((!r.ok && (r.refusal === "unknown" || r.refusal === "lost")) || (r.ok && r.outcome?.status === "unknown")) {
			this.#newUnknown = true;
			this.#setup = null;
			this.#publish();
		}
		// One shown setup is used once; read the next one, which creates nothing.
		void this.prepare();
		if (!r.ok) return this.#refused(r.refusal, null);
		const made = r.snapshot;
		if (!made || r.outcome?.status !== "accepted") return this.#outcome(r.outcome, null);
		this.#selected = made.missionId;
		this.#take(made.missionId, made.page);
		return this.#outcome(r.outcome, made.missionId);
	}

	start(_intent: NewIntent): Promise<PlanOutcome> {
		return Promise.resolve({
			status: "rejected",
			revision: this.#revision,
			message: "Starting one chat directly is not available here yet. Nothing was sent.",
			missionId: null,
		});
	}

	async saveAnswer(intent: AnswerIntent): Promise<PlanOutcome> {
		// The answer's own mission, never the one open now: switching missions cannot redirect it.
		const missionId = this.#missionOf(intent.interviewId);
		if (!missionId) return this.#refused("stale", null);
		const key = `${intent.interviewId}/${intent.questionId}`;
		this.#saving.add(key);
		this.#publish();
		const r = await call<PlanPage | null>(this.#window, "day.plan.save", { missionId, intent });
		this.#saving.delete(key);
		if (!r.ok) {
			this.#publish();
			return this.#refused(r.refusal, missionId);
		}
		this.#take(missionId, r.snapshot);
		return this.#outcome(r.outcome, missionId);
	}

	async startWork(
		missionId: string,
		intent: Pick<NonNullable<PlanPage["work"]>, "revision" | "digest" | "taskId" | "context">,
	): Promise<PlanOutcome> {
		if (this.#starting.has(missionId) || this.#unknownStarts.has(missionId))
			return this.#refused("unknown", missionId);
		this.#starting.add(missionId);
		this.#older.add(missionId);
		this.#publish();
		const r = await call<PlanPage | null>(this.#window, "day.plan.startWork", { missionId, intent });
		this.#starting.delete(missionId);
		if (!r.ok) {
			if (r.refusal === "lost" || r.refusal === "unknown") this.#unknownStarts.add(missionId);
			this.#publish();
			return this.#refused(r.refusal, missionId);
		}
		if (r.outcome?.status === "unknown") this.#unknownStarts.add(missionId);
		this.#take(missionId, r.snapshot);
		return this.#outcome(r.outcome, missionId);
	}

	async checkWork(missionId: string): Promise<PlanOutcome> {
		this.#older.add(missionId);
		const r = await call<PlanPage | null>(this.#window, "day.plan.checkWork", { missionId });
		if (!r.ok) return this.#refused(r.refusal, missionId);
		if (r.outcome?.status === "accepted" || r.outcome?.status === "rejected") this.#unknownStarts.delete(missionId);
		this.#take(missionId, r.snapshot);
		return this.#outcome(r.outcome, missionId);
	}

	async submit(intent: SubmitIntent): Promise<PlanOutcome> {
		const missionId = this.#missionOf(intent.interviewId);
		if (!missionId) return this.#refused("stale", null);
		const r = await call<PlanPage | null>(this.#window, "day.plan.submit", { missionId, intent });
		if (!r.ok) {
			void this.refresh();
			return this.#refused(r.refusal, missionId);
		}
		this.#take(missionId, r.snapshot);
		return this.#outcome(r.outcome, missionId);
	}

	async checkSubmit(intent: InterviewRef): Promise<PlanOutcome> {
		const missionId = this.#missionOf(intent.interviewId);
		if (!missionId) return this.#refused("stale", null);
		const r = await call<PlanPage | null>(this.#window, "day.plan.check", { missionId, intent });
		if (!r.ok) return this.#refused(r.refusal, missionId);
		this.#take(missionId, r.snapshot);
		return this.#outcome(r.outcome, missionId);
	}

	/** The open planning chat of `missionId` as read, or null. */
	chat(missionId: string): PlanChat | null {
		return this.#chats.get(missionId) ?? null;
	}

	/** Opens the planning chat and reads its newest rows, or the rows before what shows. Sends nothing to the agent. */
	async readChat(missionId: string, older: boolean): Promise<PlanOutcome> {
		this.#chatOpen = missionId;
		const prior = this.#chats.get(missionId);
		this.#chats.set(missionId, {
			reading: true,
			reason: prior?.reason ?? "",
			rows: prior?.rows ?? [],
			more: prior?.more ?? false,
		});
		this.#publish();
		const r = await call<PlanChat | null>(this.#window, "day.plan.chat", { missionId, older });
		// Closed or another chat opened meanwhile: drop the answer.
		if (this.#chatOpen !== missionId) return this.#outcome(null, missionId);
		const now = this.#chats.get(missionId);
		if (r.ok && r.snapshot) this.#chats.set(missionId, r.snapshot);
		else
			this.#chats.set(missionId, {
				reading: false,
				reason: "Pilot could not read the planning chat. Nothing was sent.",
				rows: now?.rows ?? [],
				more: now?.more ?? false,
			});
		this.#publish();
		return r.ok ? this.#outcome(r.outcome, missionId) : this.#refused(r.refusal, missionId);
	}

	/** Closes the planning chat. Pilot no longer reads or keeps it. */
	closeChat(): void {
		const id = this.#chatOpen;
		if (!id) return;
		this.#chatOpen = null;
		this.#chats.delete(id);
		void call(this.#window, "day.plan.leave", { missionId: id, chatOnly: true });
	}

	/** `missionId`'s planning page closed: Pilot stops reading it as its agent works. */
	leave(missionId: string): void {
		if (this.#chatOpen === missionId) {
			this.#chatOpen = null;
			this.#chats.delete(missionId);
		}
		void call(this.#window, "day.plan.leave", { missionId, chatOnly: false });
	}

	dispose(): void {
		this.#listeners.clear();
	}
}
