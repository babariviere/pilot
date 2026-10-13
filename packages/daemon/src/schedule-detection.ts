/** Daemon-owned detection. No app, native helper or long-lived polling subprocess is required. */
import type { ScheduleClock, ScheduleTriggerEvent, ScheduleTriggerSource } from "./schedules.ts";
import { execFileOffThread, SubprocessPool } from "./subprocess.ts";

export const WAKE_SAMPLE_MS = 30_000;
export const ONLINE_SAMPLE_MS = 30_000;
export const OFFLINE_BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const;
const SLEEP_DRIFT_MS = 5_000;
const WAKE_DEBOUNCE_MS = 5_000;
const PROBE_TIMEOUT_MS = 5_000;

export interface WakeSample {
	wallMs: number;
	monotonicMs: number;
	/** Authoritative macOS kernel wake timestamp, including microseconds. */
	wakeToken?: string;
}

export function parseWakeToken(output: string): string {
	const match = /\{\s*sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)\s*\}/.exec(output);
	if (!match || Number(match[2]) >= 1_000_000) throw new Error("Invalid kern.waketime response");
	return `${match[1]}:${match[2]}`;
}

/** Drift only works with a monotonic clock that stops during sleep (Linux hrtime). */
export function didWake(previous: WakeSample, current: WakeSample): boolean {
	if (current.wakeToken !== undefined || previous.wakeToken !== undefined)
		return (
			previous.wakeToken !== undefined && current.wakeToken !== undefined && current.wakeToken !== previous.wakeToken
		);
	const monotonicDelta = current.monotonicMs - previous.monotonicMs;
	return monotonicDelta >= 0 && current.wallMs - previous.wallMs - monotonicDelta >= SLEEP_DRIFT_MS;
}

export async function sampleSystemWake(signal: AbortSignal, pool?: SubprocessPool): Promise<WakeSample> {
	// libuv on Node 24 uses mach_continuous_time on Darwin, which INCLUDES sleep.
	// Compare the kernel's actual wake timestamp instead of misclassifying clock changes or stalls.
	const wakeToken =
		process.platform === "darwin"
			? parseWakeToken(
					await execFileOffThread(
						"/usr/sbin/sysctl",
						["kern.waketime"],
						{
							signal,
							timeoutMs: PROBE_TIMEOUT_MS,
							maxBytes: 1024,
						},
						pool,
					),
				)
			: undefined;
	return { wallMs: Date.now(), monotonicMs: Number(process.hrtime.bigint() / 1_000_000n), wakeToken };
}

/** No credentials or user data, no redirects/captive-portal success, no agent-provider request. */
export async function probeReachability(
	signal: AbortSignal,
	url = "https://www.gstatic.com/generate_204",
): Promise<boolean> {
	try {
		const response = await fetch(url, {
			method: "HEAD",
			redirect: "manual",
			cache: "no-store",
			headers: { Connection: "close" },
			signal: AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]),
		});
		await response.body?.cancel();
		return response.status === 204;
	} catch {
		return false;
	}
}

export interface ScheduleDetectionOptions {
	clock?: ScheduleClock;
	sampleWake?: (signal: AbortSignal) => Promise<WakeSample>;
	probe?: (signal: AbortSignal) => Promise<boolean>;
	warn?: (message: string) => void;
}
const clock: ScheduleClock = {
	now: Date.now,
	setTimeout(callback, ms) {
		const timer = setTimeout(callback, ms);
		timer.unref();
		return () => clearTimeout(timer);
	},
};

/** At most one wake sample and one probe in flight. All work is cancelled when the store is idle. */
export class ScheduleDetection implements ScheduleTriggerSource {
	online = false;
	private active = false;
	private generation = 0;
	private probeGeneration = 0;
	private knownOnline?: boolean;
	private previous?: WakeSample;
	private lastWake = -Infinity;
	private failures = 0;
	private warned = false;
	private cancelWakeTimer?: () => void;
	private cancelProbeTimer?: () => void;
	private wakeAbort?: AbortController;
	private probeAbort?: AbortController;
	private probing?: Promise<boolean>;
	private readonly listeners = new Set<(event: ScheduleTriggerEvent) => void>();
	// Keep the sampler thread across coarse ticks, and release it immediately when detection stops.
	private readonly wakeProcesses = new SubprocessPool({ maxThreads: 1, idleMs: 60_000 });
	private readonly time: ScheduleClock;
	private readonly sampleWake: (signal: AbortSignal) => Promise<WakeSample>;
	private readonly probe: (signal: AbortSignal) => Promise<boolean>;
	private readonly warn: (message: string) => void;

