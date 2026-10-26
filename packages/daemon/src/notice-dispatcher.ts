/** Durable stores freeze payloads before delivery; this scheduler owns no history. */
export const NOTICE_DEBOUNCE_MS = 30_000;
export const NOTICE_MAX_DELAY_MS = 30 * 60_000;
export const NOTICE_WINDOW_MS = 3_600_000;
export const NOTICE_HOURLY_CAP = 20;

/** Shared notice policy: never send an event when its actor or subject is the recipient. */
export function noticeInvolvesSession(recipient: string | undefined, ...participants: (string | undefined)[]): boolean {
	return !!recipient && participants.some((sessionId) => sessionId === recipient);
}

export function noticeDeadline(
	input: {
		firstAt: number;
		lastAt: number;
		idleAt: number;
		busy: boolean;
		retry: boolean;
		cappedAt?: number;
		/** Mission members have all stopped; no additional settlement window is needed. */
		immediateWhenIdle?: boolean;
	},
	now: number,
): number {
	const delay = input.immediateWhenIdle ? 0 : NOTICE_DEBOUNCE_MS;
	const settled = input.busy ? Infinity : Math.max(input.lastAt, input.idleAt) + delay;
	const due = Math.min(
		input.retry && !input.busy ? Math.max(now, input.idleAt + delay) : settled,
		input.firstAt + NOTICE_MAX_DELAY_MS,
	);
	return input.cappedAt === undefined ? due : Math.max(due, input.cappedAt + NOTICE_WINDOW_MS);
}

export interface NoticeDeadline {
	key: string;
	at: number;
}
export interface NoticeDispatchAdapter {
	deadlines(now: number): NoticeDeadline[] | Promise<NoticeDeadline[]>;
	eligible(key: string): boolean;
	deliver(key: string, now: number): Promise<void>;
}

/** One coalesced timer, serial delivery, bounded retries, and shutdown drain. */
export class NoticeDispatcher {
	private timer?: ReturnType<typeof setTimeout>;
	private running?: Promise<void>;
	private stopped = true;
	private scheduled = false;
	private generation = 0;
	private readonly updates = new Set<Promise<void>>();
	private readonly adapter: NoticeDispatchAdapter;
	constructor(adapter: NoticeDispatchAdapter) {
		this.adapter = adapter;
	}
	start(): void {
		this.stopped = false;
		this.schedule();
	}
	schedule(): void {
		if (this.stopped || this.running || this.scheduled) return;
		this.scheduled = true;
		queueMicrotask(() => {
			const update = this.updateTimer().catch((error) => console.warn(`pilotd: notice scheduling failed: ${error}`));
			this.updates.add(update);
			void update.finally(() => this.updates.delete(update));
		});
	}
	private async updateTimer(): Promise<void> {
		this.scheduled = false;
		clearTimeout(this.timer);
		if (this.stopped || this.running) return;
		const generation = ++this.generation;
		const now = Date.now();
		const result = this.adapter.deadlines(now);
		const deadlines = (Array.isArray(result) ? result : await result).filter(({ key }) => this.adapter.eligible(key));
		if (this.stopped || this.running || generation !== this.generation || !deadlines.length) return;
		this.timer = setTimeout(
			() => {
				this.running = this.flush()
					.catch((error) => console.warn(`pilotd: notice delivery failed: ${error}`))
					.finally(() => {
						this.running = undefined;
						this.schedule();
					});
			},
			Math.max(1_000, Math.min(...deadlines.map((d) => d.at)) - now),
		);
		this.timer.unref();
	}
	async flush(now = Date.now()): Promise<void> {
		const result = this.adapter.deadlines(now);
		for (const { key, at } of Array.isArray(result) ? result : await result) {
			// Scheduling eligibility is a cheap projection. Admission uses the sink's authoritative guard.
			if (this.stopped || at > now) continue;
			await this.adapter.deliver(key, now);
		}
	}
	async stop(): Promise<void> {
		this.stopped = true;
		++this.generation;
		clearTimeout(this.timer);
		await Promise.all(this.updates);
		await this.running;
	}
}
