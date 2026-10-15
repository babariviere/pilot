/** Event-loop stall diagnostics. Cheap enough to run always: one unref'd timer and bounded bookkeeping. */
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

const MAX_IN_FLIGHT = 512;
const MAX_SLOW = 16;
const MAX_STALLS = 32;
const HISTOGRAM_RESOLUTION_MS = 20;
const SLOW_RETENTION_MS = 60_000;

/** Main-thread CPU in milliseconds. Unlike wall time, it excludes waiting for disk, locks or a CPU core. */
export function threadCpuMs(): number {
	const { user, system } = process.threadCpuUsage();
	return (user + system) / 1_000;
}

export interface SlowSection {
	label: string;
	ms: number;
	/** Main-thread CPU spent in the section. Far below ms means it waited (disk, scheduling), not computed. */
	cpuMs?: number;
	/** Unix milliseconds. */
	at: number;
}

export interface Stall {
	/** Unix milliseconds when the stall was detected. */
	at: number;
	ms: number;
	cpuMs?: number;
	context: string[];
}

function rounded(ms: number): number {
	return Math.round(ms);
}

function cost(ms: number, cpuMs?: number): string {
	return cpuMs === undefined ? `${rounded(ms)}ms` : `${rounded(ms)}ms, cpu ${rounded(cpuMs)}ms`;
}

/** Labels of in-flight async work and recent slow synchronous sections, reported with a stall. */
export class DaemonOperations {
	private readonly inFlight = new Map<number, { label: string; startedAt: number }>();
	private readonly slow: (SlowSection & { endedAt: number })[] = [];
	private readonly counts = new Map<string, { count: number; ms: number; cpuMs: number; maxMs: number }>();
	private next = 0;
	private readonly now: () => number;
	private readonly cpu: () => number;

	constructor(now: () => number = () => performance.now(), cpu: () => number = threadCpuMs) {
		this.now = now;
		this.cpu = cpu;
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
		const cpuAt = this.cpu();
		try {
			return run();
		} finally {
			const ms = this.now() - startedAt;
			if (ms >= thresholdMs)
				this.recordSlow(typeof label === "string" ? label : label(), ms, Math.max(0, this.cpu() - cpuAt));
		}
	}

	recordSlow(label: string, ms: number, cpuMs?: number): void {
		this.slow.push({ label, ms, ...(cpuMs !== undefined ? { cpuMs } : {}), at: Date.now(), endedAt: this.now() });
		if (this.slow.length > MAX_SLOW) this.slow.shift();
		// Totals per label kind, without session IDs, so the snapshot stays bounded.
		const kind = label.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id");
		const total = this.counts.get(kind) ?? { count: 0, ms: 0, cpuMs: 0, maxMs: 0 };
		total.count++;
		total.ms += ms;
		total.cpuMs += cpuMs ?? 0;
		total.maxMs = Math.max(total.maxMs, ms);
		if (this.counts.has(kind) || this.counts.size < 64) this.counts.set(kind, total);
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
		for (const entry of slow) lines.push(`slow ${entry.label} (${cost(entry.ms, entry.cpuMs)})`);
		const active = [...this.inFlight.values()].sort((a, b) => a.startedAt - b.startedAt).slice(0, limit);
		for (const entry of active) lines.push(`in flight ${entry.label} (${rounded(now - entry.startedAt)}ms)`);
		return lines;
	}

	snapshot() {
		const now = this.now();
		return {
			recentSlow: this.slow.map(({ endedAt: _endedAt, ...entry }) => ({
				...entry,
				ms: rounded(entry.ms),
				...(entry.cpuMs !== undefined ? { cpuMs: rounded(entry.cpuMs) } : {}),
			})),
			slowByKind: [...this.counts]
				.map(([label, total]) => ({
					label,
					count: total.count,
					ms: rounded(total.ms),
					cpuMs: rounded(total.cpuMs),
					maxMs: rounded(total.maxMs),
				}))
				.sort((a, b) => b.ms - a.ms),
			inFlight: [...this.inFlight.values()]
				.sort((a, b) => a.startedAt - b.startedAt)
				.slice(0, 16)
				.map((entry) => ({ label: entry.label, ms: rounded(now - entry.startedAt) })),
		};
	}
}

/** Shared by the HTTP server and session workers. */
export const operations = new DaemonOperations();

export interface WatchdogOptions {
	intervalMs?: number;
	thresholdMs?: number;
	now?: () => number;
	/** Main-thread CPU milliseconds; tests inject a fake clock. */
	cpu?: () => number;
	log?: (message: string) => void;
	describe?: (blockedMs: number) => string[];
	/** Delay histogram, off by default in tests. */
	histogram?: boolean;
}

/**
 * Timer drift includes system sleep and scheduling delays, not just synchronous work on this thread.
 * The main thread's CPU time during the gap separates the two: computing uses CPU, while waiting for disk,
 * a CPU core or a sleeping machine does not.
 */
