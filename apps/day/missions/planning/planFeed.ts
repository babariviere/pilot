import type {
	AnswerIntent,
	IntentOutcome,
	InterviewRef,
	NewIntent,
	PlanChat,
	Planning,
	PlanOutcome,
	PlanPage,
	PlanRow,
	Setup,
	SubmitIntent,
} from "pilot-day/native";
import { AutoCheck } from "../../sources/autoCheck";
import { call, type Reply } from "../../sources/bridge";
import type { PlanningFeed } from "../../sources/feeds";
import { type AutoRead, autoRead } from "../../sources/freshness";
import type { MapSourceDetail, MapSourceRead, MapSourceRequest } from "../../sources/map/mapSourceContract";
import { canReadAgain, type Refusal, raced, readReason, refusalOutcome } from "../../sources/refusals";
import { olderThanList } from "./planCurrent";

const NO_SETUP: Setup = { project: "", model: "", access: "", digest: "", unconfirmed: false, creations: [] };

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
function inventoryReason(refusal: Refusal): string {
	return readReason(refusal, {
		capacity: "More missions are in planning than one read holds, so Pilot shows none of them.",
		stale: "They changed while Pilot read them.",
		other: "Pilot could not read them.",
	});
}

/** A complete inventory read: every row names its current interview. Anything else is refused. */
function inventoryRows(planning: Planning | null | undefined): PlanRow[] | null {
	if (!planning || typeof planning !== "object" || !["live", "stale"].includes(planning.availability)) return null;
	if (!Array.isArray(planning.plans)) return null;
	return planning.plans.every((p) => p && typeof p.missionId === "string" && p.identity) ? planning.plans : null;
}

