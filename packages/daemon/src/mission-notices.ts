/** One event-driven delivery timer for durable batches. Busy chats never get an inbox item. */
import type { SessionSummary } from "@pilot/protocol";
import type { MissionStore } from "./missions.ts";
import type { SessionManager } from "./sessions.ts";

export class MissionNotices {
	private remoteOccupied: (missionId: string) => boolean = () => false;
	setRemoteOccupied(read: (missionId: string) => boolean): void {
		this.remoteOccupied = read;
	}
	private timer?: ReturnType<typeof setTimeout>;
	private running?: Promise<void>;
	private stopped = true;
	private scheduled = false;
	private readonly seen = new Map<string, string>();
	private readonly unsubscribe: (() => void)[];
	private readonly store: MissionStore;
	private readonly sessions: SessionManager;

	constructor(store: MissionStore, sessions: SessionManager) {
		this.store = store;
		this.sessions = sessions;
		this.unsubscribe = [store.onChange(() => this.schedule()), sessions.onChange((session) => this.observe(session))];
	}

	start(): void {
		this.stopped = false;
		// Recovery can touch hundreds of PRs. Publish final contexts once per mission, not per PR/member.
		this.store.batchChanges(() => this.recover());
		this.schedule();
	}

	private recover(): void {
		// Recover completions that were saved before a crash, but not yet recorded in missions.sqlite.
		const missions = new Set<string>();
		for (const session of this.sessions.list({ archived: "all" })) {
			this.observe(session, true);
			if (session.missionId) missions.add(session.missionId);
		}
		for (const id of missions) {
			// Hand-linked own PRs need recovery too, even if they are not in the chat's cache.
			const detail = this.store.detail(id);
			const owners = new Map(detail.tasks.map((task) => [task.id, task.sessionId]));
			for (const resource of detail.resources) {
				if (resource.relationship !== "ownership" || !resource.pullRequest || !resource.taskId) continue;
				const owner = owners.get(resource.taskId);
				const chat = owner ? this.sessions.get(owner) : undefined;
				if (chat)
					this.store.updatePullRequest(this.store.memberPullRequest(id, resource.pullRequest), [chat], (id) =>
						this.ownedPrs(id),
					);
			}
			this.refreshActivity(id);
		}
	}

	private observe(session: SessionSummary, recovering = false): void {
		if (this.stopped) return;
		if (!session.missionId) {
			this.seen.delete(session.id);
			return;
		}
		if (recovering) {
			const prs = this.sessions.ownedPullRequests?.(session.id) ?? [];
			// Open heads first so a later merge cannot finish a task while another head is unknown.
			for (const pr of prs.toSorted((a, b) => Number(a.state === "merged") - Number(b.state === "merged")))
				this.store.updatePullRequest(this.store.memberPullRequest(session.missionId, pr), [session], (id) =>
					this.ownedPrs(id),
				);
		}
		const key = JSON.stringify([
			session.state,
			session.working,
			session.outcomeAt,
			session.archivedAt,
			session.missionId,
			session.runningJobs,
		]);
		if (this.seen.get(session.id) === key) return;
		this.seen.set(session.id, key);
		if (session.working || session.state === "working" || session.state === "starting" || session.runningJobs?.length)
			this.store.recordMemberRun(session);
		else if (session.outcome) this.store.recordMemberCompletion(session, recovering);
		if (!recovering) this.refreshActivity(session.missionId);
		this.schedule();
	}

	private ownedPrs(missionId: string) {
		return this.store.members(missionId).flatMap((id) => this.sessions.ownedPullRequests?.(id) ?? []);
	}

	private refreshActivity(missionId: string): void {
		const mission = this.store.get(missionId);
		if (!mission) return;
		let busy = this.remoteOccupied(missionId);
		for (const id of this.store.members(missionId)) {
			if (id === mission.coordinatorSessionId) continue;
			const chat = this.sessions.get(id);
			if (!chat || chat.archivedAt !== undefined) continue;
			if (chat.working || chat.state === "working" || chat.state === "starting" || chat.runningJobs?.length)
				busy = true;
		}
		this.store.setNoticeActivity(missionId, busy, Date.now());
	}

	private deadlines(now: number) {
		const pending = this.store.noticeDeadlines(now);
		for (const { missionId } of pending) this.refreshActivity(missionId);
		return pending.length ? this.store.noticeDeadlines(now) : [];
	}

	/** Recheck member activity at IPC admission, including after asynchronous persistence. */
	allowed(sessionId: string, requestId: string): boolean {
		if (!this.store.noticeAllowed(sessionId, requestId)) return false;
		const missionId = this.store.missionOf(sessionId)!;
		this.refreshActivity(missionId);
		return this.store.noticeDeadlines(Date.now(), missionId).some(({ at }) => at <= Date.now());
	}

	private schedule(): void {
		if (this.stopped || this.running || this.scheduled) return;
		this.scheduled = true;
		// Many synchronous changes (startup recovery, a burst of member events) need one scan/timer.
		queueMicrotask(() => this.updateTimer());
	}

	private updateTimer(): void {
		this.scheduled = false;
		clearTimeout(this.timer);
		if (this.stopped || this.running) return;
		const now = Date.now();
		const deadlines = this.deadlines(now).filter(({ missionId }) => {
			const mission = this.store.get(missionId);
			const chat = mission?.coordinatorSessionId ? this.sessions.get(mission.coordinatorSessionId) : undefined;
			return (
				mission?.status === "active" &&
				chat &&
				chat.archivedAt === undefined &&
				chat.state !== "working" &&
				chat.state !== "starting"
			);
		});
		if (!deadlines.length) return;
		// Due-but-busy batches retry at most once a second, only while there is deliverable pending work.
		this.timer = setTimeout(
			() => {
				this.running = this.flush()
					.catch((error: unknown) => console.warn(`pilotd: notice delivery failed: ${error}`))
					.finally(() => {
						this.running = undefined;
						this.schedule();
					});
			},
			Math.max(1_000, Math.min(...deadlines.map((deadline) => deadline.at)) - now),
		);
		this.timer.unref();
	}

	/** Also callable with a virtual clock by focused delivery tests. */
	async flush(now = Date.now()): Promise<void> {
		for (const { missionId, at } of this.deadlines(now)) {
			if (this.stopped || at > now) continue;
			const mission = this.store.require(missionId);
			const id = mission.coordinatorSessionId;
			if (mission.status !== "active" || !id) continue;
			// prepareNotice returns a frozen retry; canSendNotice allows that same pending ID only.
			const retry = this.store.pendingNotice(missionId);
			if (!this.sessions.canSendNotice(id, retry?.requestId)) continue;
			const notice = this.store.prepareNotice(missionId, id, now);
			if (!notice) continue;
			try {
				// A delivered notice must never be forgotten by a store that lost power.
				const durable = this.store.whenDurable();
				if (durable) await durable;
				if (await this.sessions.sendNotice(id, notice.content, notice.requestId, notice.event))
					this.store.acknowledgeNotice(notice, now);
			} catch (error) {
				console.warn(`pilotd: could not deliver ${notice.requestId}: ${error}`);
			}
		}
	}

	async stop(): Promise<void> {
		this.stopped = true;
		clearTimeout(this.timer);
		for (const unsubscribe of this.unsubscribe) unsubscribe();
		await this.running;
		this.seen.clear();
	}
}
