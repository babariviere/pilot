import type {
	ActionCheck,
	ActionRef,
	AnswerRef,
	AskIntent,
	CompleteIntent,
	DecideIntent,
	DecisionRef,
	DraftIntent,
	IntentOutcome,
	LifecycleIntent,
	MissionPage,
	MissionRef,
	PauseIntent,
	ProgressIntent,
	RenameIntent,
	ReplyIntent,
	ResumeIntent,
	StopReplanningIntent,
	Today,
} from "pilot-day/native";
import { call } from "./bridge";
import type { DayFeed } from "./feeds";
import type { ReadResult } from "./freshness";
import type { MigrationIntent, MigrationView } from "./migration";
import { raced, refusalOutcome } from "./refusals";
import { CallOrder, Feed } from "./source";

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
	#order = new CallOrder();
	// Answers and reports whose reply was lost are followed by item.
	#feed = new Feed(
		() => this.snapshot(),
		(id) => this.#lookUp(id),
		(today) => [today, [...this.#missions]],
	);
	#reads = this.#feed.coalesce(async () => {
		await this.#readProjection("day.today.read", {}, true);
	});

	constructor(window: string, first: Today) {
		this.#window = window;
		this.#today = first;
		this.#followUnknown();
	}

	snapshot(): Today {
		const t = this.#today;
		const later = this.#later.filter((id) => t.decisions.some((d) => d.id === id));
		const rank = (id: string) => later.indexOf(id);
		// While Pilot still looks an uncertain send up by itself, it shows as checking, not as a problem.
		const shown = <T extends { id: string; delivery: string }>(item: T): T =>
			this.#sending.has(item.id) && item.delivery === "idle"
				? { ...item, delivery: "sending" }
				: item.delivery === "unknown" && this.#feed.checking(item.id)
					? { ...item, delivery: "checking" }
					: item;
		const decisions = [...t.decisions].sort((a, b) => rank(a.id) - rank(b.id)).map(shown);
		const actions = t.actions.map(shown);
		return { ...t, decisions, actions };
	}

	onChange(listener: (today: Today) => void): () => void {
		return this.#feed.onChange(listener);
	}

	async #readProjection(name: string, args: unknown, cached = false) {
		const order = this.#order.next();
		const reply = await call<Today>(this.#window, name, args);
		if (
			reply.ok &&
			reply.snapshot &&
			!this.#feed.closed &&
			(!cached || this.#order.latest(order)) &&
			this.#order.apply(order)
		)
			this.#take(reply.snapshot);
		return reply;
	}

	#take(today: Today | null | undefined) {
		if (this.#feed.closed) return;
		if (today && typeof today === "object") {
			// A read equal to what shows changes nothing on screen.
			if (JSON.stringify(today) === JSON.stringify(this.#today)) return;
			// Back from a service that did not answer. A read that was only older (stale) is not a reconnect:
			// those come and go while agents work, and each would start the used-up checks again.
			const reconnected =
				(this.#today.freshness?.state === "offline" || this.#today.freshness?.state === "unreadable") &&
				today.freshness?.state === "live";
			this.#today = today;
			this.#followUnknown();
			if (reconnected) this.#feed.restart();
		}
		this.#feed.publish();
	}

	/** Follows every decision and action whose send is Unknown. */
	#followUnknown() {
		const t = this.#today;
		this.#feed.watch(
			[...t.decisions, ...t.actions].filter((item) => item.delivery === "unknown").map((item) => item.id),
		);
	}

	/** One automatic Check: a receipt read only. It never sends the answer again. */
	async #lookUp(id: string): Promise<void> {
		const action = this.#today.actions.some((a) => a.id === id);
		await this.#readProjection("day.attention.check", { id, action });
	}

	/**
	 * Reads the root's cached Today again after an invalidation. Bursts
	 * collapse into one more read. A failed read keeps what shows, unchanged:
	 * the automatic service reads (freshness.ts) retry and decide when to warn.
	 */
	refresh(): Promise<void> {
		// A notice drops the answer of a read still on its way: the next read follows it.
		this.#order.next();
		// The shown read stays until the next one lands. Marking it stale on
		// every notice repainted Today on each daemon event (flicker). Rust
		// says when a read is really stale or failed, and every action is
		// checked again natively before it is sent.
		return this.#reads();
	}

	/**
	 * Asks the root to read Today from its service now. Passive: it sends no
	 * intent. A refusal because the window is busy, closing or the read
	 * raced a newer change is not a failed try.
	 */
	async serviceRead(): Promise<ReadResult> {
		if (this.#feed.closed) return "raced";
		const r = await this.#readProjection("day.today.refresh", {});
		if (this.#feed.closed) return "raced";
		if (r.ok) return "current";
		return raced(r.refusal) ? "raced" : "failed";
	}

	mission(missionId: string): MissionPage | null {
		return this.#missions.get(missionId) ?? null;
	}

	async openMission(intent: MissionRef): Promise<IntentOutcome> {
		const r = await call<MissionPage | null>(this.#window, "day.mission.read", intent);
		if (!r.ok) {
			this.#feed.publish();
			return {
				status: "rejected",
				revision: this.#today.revision,
				message: "Pilot could not read this mission again. What was read before stays on screen.",
			};
		}
		this.#missions.set(intent.missionId, r.snapshot ?? null);
		this.#feed.publish();
		return r.outcome ?? { status: "accepted", revision: this.#today.revision, message: "" };
	}

	async migration(intent: MigrationIntent): Promise<MigrationView> {
		const r = await call<MigrationView>(this.#window, "day.mission.migration", intent);
		if (!r.ok && intent.action === "finish" && (r.refusal === "stale" || r.refusal === "denied"))
			return {
				state: "rejected",
				digest: "",
				message: "The preview changed or access was refused before sending. Nothing was sent. Review again.",
				oldTitle: null,
				newTitle: null,
				members: 0,
				linkedTickets: 0,
			};
		if (!r.ok)
			throw new Error(
				intent.action === "read" || intent.action === "history"
					? "A published replacement and a current migration preview are required."
					: "Migration is not confirmed. Check status; do not finish again.",
			);
		return r.snapshot;
	}

	/** Sends one mutation, marks its item as sending meanwhile, and reads again after a refusal. */
	async #send(item: string, name: string, args: unknown): Promise<IntentOutcome> {
		this.#sending.add(item);
		this.#feed.publish();
		const r = await this.#readProjection(name, args);
		this.#sending.delete(item);
		this.#feed.publish();
		if (r.ok) {
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
				const r = await this.#readProjection("day.attention.draft", draft);
				if (r.ok) {
					if (this.#drafts.get(id) === draft) this.#drafts.delete(id);
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
		this.#feed.publish();
		return { status: "accepted", revision: this.#today.revision, message: "" };
	}

	check(intent: DecisionRef): Promise<IntentOutcome> {
		return this.#send(intent.decisionId, "day.attention.check", { id: intent.decisionId, action: false });
	}

	/** A clarification question: the agent answers it without tools, and the decision stays open. */
	ask(intent: AskIntent): Promise<IntentOutcome> {
		// Not the decision's own send: the card stays answerable while the question is asked.
		return this.#send(`ask:${intent.decisionId}`, "day.attention.ask", intent);
	}

	/** Reads whether a clarification whose answer was lost was saved. Never asks again. */
	checkAnswer(intent: AnswerRef): Promise<IntentOutcome> {
		return this.#send(`ask:${intent.decisionId}`, "day.attention.check", { id: intent.answerId, action: false });
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
		this.#feed.close();
		if (this.#draftTimer !== undefined) clearTimeout(this.#draftTimer);
	}
}
