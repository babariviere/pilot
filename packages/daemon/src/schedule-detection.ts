/** Event-driven helper detection, with a bounded kernel/display fallback when unavailable. */
import type { ScheduleClock, ScheduleTriggerEvent, ScheduleTriggerSource } from "./schedules.ts";
import type { SystemPowerSource, SystemPowerState } from "./system-power.ts";
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
	sleepAt?: number;
	fullWake?: boolean;
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
	const sample: WakeSample = { wallMs: Date.now(), monotonicMs: Number(process.hrtime.bigint() / 1_000_000n) };
	if (process.platform !== "darwin") return sample; // Unknown full/dark state fails closed.
	const run = (file: string, args: string[], maxBytes = 1024) =>
		execFileOffThread(
			file,
			args,
			{
				signal,
				timeoutMs: PROBE_TIMEOUT_MS,
				maxBytes,
			},
			pool,
		);
	const times = await run("/usr/sbin/sysctl", ["kern.sleeptime", "kern.waketime"]);
	sample.wakeToken = parseWakeToken(times.split("\n").find((line) => line.startsWith("kern.waketime:")) ?? "");
	const sleep = parseWakeToken(times.split("\n").find((line) => line.startsWith("kern.sleeptime:")) ?? "");
	const [seconds, micros] = sleep.split(":").map(Number);
	sample.sleepAt = seconds * 1000 + micros / 1000;
	// Graphics capability excludes dark wakes. CoreGraphics checks the main display without
	// Apple Events/System Events, accessibility permission, private APIs or power assertions.
	const registry = await run("/usr/sbin/ioreg", ["-r", "-c", "IOPMrootDomain", "-d", "1"], 131_072);
	const capabilities = Number(/"System Capabilities"\s*=\s*(\d+)/.exec(registry)?.[1] ?? 0);
	const display = await run("/usr/bin/osascript", [
		"-l",
		"JavaScript",
		"-e",
		'ObjC.import("CoreGraphics"); $.CGDisplayIsActive($.CGMainDisplayID()) && !$.CGDisplayIsAsleep($.CGMainDisplayID()) ? "awake" : "asleep"',
	]);
	sample.fullWake = (capabilities & 2) !== 0 && display.trim() === "awake";
	return sample;
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
	power?: SystemPowerSource;
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
	private sampleGeneration = 0;
	private probeGeneration = 0;
	private knownOnline?: boolean;
	private previous?: WakeSample;
	private lastWake = -Infinity;
	private lastSleep?: number;
	private fullSleep?: number;
	private helperAvailable = false;
	private disposePower?: () => void;
	private readonly power?: SystemPowerSource;
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
		this.power = options.power;
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
		this.sampleGeneration++;
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
		this.lastSleep = this.fullSleep = undefined;
		this.helperAvailable = false;
		this.disposePower?.();
		this.disposePower = undefined;
		this.failures = 0;
		if (!active) {
			this.power?.setPowerActive(false);
			void this.wakeProcesses.close();
		}
		if (active) {
			// A resumed detector must not invent an offline→online transition.
			this.emit({ type: "online", online: false, initial: true });
			this.disposePower = this.power?.subscribePower((state) => this.acceptPower(state));
			this.power?.setPowerActive(true);
			void this.checkWake();
			void this.refreshOnline();
		}
	}
	private acceptPower(state: SystemPowerState): void {
		if (!this.active) return;
		const wasAvailable = this.helperAvailable;
		this.helperAvailable = state.available;
		if (state.available) {
			this.sampleGeneration++;
			this.cancelWakeTimer?.();
			this.cancelWakeTimer = undefined;
			this.wakeAbort?.abort();
			void this.wakeProcesses.close();
			this.observePower(state.sleepAt, state.fullWake);
		} else if (wasAvailable) {
			this.previous = undefined;
			void this.checkWake();
		}
	}
	private observePower(sleepAt: number | undefined, full: boolean): void {
		if (sleepAt === undefined || sleepAt <= 0) return;
		if (sleepAt !== this.lastSleep) {
			this.lastSleep = sleepAt;
			this.emit({ type: "sleep", at: sleepAt });
		}
		if (!full || sleepAt === this.fullSleep) return;
		this.fullSleep = sleepAt;
		this.invalidateOnline();
		this.emit({ type: "wake", full: true });
		void this.refreshOnline();
	}
	private invalidateOnline(): void {
		this.probeGeneration++;
		this.probeAbort?.abort();
		this.probing = undefined;
		this.cancelProbeTimer?.();
		this.cancelProbeTimer = undefined;
		this.online = false;
		this.emit({ type: "online", online: false, initial: true });
		this.failures = 0;
	}
	private async checkWake(): Promise<void> {
		if (this.helperAvailable) return;
		const generation = this.generation;
		const sampleGeneration = ++this.sampleGeneration;
		const abort = new AbortController();
		this.wakeAbort = abort;
		try {
			const sample = await this.sampleWake(abort.signal);
			if (
				!this.active ||
				generation !== this.generation ||
				sampleGeneration !== this.sampleGeneration ||
				this.helperAvailable
			)
				return;
			const woke = this.previous && didWake(this.previous, sample);
			this.previous = sample;
			this.warned = false;
			if (woke && !sample.fullWake && sample.monotonicMs - this.lastWake >= WAKE_DEBOUNCE_MS) {
				this.lastWake = sample.monotonicMs;
				this.invalidateOnline();
				void this.refreshOnline();
			}
			// Also handles startup/restart during sleep and dark→full promotion with an unchanged
			// kern.waketime. Saving after this historical sleep is filtered per item by the service.
			this.observePower(sample.sleepAt, sample.fullWake === true);
		} catch (error) {
			if (
				this.active &&
				generation === this.generation &&
				sampleGeneration === this.sampleGeneration &&
				!this.helperAvailable &&
				!this.warned
			) {
				this.warned = true;
				this.warn(`pilotd: schedule wake detection: ${error}`);
			}
		} finally {
			if (
				this.active &&
				generation === this.generation &&
				sampleGeneration === this.sampleGeneration &&
				!this.helperAvailable
			)
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