export class EventLoopWatchdog {
	private timer?: ReturnType<typeof setInterval>;
	private last = 0;
	private lastCpu = 0;
	private readonly intervalMs: number;
	private readonly thresholdMs: number;
	private readonly now: () => number;
	private readonly cpu: () => number;
	private readonly log: (message: string) => void;
	private readonly describe: (blockedMs: number) => string[];
	private readonly histogram?: ReturnType<typeof monitorEventLoopDelay>;
	private readonly startedAt = Date.now();
	private readonly stalls: Stall[] = [];
	private readonly totals = { count: 0, ms: 0, cpuMs: 0, busy: 0, waiting: 0, sleep: 0 };
	private utilization?: ReturnType<typeof performance.eventLoopUtilization>;

	constructor(options: WatchdogOptions = {}) {
		this.intervalMs = options.intervalMs ?? 500;
		this.thresholdMs = options.thresholdMs ?? 1_000;
		this.now = options.now ?? (() => performance.now());
		this.cpu = options.cpu ?? threadCpuMs;
		this.log = options.log ?? ((message) => console.warn(message));
		this.describe = options.describe ?? ((blockedMs) => operations.describe(blockedMs));
		if (options.histogram) this.histogram = monitorEventLoopDelay({ resolution: HISTOGRAM_RESOLUTION_MS });
	}

	start(): void {
		if (this.timer) return;
		this.last = this.now();
		this.lastCpu = this.cpu();
		this.histogram?.enable();
		this.utilization = performance.eventLoopUtilization();
		this.timer = setInterval(() => this.tick(), this.intervalMs);
		this.timer.unref();
		running = this;
	}

	stop(): void {
		clearInterval(this.timer);
		this.timer = undefined;
		this.histogram?.disable();
		if (running === this) running = undefined;
	}

	/** Returns the measured stall in milliseconds, or 0 below the threshold. */
	tick(): number {
		const now = this.now();
		const cpu = this.cpu();
		const blocked = now - this.last - this.intervalMs;
		const cpuMs = Math.max(0, cpu - this.lastCpu);
		this.last = now;
		this.lastCpu = cpu;
		if (blocked < this.thresholdMs) return 0;
		const context = this.describe(blocked);
		// Half the gap on CPU means synchronous work. A minute without CPU is most likely system sleep.
		const kind = cpuMs >= blocked / 2 ? "busy" : blocked >= 60_000 && cpuMs < 1_000 ? "sleep" : "waiting";
		this.totals.count++;
		this.totals[kind]++;
		if (kind !== "sleep") {
			this.totals.ms += blocked;
			this.totals.cpuMs += cpuMs;
		}
		this.stalls.push({ at: Date.now(), ms: rounded(blocked), cpuMs: rounded(cpuMs), context });
		if (this.stalls.length > MAX_STALLS) this.stalls.shift();
		const reason =
			kind === "busy"
				? "synchronous work"
				: kind === "sleep"
					? "likely system sleep"
					: "waiting for disk, CPU or system sleep";
		this.log(
			`pilotd: event loop delayed for ${rounded(blocked)}ms (main thread cpu ${rounded(cpuMs)}ms: ${reason})${context.length ? `; ${context.join("; ")}` : ""}`,
		);
		return blocked;
	}

	/** Bounded, local diagnostics for GET /api/diagnostics/performance. */
	snapshot() {
		// Samples include the sampling interval itself; report only the delay beyond it.
		const delay = (nanoseconds: number) => Math.max(0, rounded(nanoseconds / 1e6 - HISTOGRAM_RESOLUTION_MS));
		const percentile = (value: number) => delay(this.histogram?.percentile(value) ?? 0);
		const memory = process.memoryUsage();
		const resources = process.resourceUsage();
		return {
			startedAt: this.startedAt,
			uptimeMs: Date.now() - this.startedAt,
			eventLoop: {
				utilization: this.utilization ? performance.eventLoopUtilization(this.utilization).utilization : undefined,
				...(this.histogram
					? {
							delayMs: {
								p50: percentile(50),
								p99: percentile(99),
								p999: percentile(99.9),
								max: delay(this.histogram.max),
							},
						}
					: {}),
			},
			stalls: {
				thresholdMs: this.thresholdMs,
				count: this.totals.count,
				busy: this.totals.busy,
				waiting: this.totals.waiting,
				sleep: this.totals.sleep,
				/** Excludes likely sleep. */
				totalMs: rounded(this.totals.ms),
				cpuMs: rounded(this.totals.cpuMs),
				recent: this.stalls,
			},
			operations: operations.snapshot(),
			process: {
				mainThreadCpuMs: rounded(this.cpu()),
				cpuMs: rounded((resources.userCPUTime + resources.systemCPUTime) / 1_000),
				rssBytes: memory.rss,
				heapUsedBytes: memory.heapUsed,
				externalBytes: memory.external,
				fsReads: resources.fsRead,
				fsWrites: resources.fsWrite,
				voluntaryContextSwitches: resources.voluntaryContextSwitches,
				involuntaryContextSwitches: resources.involuntaryContextSwitches,
			},
		};
	}
}

export type DaemonPerformance = ReturnType<EventLoopWatchdog["snapshot"]>;

let running: EventLoopWatchdog | undefined;

/** The started daemon watchdog's diagnostics, if any. */
export function daemonPerformance(): DaemonPerformance | undefined {
	return running?.snapshot();
}
