// One rule for when Pilot warns that data on screen is old, and the
// automatic reads that keep it current. A normal refresh shows nothing:
// the last good data stays and updates in place.
import { type Accessor, cleanup, effect, lifecycle, signal, untracked } from "nsh";
import type { Freshness } from "pilot-day/native";
import { freshnessLine } from "./words";

/** Data must be older than this before Pilot warns. The user's choice: earlier warnings were noise. */
export const STALE_AFTER_MS = 5 * 60_000;
/** Automatic tries that must fail in a row before Pilot warns. The user's choice. */
export const FAILED_TRIES = 3;
/**
 * The first automatic retry waits this long, so the read a service event
 * already started lands first. Then the wait doubles.
 */
const FIRST_RETRY_MS = 2000;
/**
 * The longest wait between automatic retries: one service read a minute
 * while the service stays down. day.log showed thousands of failed reads a
 * second during a service restart when nothing waited between tries.
 */
const MAX_RETRY_MS = 60_000;
/**
 * Coming back to the window reads at most this often. It protects the
 * service from a read on every window switch; a live stream keeps the data
 * current meanwhile.
 */
const FOCUS_GAP_MS = 30_000;

/** When the shown data was last read (null: never), and how many automatic tries failed since. */
export type ReadHealth = { readAt: number | null; failures: number };

/**
 * Whether the data shown earns a warning: it is older than 5 minutes and 3
 * automatic tries in a row failed. Data never read is unavailable, not old.
 */
export function staleWarning(health: ReadHealth, now: number): boolean {
	return health.readAt !== null && health.failures >= FAILED_TRIES && now - health.readAt > STALE_AFTER_MS;
}

/** The wait before the next automatic try, after `failures` failed tries in a row. */
export function retryDelay(failures: number): number {
	return Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.max(0, failures));
}

/** The warning's words: when the data was read, as the local time. */
export function staleLine(readAt: number): string {
	const at = new Date(readAt);
	const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
	return `Not updated since ${time}. Pilot keeps trying to reach its service.`;
}

/** What one automatic read found: current data, a failure, or a read that raced a newer change. */
export type ReadResult = "current" | "failed" | "raced";

/**
 * Today's old-data warning, or "" when none. Mock worlds have no automatic
 * reads: their offline read stands for a service gone for a while.
 */
export function todayWarning(auto: AutoRead | undefined, freshness: Freshness): string {
	if (auto) return auto.stale() ? staleLine(auto.readAt() ?? 0) : "";
	return freshness.state === "offline" ? freshnessLine(freshness) : "";
}

/** Whether a read with this state has data to show: an earlier read counts, one that never worked does not. */
export function everRead(state: Freshness["state"]): boolean {
	return state !== "unreadable" && state !== "unavailable";
}

/** Automatic reads of one source, and whether its data earns a warning. */
export type AutoRead = {
	/** Whether the data shown is old enough to warn about. Changes only when the answer changes. */
	stale: Accessor<boolean>;
	/** Whether Pilot should offer Try now: the data is old by the rule, or nothing was ever read and 3 tries failed. */
	warn: Accessor<boolean>;
	/** When the data shown was read, or null when never. */
	readAt(): number | null;
	/** Current data arrived from any read: failures reset, and any retry waiting stops. */
	current(): void;
	/** The data shown is not current: an automatic try follows, with backoff. Repeated calls coalesce. */
	behind(): void;
	/** Reads now, as the warning's Try now does. A read in flight is followed by one more. */
	now(): Promise<void>;
	/** The data shown changed identity (another project): its age starts at `readAt` and no try failed yet. */
	restart(readAt: number | null): void;
	/** The window came back: reads now, unless a read started within the last 30 s. */
	focus(): void;
	/** Stops every timer. Nothing reads afterwards. */
	dispose(): void;
};

/** Timers and the clock, replaceable in tests. */
export type Clock = {
	now(): number;
	setTimeout(run: () => void, ms: number): unknown;
	clearTimeout(timer: unknown): void;
};