/** Planning over the root: the setup, every mission in planning, the pages opened here and saves on their way. */
export class ConnectedPlans implements PlanningFeed {
	#closed = false;
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
	/** Since when each page has not been current, while it is not. */
	/**
	 * The open page's automatic reads (freshness.ts). A page that is not
	 * current stays as it was, editable and with no note, while Pilot reads it
	 * again; it says it is older only by the shared rule (5 min and 3 failed
	 * tries). Every save and submission still names the page it was made on,
	 * and the root refuses one from a changed page.
	 */
	#pageReads: { missionId: string; auto: AutoRead } | null = null;
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
	// Interview answers whose reply was lost: Pilot checks them by itself, by mission.
	#auto = new AutoCheck(
		(missionId) => this.#lookUp(missionId),
		() => this.#publish(),
	);

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
		if (this.#closed) return;
		this.#revision += 1;
		this.#followPage();
		const planning = this.snapshot();
		for (const listener of this.#listeners.values()) listener(planning);
	}

	/** The open page is current: its reads reset. It is not: an automatic read follows, with backoff. */
	#followPage() {
		const reads = this.#pageReads;
		const read = reads ? this.#pages.get(reads.missionId) : undefined;
		if (!reads || !read) return;
		if (this.#current(reads.missionId, read)) reads.auto.current();
		else reads.auto.behind();
	}

	/** Starts automatic reads for the page `missionId`, the one now open. */
	#readPage(missionId: string) {
		if (this.#pageReads?.missionId === missionId) return;
		this.#pageReads?.auto.dispose();
		const auto = autoRead(
			async () => {
				const r = await call<PlanPage>(this.#window, "day.plan.read", { missionId });
				if (this.#closed || this.#selected !== missionId) return "raced";
				if (r.ok) {
					this.#take(missionId, r.snapshot);
					return this.#current(missionId, r.snapshot) ? "current" : "failed";
				}
				this.#forgetRefused(missionId, r.refusal);
				return raced(r.refusal) ? "raced" : "failed";
			},
			this.#pages.has(missionId) ? Date.now() : null,
		);
		this.#pageReads = { missionId, auto };
	}

	/** Reads the open page from its service now: the warning's Try now. */
	readNow(): Promise<void> {
		return this.#pageReads?.auto.now() ?? Promise.resolve();
	}

	/** The window came back: the open page is read again, at most every 30 s. */
	focusRead(): void {
		this.#pageReads?.auto.focus();
	}
	#starting = new Set<string>();
	#unknownStarts = new Set<string>();

	#take(missionId: string, page: PlanPage | null | undefined) {
		if (page && typeof page === "object") {
			this.#pages.set(missionId, page);
			this.#pageAt.set(missionId, ++this.#reads);
			this.#older.delete(missionId);
			this.#followUnknown();
		}
		this.#publish();
	}

	/** Follows every opened page whose interview answers were sent and not confirmed. A save still on its way is not. */
	#followUnknown() {
		const unknown = [...this.#pages].filter(([, page]) => {
			const iv = page.interview;
			return iv && (iv.submit === "unknown" || (iv.unconfirmed && iv.submit === "open" && !this.#sendingTo(iv.id)));
		});
		this.#auto.watch(unknown.map(([missionId]) => missionId));
	}

	/** Whether a save of interview `id` is on its way from this window. */
	#sendingTo(id: string): boolean {
		return [...this.#saving].some((key) => key.startsWith(`${id}/`));
	}

	/** One automatic Check of a mission's interview: a receipt read only. It never sends again. */
	async #lookUp(missionId: string): Promise<void> {
		const interviewId = this.#pages.get(missionId)?.interview?.id;
		if (!interviewId) return;
		const r = await call<PlanPage | null>(this.#window, "day.plan.check", {
			missionId,
			intent: { interviewId },
		});
		if (r.ok) this.#take(missionId, r.snapshot);
	}

	/** Keeps a complete read; a refusal drops every row. A cached read that is not current keeps the earlier reason. */
	#takeInventory(r: Reply<Planning>) {
		const rows = r.ok ? inventoryRows(r.snapshot) : null;
		if (rows && r.ok) {
			// The first good read after a failed one: the service is back, so the pages' checks start over.
			if (this.#inventory.state === "off") this.#auto.restart();
			this.#inventory = {
				state: r.snapshot.availability === "stale" ? "stale" : "live",
				rows,
				at: ++this.#reads,
				reason: r.snapshot.reason ?? "",
			};
		} else if (!r.ok) this.#inventory = { state: "off", refusal: r.refusal };
		else if (this.#inventory.state !== "off") this.#inventory = { state: "off", refusal: "unavailable" };
		this.#publish();
	}

	/**
	 * Asks the root to read every mission in planning from its service.
	 * Passive: it answers, saves and starts nothing. Runs at open and on Read again.
	 */
	readInventory(): Promise<void> {
		if (this.#closed) return Promise.resolve();
		if (this.#inventoryReading) return this.#inventoryReading;
		const version = ++this.#inventoryVersion;
		this.#inventoryReading = (async () => {
			const reply = await call<Planning>(this.#window, "day.plan.inventory", {});
			if (this.#closed) return;
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
		return inventory.state !== "off" || canReadAgain(inventory.refusal);
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
		const current = this.#current(missionId, read);
		// While Pilot reads it again, the page stays as it was: editable, without the older note.
		const reads = this.#pageReads;
		const older = !current && reads?.missionId === missionId && reads.auto.stale();
		// The older-read words come first, so a page with its own note still says it is older.
		let page = !older
			? read.fresh
				? read
				: { ...read, fresh: true }
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
		let iv = page.interview;
		// While Pilot still looks the answers up by itself, they show as checking, not as a problem.
		// A save still on its way is neither: it keeps the question open (below).
		if (
			iv &&
			this.#auto.checking(missionId) &&
			(iv.submit === "unknown" || (iv.unconfirmed && iv.submit === "open" && !this.#sendingTo(iv.id)))
		) {
			iv = { ...iv, submit: "checking" };
			page = { ...page, interview: iv };
		}
		if (!iv || this.#saving.size === 0) return page;
		const questions = iv.questions.map((q) =>
			this.#saving.has(`${iv.id}/${q.id}`) ? { ...q, saving: "sending" as const } : q,
		);
		// A save this window still waits for is on its way, not unconfirmed. Counting it
		// would fix the interview during every save: the field turned read-only, losing
		// focus, and the interview jumped to its review and back. A lost save stays unconfirmed.
		const sending = this.#sendingTo(iv.id);
		return { ...page, interview: { ...iv, questions, unconfirmed: iv.unconfirmed && !sending } };
	}

	readConfirmed(missionId: string): boolean {
		const page = this.#pages.get(missionId);
		return !!page && this.#current(missionId, page);
	}

	#forgetRefused(missionId: string, refusal: Refusal) {
		if (refusal !== "identity" && refusal !== "denied" && refusal !== "invalid") return;
		if (!this.#pages.delete(missionId)) return;
		this.#pageAt.delete(missionId);
		this.#older.add(missionId);
		this.#followUnknown();
		this.#publish();
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
	async checkNew(operationId?: string): Promise<PlanOutcome> {
		const r = await call<{ missionId: string; page: PlanPage | null } | null>(
			this.#window,
			"day.plan.checkNew",
			operationId ? { operationId } : {},
		);
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

	/**
	 * After an invalidation: the root's latest inventory, then the opened
	 * mission's planning. Both are cached reads, so they cause no further
	 * invalidation. Pages not read again are older from now on. Bursts
	 * collapse into one more read.
	 */
	refresh(): Promise<void> {
		if (this.#closed) return Promise.resolve();
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
			} while (this.#again && !this.#closed);
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
		if (this.#closed || version !== this.#refreshVersion) return;
		this.#takeInventory(inventory);
		if (!id) return;
		const r = await call<PlanPage>(this.#window, "day.plan.snapshot", { missionId: id });
		if (this.#selected !== id || version !== this.#refreshVersion) return;
		if (r.ok) this.#take(id, r.snapshot);
		else {
			this.#forgetRefused(id, r.refusal);
			this.#older.add(id);
			if (!this.#pages.has(id)) this.#pageReads?.auto.behind();
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

	async readSource(request: MapSourceRequest): Promise<MapSourceRead> {
		const r = await call<MapSourceDetail>(this.#window, "day.plan.source", request);
		return r.ok ? { status: "available", detail: r.snapshot } : { status: "unavailable" };
	}

	async open(missionId: string): Promise<PlanOutcome> {
		this.#selected = missionId;
		this.#readPage(missionId);
		// Navigation does not renew a cached page. Until this read succeeds,
		// it is not current; it shows as it was until the shared rule says it is old.
		this.#older.add(missionId);
		this.#publish();
		const r = await call<PlanPage>(this.#window, "day.plan.read", { missionId });
		if (!r.ok) {
			this.#forgetRefused(missionId, r.refusal);
			if (this.#pageReads?.missionId === missionId) this.#pageReads.auto.behind();
			return {
				status: "rejected",
				revision: this.#revision,
				message: "Pilot could not read this mission's planning. Your drafts are kept.",
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

	/**
	 * Asks the idle planning agent to continue, with the user's reply to its last message as a note when given. It
	 * names the planning state shown; a changed mission refuses it.
	 */
	async continuePlanning(intent: { missionId: string; feedback: string; note?: string }): Promise<PlanOutcome> {
		const missionId = intent.missionId;
		const r = await call<PlanPage | null>(this.#window, "day.plan.continue", {
			missionId,
			feedback: intent.feedback,
			...(intent.note ? { note: intent.note } : {}),
		});
		if (!r.ok) {
			void this.refresh();
			return this.#refused(r.refusal, missionId);
		}
		this.#take(missionId, r.snapshot);
		return this.#outcome(r.outcome, missionId);
	}

	/** Starts Unstick's repair agent: a read-only chat that reads the planner's chat and proposes one fix. */
	async repairStart(intent: { missionId: string }): Promise<PlanOutcome> {
		const missionId = intent.missionId;
		const r = await call<PlanPage | null>(this.#window, "day.plan.repairStart", { missionId });
		if (!r.ok) {
			void this.refresh();
			return this.#refused(r.refusal, missionId);
		}
		this.#take(missionId, r.snapshot);
		return this.#outcome(r.outcome, missionId);
	}

	/** Applies the repair agent's fix, with the note as the user left it. */
	async repairApply(intent: { missionId: string; note: string }): Promise<PlanOutcome> {
		const { missionId, note } = intent;
		const r = await call<PlanPage | null>(this.#window, "day.plan.repairApply", { missionId, note });
		if (!r.ok) {
			void this.refresh();
			return this.#refused(r.refusal, missionId);
		}
		this.#take(missionId, r.snapshot);
		return this.#outcome(r.outcome, missionId);
	}

	/** Asks Pilot to compare the published plan with what the user wants now, or for a fresh preview after Pause. */
	async revisit(intent: { missionId: string }): Promise<PlanOutcome> {
		return this.#planWrite(intent.missionId, "day.plan.revisit", { missionId: intent.missionId });
	}

	/** Applies the exact revision the user opened, by its id and digest. A changed revision is refused. */
	async confirmRevision(intent: { missionId: string; revisionId: string; digest: string }): Promise<PlanOutcome> {
		return this.#planWrite(intent.missionId, "day.plan.confirmRevision", { ...intent });
	}
	async pauseRevision(intent: { missionId: string; revisionId: string; digest: string }): Promise<PlanOutcome> {
		return this.#planWrite(intent.missionId, "day.plan.pauseRevision", { ...intent });
	}
	async resumeRevision(intent: { missionId: string; pauseOperationId: string }): Promise<PlanOutcome> {
		return this.#planWrite(intent.missionId, "day.plan.resumeRevision", { ...intent });
	}

	/** Looks up a Revisit write whose answer was lost. It never sends again. */
	async checkRevision(intent: { missionId: string; revisionId: string }): Promise<PlanOutcome> {
		return this.#planWrite(intent.missionId, "day.plan.checkRevision", { ...intent });
	}

	/** One planning write over the bridge: the page it returns replaces the shown one. */
	async #planWrite(missionId: string, name: string, args: Record<string, string>): Promise<PlanOutcome> {
		const r = await call<PlanPage | null>(this.#window, name, args);
		if (!r.ok) {
			void this.refresh();
			return this.#refused(r.refusal, missionId);
		}
		this.#take(missionId, r.snapshot);
		return this.#outcome(r.outcome, missionId);
	}

	/** Unstick's fix: removes saved answers to an earlier wording, so new answers save. */
	async dropEarlierAnswers(intent: { missionId: string }): Promise<PlanOutcome> {
		const missionId = intent.missionId;
		const r = await call<PlanPage | null>(this.#window, "day.plan.dropEarlierAnswers", { missionId });
		if (!r.ok) {
			void this.refresh();
			return this.#refused(r.refusal, missionId);
		}
		this.#take(missionId, r.snapshot);
		return this.#outcome(r.outcome, missionId);
	}

	/** Asks about one interview question. A read-only chat answers; the answer shows under the question. */
	async askQuestion(intent: { missionId: string; questionId: string; text: string }): Promise<PlanOutcome> {
		const missionId = intent.missionId;
		const r = await call<PlanPage | null>(this.#window, "day.plan.askQuestion", {
			missionId,
			questionId: intent.questionId,
			text: intent.text,
		});
		if (!r.ok) {
			void this.refresh();
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
		this.#closed = true;
		this.#auto.close();
		this.#pageReads?.auto.dispose();
		this.#pageReads = null;
		this.#listeners.clear();
	}
}
