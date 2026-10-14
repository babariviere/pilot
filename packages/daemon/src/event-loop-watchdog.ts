/** Event-loop stall diagnostics. Cheap enough to run always: one unref'd timer and bounded bookkeeping. */

const MAX_IN_FLIGHT = 512;
const MAX_SLOW = 16;
const SLOW_RETENTION_MS = 60_000;

/** Labels of in-flight async work and recent slow synchronous sections, reported with a stall. */
export class DaemonOperations {
	private readonly inFlight = new Map<number, { label: string; startedAt: number }>();
	private readonly slow: { label: string; ms: number; endedAt: number }[] = [];
	private next = 0;
	private readonly now: () => number;

	constructor(now: () => number = () => performance.now()) {
		this.now = now;
	}

	/** Returns an idempotent completion callback. Beyond the bound, work is not tracked. */
	begin(label: string): () => void {
		if (this.inFlight.size >= MAX_IN_FLIGHT) return () => undefined;
		const id = this.next++;
		this.inFlight.set(id, { label, startedAt: this.now() });
		return () => {
			this.inFlight.delete(id);
		};
	}

	/** Run a synchronous section and remember it if it took at least thresholdMs. */
	time<T>(label: string | (() => string), run: () => T, thresholdMs = 100): T {
		const startedAt = this.now();
		try {
			return run();
		} finally {
			const ms = this.now() - startedAt;
			if (ms >= thresholdMs) this.recordSlow(typeof label === "string" ? label : label(), ms);
		}
	}

	recordSlow(label: string, ms: number): void {
		this.slow.push({ label, ms, endedAt: this.now() });
		if (this.slow.length > MAX_SLOW) this.slow.shift();
	}

	/** Slow sections that ended during the stall, longest first, then the oldest in-flight work. */
	describe(windowMs: number, limit = 5): string[] {
		const now = this.now();
		const recent = Math.min(Math.max(windowMs, 0) + 1_000, SLOW_RETENTION_MS);
		const lines: string[] = [];
		const slow = this.slow
			.filter((entry) => now - entry.endedAt <= recent)
			.sort((a, b) => b.ms - a.ms)
			.slice(0, limit);
		for (const entry of slow) lines.push(`slow ${entry.label} (${Math.round(entry.ms)}ms)`);
		const active = [...this.inFlight.values()].sort((a, b) => a.startedAt - b.startedAt).slice(0, limit);
		for (const entry of active) lines.push(`in flight ${entry.label} (${Math.round(now - entry.startedAt)}ms)`);
		return lines;
	}
}

/** Shared by the HTTP server and session workers. */
export const operations = new DaemonOperations();

export interface WatchdogOptions {
	intervalMs?: number;
	thresholdMs?: number;
	now?: () => number;
	log?: (message: string) => void;
	describe?: (blockedMs: number) => string[];
}

/** Timer drift includes system sleep and scheduling delays, not just synchronous work on this thread. */
export class EventLoopWatchdog {
	private timer?: ReturnType<typeof setInterval>;
	private last = 0;
	private readonly intervalMs: number;
	private readonly thresholdMs: number;
	private readonly now: () => number;
	private readonly log: (message: string) => void;
	private readonly describe: (blockedMs: number) => string[];

	constructor(options: WatchdogOptions = {}) {
		this.intervalMs = options.intervalMs ?? 500;
		this.thresholdMs = options.thresholdMs ?? 1_000;
		this.now = options.now ?? (() => performance.now());
		this.log = options.log ?? ((message) => console.warn(message));
		this.describe = options.describe ?? ((blockedMs) => operations.describe(blockedMs));
	}

	start(): void {
		if (this.timer) return;
		this.last = this.now();
		this.timer = setInterval(() => this.tick(), this.intervalMs);
		this.timer.unref();
	}

	stop(): void {
		clearInterval(this.timer);
		this.timer = undefined;
	}

	/** Returns the measured stall in milliseconds, or 0 below the threshold. */
	tick(): number {
		const now = this.now();
		const blocked = now - this.last - this.intervalMs;
		this.last = now;
		if (blocked < this.thresholdMs) return 0;
		const context = this.describe(blocked);
		this.log(
			`pilotd: event loop delayed for ${Math.round(blocked)}ms (may include system sleep)${context.length ? `; ${context.join("; ")}` : ""}`,
		);
		return blocked;
	}
}
