/**
 * Compacts an idle coordinator chat before its next wake-up. A coordinator lives as long as its mission and every
 * wake-up adds to its context, so it is summarised while idle instead of during a later turn. Compaction waits
 * until the provider's prompt cache has expired, so it never throws away a warm cache.
 */
import type { SessionSummary } from "@pilot/protocol";
import type { MissionStore } from "./missions.ts";
import type { SessionManager } from "./sessions.ts";

/** Anthropic's default prompt-cache lifetime. Idle chats park after 10 minutes, so this fits before. */
export const COORDINATOR_COMPACT_IDLE_MS = 5 * 60_000;
/** Compact once the context reaches this share of the window, or the absolute cap, whichever is lower. */
export const COORDINATOR_COMPACT_FRACTION = 0.4;
export const COORDINATOR_COMPACT_MAX_TOKENS = 100_000;

export const COORDINATOR_COMPACT_INSTRUCTIONS = [
	"You coordinate a mission. Keep what the next wake-up needs:",
	"what the user asked for and questions to them still unanswered;",
	"commitments and next steps you proposed;",
	"chats you started or messaged, and what each is doing;",
	"agreements from this conversation not yet recorded in the mission.",
	"Leave out what the mission's brief, tasks, decisions and activity already hold; mission get re-reads them.",
].join(" ");

export function coordinatorCompactionThreshold(contextWindow: number): number {
	return Math.min(contextWindow * COORDINATOR_COMPACT_FRACTION, COORDINATOR_COMPACT_MAX_TOKENS);
}

type Sessions = Pick<SessionManager, "list" | "get" | "onChange" | "canSendNotice" | "compact">;
type Store = Pick<MissionStore, "onChange" | "noticeDeadlines" | "pendingNotice">;

export class CoordinatorCompaction {
	private timer?: ReturnType<typeof setTimeout>;
	private running?: Promise<void>;
	private stopped = true;
	private scheduled = false;
	private rerun = false;
	/** When each coordinator chat last became idle: its last settled run, or when it was seen idle without one. */
	private readonly idleSince = new Map<string, number>();
	/**
	 * The idle stretch already compacted (or attempted), so each stretch compacts at most once. It survives the
	 * compaction's own "working" state: an idle stretch is identified by its last settled run, which compaction does
	 * not change, so a failed or ineffective compaction waits for a new run instead of retrying straight away.
	 */
	private readonly attempted = new Map<string, number>();
	private readonly unsubscribe: (() => void)[];
	private readonly store: Store;
	private readonly sessions: Sessions;
	private readonly idleMs: number;

	constructor(store: Store, sessions: Sessions, idleMs = COORDINATOR_COMPACT_IDLE_MS) {
		this.store = store;
		this.sessions = sessions;
		this.idleMs = idleMs;
		this.unsubscribe = [
			store.onChange(() => this.schedule()),
			sessions.onChange((session) => {
				this.observe(session);
				this.schedule();
			}),
		];
	}

	start(): void {
		this.stopped = false;
		for (const session of this.sessions.list()) this.observe(session);
		this.schedule();
	}

	private observe(session: SessionSummary): void {
		if (!session.activeMissionCoordinator || session.archivedAt !== undefined) {
			this.idleSince.delete(session.id);
			this.attempted.delete(session.id);
		} else if (session.state !== "idle") {
			this.idleSince.delete(session.id);
		} else if (!this.idleSince.has(session.id)) {
			// After a restart, the last settled run is the best estimate of when idling began.
			this.idleSince.set(session.id, Math.min(Date.now(), session.outcomeAt ?? Date.now()));
		}
	}

	private schedule(): void {
		if (this.stopped) return;
		if (this.running) {
			this.rerun = true;
			return;
		}
		if (this.scheduled) return;
		this.scheduled = true;
		// Many synchronous changes (startup, a burst of usage updates) need one scan.
		queueMicrotask(() => {
			this.scheduled = false;
			if (this.stopped || this.running) return;
			this.running = this.run(Date.now())
				.catch((error: unknown) => console.warn(`pilotd: coordinator compaction failed: ${error}`))
				.finally(() => {
					this.running = undefined;
					if (this.rerun) {
						this.rerun = false;
						this.schedule();
					}
				});
		});
	}

	/** Compacts due coordinators, then waits for the next idle deadline. Blocked ones wait for a change event. */
	private async run(now: number): Promise<void> {
		clearTimeout(this.timer);
		await this.compactDue(now);
		if (this.stopped) return;
		let next = Number.POSITIVE_INFINITY;
		for (const [id, since] of this.idleSince)
			if (this.attempted.get(id) !== since && since + this.idleMs > now) next = Math.min(next, since + this.idleMs);
		if (next === Number.POSITIVE_INFINITY) return;
		this.timer = setTimeout(() => this.schedule(), next - now);
		this.timer.unref();
	}

	/** Also callable with a virtual clock by focused tests. */
	async compactDue(now = Date.now()): Promise<void> {
		for (const [id, since] of [...this.idleSince]) {
			if (this.stopped) return;
			if (this.attempted.get(id) === since || since + this.idleMs > now) continue;
			const session = this.sessions.get(id);
			if (!session || !this.due(session, now)) continue;
			this.attempted.set(id, since);
			try {
				await this.sessions.compact(id, COORDINATOR_COMPACT_INSTRUCTIONS);
			} catch (error) {
				console.warn(`pilotd: could not compact coordinator ${id}: ${error}`);
			}
		}
	}

	private due(session: SessionSummary, now: number): boolean {
		const missionId = session.missionId;
		const context = session.usage?.context;
		return (
			session.state === "idle" &&
			session.activeMissionCoordinator === true &&
			session.archivedAt === undefined &&
			missionId !== undefined &&
			context?.tokens !== undefined &&
			context.tokens >= coordinatorCompactionThreshold(context.contextWindow) &&
			// A pending wake-up comes first; the next idle stretch compacts.
			!this.store.noticeDeadlines(now, missionId).length &&
			!this.store.pendingNotice(missionId) &&
			this.sessions.canSendNotice(session.id)
		);
	}

	async stop(): Promise<void> {
		this.stopped = true;
		clearTimeout(this.timer);
		for (const unsubscribe of this.unsubscribe) unsubscribe();
		await this.running;
		this.idleSince.clear();
		this.attempted.clear();
	}
}
