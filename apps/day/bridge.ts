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
	MissionPage,
	MissionRef,
	NewIntent,
	OutcomeStatus,
	PauseIntent,
	Planning,
	PlanOutcome,
	PlanPage,
	PlanRow,
	ProgressIntent,
	ReplyIntent,
	ResumeIntent,
	Setup,
	SubmitIntent,
	Today,
} from "pilot-day/native";
import type { DayFeed, PlanningFeed } from "./feeds";

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

type Reply<T> = { ok: true; snapshot: T; outcome: IntentOutcome | null } | { ok: false; refusal: Refusal };

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
		return { ok: true, snapshot: r.value.snapshot as T, outcome: (r.value.outcome ?? null) as IntentOutcome | null };
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
		if (this.#reading) {
			this.#again = true;
			return this.#reading;
		}
		this.#reading = (async () => {
			do {
				this.#again = false;
				const r = await call<Today>(this.#window, "day.today.read", {});
				if (r.ok) this.#take(r.snapshot);
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
				this.#drafts.delete(id);
				const r = await call<Today>(this.#window, "day.attention.draft", draft);
				if (r.ok) this.#take(r.snapshot);
				else saved = false;
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

	pulse(_everyMs?: number | null, _count?: number | null): Promise<number> {
		return Promise.resolve(0);
	}

	dispose(): void {
		if (this.#draftTimer !== undefined) clearTimeout(this.#draftTimer);
		this.#listeners.clear();
	}
}

const NO_SETUP: Setup = { project: "", model: "", access: "", digest: "" };

/** Planning over the root: the setup, the one mission opened here and saves on their way. */
export class ConnectedPlans implements PlanningFeed {
	#window: string;
	#setup: Setup | null;
	#selected: string | null = null;
	#pages = new Map<string, PlanPage>();
	#saving = new Set<string>();
	#revision = 0;
	#listeners = new Map<number, (planning: Planning) => void>();
	#next = 0;

	constructor(window: string, setup: Setup | null) {
		this.#window = window;
		this.#setup = setup;
	}

	snapshot(): Planning {
		const setup = this.#setup;
		const page = this.#selected ? this.#pages.get(this.#selected) : undefined;
		const plans: PlanRow[] = page?.available ? [row(page)] : [];
		return {
			revision: this.#revision,
			availability: "live",
			reason: "",
			setup: setup ?? NO_SETUP,
			canCreate: setup !== null,
			createReason: setup ? "" : "This Pilot service has no planning setup for new missions here.",
			canStart: false,
			startReason: "Starting one chat directly is not available here yet.",
			plans,
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

	#take(missionId: string, page: PlanPage | null | undefined) {
		if (page && typeof page === "object") this.#pages.set(missionId, page);
		this.#publish();
	}

	page(missionId: string): PlanPage | null {
		const page = this.#pages.get(missionId);
		if (!page) return null;
		const iv = page.interview;
		if (!iv || this.#saving.size === 0) return page;
		const questions = iv.questions.map((q) =>
			this.#saving.has(`${iv.id}/${q.id}`) ? { ...q, saving: "sending" as const } : q,
		);
		return { ...page, interview: { ...iv, questions } };
	}

	/** Reads the setup for New again: passive, it creates nothing. */
	async prepare(): Promise<void> {
		const r = await call<Setup | null>(this.#window, "day.plan.prepare", {});
		if (r.ok) {
			this.#setup = r.snapshot ?? null;
			this.#publish();
		}
	}

	/** Reads the opened mission's saved planning again after an invalidation. Passive. */
	async refresh(): Promise<void> {
		const id = this.#selected;
		if (!id) return;
		const r = await call<PlanPage>(this.#window, "day.plan.snapshot", { missionId: id });
		if (r.ok && this.#selected === id) this.#take(id, r.snapshot);
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

	async open(missionId: string): Promise<PlanOutcome> {
		this.#selected = missionId;
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
		// One shown setup is used once; read the next one, which creates nothing.
		void this.prepare();
		if (!r.ok) return this.#refused(r.refusal, null);
		const made = r.snapshot;
		if (!made) return this.#outcome(r.outcome, null);
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
		const missionId = this.#selected;
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

	async submit(intent: SubmitIntent): Promise<PlanOutcome> {
		const missionId = this.#selected;
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
		const missionId = this.#selected;
		if (!missionId) return this.#refused("stale", null);
		const r = await call<PlanPage | null>(this.#window, "day.plan.check", { missionId, intent });
		if (!r.ok) return this.#refused(r.refusal, missionId);
		this.#take(missionId, r.snapshot);
		return this.#outcome(r.outcome, missionId);
	}

	dispose(): void {
		this.#listeners.clear();
	}
}

/** One mission in planning, as a row: its stage, and how many answers it has. */
function row(page: PlanPage): PlanRow {
	const iv = page.interview;
	const line = iv && iv.questions.length > 0 ? `${iv.answered} of ${iv.questions.length} answered` : page.note;
	return {
		missionId: page.missionId,
		title: page.title,
		stage: page.stage,
		line,
		needsYou: page.stage === "questions" || page.stage === "review",
		identity: null,
	};
}