	constructor(options: ScheduleDetectionOptions = {}) {
		this.time = options.clock ?? clock;
		this.sampleWake = options.sampleWake ?? ((signal) => sampleSystemWake(signal, this.wakeProcesses));
		this.probe = options.probe ?? probeReachability;
		this.warn = options.warn ?? console.warn;
	}
	subscribe(listener: (event: ScheduleTriggerEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	private emit(event: ScheduleTriggerEvent): void {
		for (const listener of this.listeners) listener(event);
	}
	setActive(active: boolean): void {
		if (active === this.active) return;
		this.active = active;
		this.generation++;
		this.probeGeneration++;
		this.cancelWakeTimer?.();
		this.cancelProbeTimer?.();
		this.cancelWakeTimer = this.cancelProbeTimer = undefined;
		this.wakeAbort?.abort();
		this.probeAbort?.abort();
		this.probing = undefined;
		this.previous = undefined;
		this.knownOnline = undefined;
		this.online = false;
		this.lastWake = -Infinity;
		this.failures = 0;
		if (!active) void this.wakeProcesses.close();
		if (active) {
			// A resumed detector must not invent an offline→online transition.
			this.emit({ type: "online", online: false, initial: true });
			void this.checkWake();
			void this.refreshOnline();
		}
	}
	private async checkWake(): Promise<void> {
		const generation = this.generation;
		const abort = new AbortController();
		this.wakeAbort = abort;
		try {
			const sample = await this.sampleWake(abort.signal);
			if (!this.active || generation !== this.generation) return;
			const woke = this.previous && didWake(this.previous, sample);
			this.previous = sample;
			this.warned = false;
			if (woke && sample.monotonicMs - this.lastWake >= WAKE_DEBOUNCE_MS) {
				this.lastWake = sample.monotonicMs;
				// A pre-sleep successful probe is not evidence that the network is ready after resume.
				this.probeGeneration++;
				this.probeAbort?.abort();
				this.probing = undefined;
				this.cancelProbeTimer?.();
				this.cancelProbeTimer = undefined;
				this.online = false;
				this.emit({ type: "online", online: false, initial: true });
				this.emit({ type: "wake" });
				this.failures = 0;
				void this.refreshOnline();
			}
		} catch (error) {
			if (this.active && generation === this.generation && !this.warned) {
				this.warned = true;
				this.warn(`pilotd: schedule wake detection: ${error}`);
			}
		} finally {
			if (this.active && generation === this.generation)
				this.cancelWakeTimer = this.time.setTimeout(() => void this.checkWake(), WAKE_SAMPLE_MS);
		}
	}
	/** Fresh validation before a due network-gated dispatch; coalesces with any in-flight probe. */
	refreshOnline(): Promise<boolean> {
		if (!this.active) return Promise.resolve(false);
		if (this.probing) return this.probing;
		this.cancelProbeTimer?.();
		this.cancelProbeTimer = undefined;
		const generation = this.generation;
		const probeGeneration = this.probeGeneration;
		const abort = new AbortController();
		this.probeAbort = abort;
		const work = (async () => {
			let reachable = false;
			try {
				reachable = await Promise.resolve().then(() => this.probe(abort.signal));
			} catch {
				// A failed probe means unreachable, not a detector failure or an unhandled rejection.
			}
			if (!this.active || generation !== this.generation || probeGeneration !== this.probeGeneration)
				return this.online;
			const initial = this.knownOnline === undefined || this.knownOnline === reachable;
			const changed = this.online !== reachable || this.knownOnline === undefined;
			this.knownOnline = reachable;
			this.online = reachable;
			this.failures = reachable ? 0 : Math.min(this.failures + 1, OFFLINE_BACKOFF_MS.length);
			if (changed) this.emit({ type: "online", online: reachable, initial });
			if (this.active && generation === this.generation) {
				this.probing = undefined;
				const delay = reachable ? ONLINE_SAMPLE_MS : OFFLINE_BACKOFF_MS[this.failures - 1];
				this.cancelProbeTimer = this.time.setTimeout(() => void this.refreshOnline(), delay);
			}
			return reachable;
		})();
		this.probing = work;
		return work;
	}
}