const SYSTEM: Clock = {
	now: () => Date.now(),
	setTimeout: (run, ms) => setTimeout(run, ms),
	clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** At most one pending retry. Its owner decides what to read and which failures count. */
export function readRetry(run: () => void, clock: Clock = SYSTEM) {
	let pending: unknown = null;
	return {
		wait(failures: number) {
			if (pending !== null) return;
			pending = clock.setTimeout(() => {
				pending = null;
				run();
			}, retryDelay(failures));
		},
		cancel() {
			if (pending !== null) clock.clearTimeout(pending);
			pending = null;
		},
	};
}

/**
 * Keeps one source current: `read` asks for a fresh read. At most one read
 * runs at a time, bursts become one more read, and failures back off.
 * `readAt` starts as the time of data already shown, or null when none was read.
 */
export function autoRead(read: () => Promise<ReadResult>, readAt: number | null, clock: Clock = SYSTEM): AutoRead {
	const health: ReadHealth = { readAt, failures: 0 };
	const stale = signal(false);
	const warn = signal(false);
	const retry = readRetry(() => void attempt(), clock);
	let warnAt: unknown = null;
	let running: Promise<void> | null = null;
	let again = false;
	let startedAt = -Infinity;
	let disposed = false;

	// One timer flips the warning on at the 5-minute mark; nothing ticks otherwise.
	const judge = () => {
		if (warnAt !== null) clock.clearTimeout(warnAt);
		warnAt = null;
		if (disposed) return;
		const now = clock.now();
		stale.set(staleWarning(health, now));
		warn.set(stale() || (health.readAt === null && health.failures >= FAILED_TRIES));
		if (health.readAt !== null && health.failures >= FAILED_TRIES && !stale())
			warnAt = clock.setTimeout(judge, health.readAt + STALE_AFTER_MS + 1 - now);
	};
	const schedule = () => {
		if (!disposed && !running) retry.wait(health.failures);
	};
	const attempt = (): Promise<void> => {
		if (disposed) return Promise.resolve();
		if (running) {
			again = true;
			return running;
		}
		retry.cancel();
		startedAt = clock.now();
		running = (async () => {
			let result: ReadResult;
			do {
				again = false;
				try {
					result = await read();
				} catch {
					result = "failed";
				}
			} while (again && !disposed);
			running = null;
			if (disposed) return;
			if (result === "current") ok();
			else {
				if (result === "failed") health.failures += 1;
				judge();
				schedule();
			}
		})();
		return running;
	};
	const ok = () => {
		retry.cancel();
		health.readAt = clock.now();
		health.failures = 0;
		judge();
	};
	return {
		stale,
		warn,
		readAt: () => health.readAt,
		current: () => {
			if (!disposed) ok();
		},
		behind: schedule,
		now: attempt,
		restart: (readAt) => {
			if (disposed) return;
			health.readAt = readAt;
			health.failures = 0;
			judge();
		},
		focus: () => {
			if (clock.now() - startedAt >= FOCUS_GAP_MS) void attempt();
		},
		dispose: () => {
			disposed = true;
			retry.cancel();
			if (warnAt !== null) clock.clearTimeout(warnAt);
			warnAt = null;
		},
	};
}

/**
 * Keeps one screen's read current while the screen is open: while `failed()`
 * says the last read failed, Pilot reads again with backoff; a good read
 * resets it. Coming back to the window reads it again (at most every 30 s).
 * Stops when the screen goes. For use in a component body.
 */
export function keepRead(read: () => Promise<unknown>, failed: () => boolean, hasData: () => boolean): AutoRead {
	const auto = autoRead(
		async () => {
			await read();
			return untracked(failed) ? "failed" : "current";
		},
		untracked(hasData) ? Date.now() : null,
	);
	effect(() => {
		const bad = failed();
		untracked(() => (bad ? auto.behind() : auto.current()));
	});
	let was = untracked(lifecycle);
	effect(() => {
		const now = lifecycle();
		if (now === "active" && was !== "active") untracked(() => auto.focus());
		was = now;
	});
	cleanup(() => auto.dispose());
	return auto;
}
