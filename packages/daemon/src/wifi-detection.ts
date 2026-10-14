import type { WiFiStatus } from "@pilot/protocol";
import { openWiFiHelper } from "./wifi-helper.ts";
import { ServiceUnavailable } from "./errors.ts";

export interface WiFiDetector {
	status(): Promise<WiFiStatus>;
	requestAuthorization(): Promise<WiFiStatus>;
	subscribe(listener: (event: { previous: string | null; current: string | null }) => void): () => void;
	setActive(active: boolean): void;
}
export interface WiFiHelper {
	send(command: { authorize?: boolean; refresh?: boolean }): void;
	close(): void;
}
export type WiFiHelperFactory = (onStatus: (status: WiFiStatus) => void, onClose: () => void) => Promise<WiFiHelper>;
const unavailable = (): WiFiStatus => ({
	authorization: "unavailable",
	available: false,
	currentNetwork: null,
	knownNetworks: [],
	error: "Wi-Fi helper unavailable. Use the bundled macOS app.",
});

/** No SSID polling. First sample, reconnect and restored authorization establish a baseline, never an edge. */
export class WiFiDetection implements WiFiDetector {
	private value = unavailable();
	private baseline: string | null | undefined;
	private active = false;
	private stopped = false;
	private generation = 0;
	private helper?: WiFiHelper;
	private opening?: Promise<void>;
	private retry?: NodeJS.Timeout;
	private idle?: NodeJS.Timeout;
	private leaseUntil = 0;
	private failures = 0;
	private listeners = new Set<(event: { previous: string | null; current: string | null }) => void>();
	private waiters = new Set<() => void>();
	private readonly factory: WiFiHelperFactory;
	constructor(factory: WiFiHelperFactory = openWiFiHelper) {
		this.factory = factory;
	}
	subscribe(listener: (event: { previous: string | null; current: string | null }) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	private accept(status: WiFiStatus): void {
		const previous = this.baseline;
		this.value = structuredClone(status);
		this.baseline = status.available && status.authorization === "authorized" ? status.currentNetwork : undefined;
		if (previous !== undefined && this.baseline !== undefined && previous !== this.baseline)
			for (const listener of this.listeners) listener({ previous, current: this.baseline });
		for (const resolve of this.waiters) resolve();
		this.waiters.clear();
	}
	private ensure(): Promise<void> {
		if (this.stopped || this.helper) return Promise.resolve();
		if (this.opening) return this.opening;
		clearTimeout(this.retry);
		this.retry = undefined;
		const generation = ++this.generation;
		this.baseline = undefined;
		let lost = false;
		const failed = () => {
			if (generation !== this.generation || this.stopped || lost) return;
			lost = true;
			this.helper = undefined;
			this.accept(unavailable());
			if (this.active) {
				this.retry = setTimeout(
					() => void this.ensure(),
					Math.min(60_000, 1000 * 2 ** Math.min(this.failures++, 6)),
				);
				this.retry.unref();
			}
		};
		this.opening = this.factory((status) => {
			if (generation === this.generation && !this.stopped && !lost) {
				this.failures = 0;
				this.accept(status);
			}
		}, failed)
			.then((helper) => {
				if (generation !== this.generation || this.stopped || lost) helper.close();
				else this.helper = helper;
			})
			.catch(failed)
			.finally(() => {
				this.opening = undefined;
				if (!this.stopped && this.active && generation !== this.generation) void this.ensure();
			});
		return this.opening;
	}
	private release(): void {
		++this.generation;
		this.helper?.close();
		this.helper = undefined;
		this.baseline = undefined;
		clearTimeout(this.retry);
		this.retry = undefined;
		// Names have no persistent cache outside scheduled items.
		this.value = unavailable();
	}
	setActive(active: boolean): void {
		this.active = active;
		if (active) {
			if (!this.retry) void this.ensure();
		} else if (!this.idle) this.release();
	}
	private async read(authorize: boolean): Promise<WiFiStatus> {
		if (this.stopped) return unavailable();
		if (this.waiters.size >= 64) throw new ServiceUnavailable("Wi-Fi helper busy; retry shortly");
		this.leaseUntil = Math.max(this.leaseUntil, Date.now() + (authorize ? 120_000 : 30_000));
		clearTimeout(this.idle);
		this.idle = setTimeout(() => {
			this.idle = undefined;
			if (!this.active) this.release();
		}, this.leaseUntil - Date.now());
		this.idle.unref();
		await this.ensure();
		if (!this.helper) return structuredClone(this.value);
		if (this.waiters.size >= 64) throw new ServiceUnavailable("Wi-Fi helper busy; retry shortly");
		await new Promise<void>((resolve) => {
			const done = () => {
				clearTimeout(timer);
				this.waiters.delete(done);
				resolve();
			};
			const timer = setTimeout(done, 5000);
			this.waiters.add(done);
			this.helper!.send({ refresh: true, ...(authorize ? { authorize: true } : {}) });
		});
		return structuredClone(this.value);
	}
	status(): Promise<WiFiStatus> {
		return this.read(false);
	}
	requestAuthorization(): Promise<WiFiStatus> {
		return this.read(true);
	}
	stop(): void {
		this.stopped = true;
		clearTimeout(this.idle);
		this.release();
		for (const resolve of this.waiters) resolve();
		this.waiters.clear();
		this.listeners.clear();
	}
}
