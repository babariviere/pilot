import { openSystemEventsHelper } from "./system-events-helper.ts";
import type { SystemPowerSource, SystemPowerState } from "./system-power.ts";

export interface SystemEventsHelper {
	send(command: { power?: boolean }): void;
	close(): void;
}
export type SystemEventsHelperFactory = (
	onPower: (state: SystemPowerState) => void,
	onClose: () => void,
) => Promise<SystemEventsHelper>;

/** Keeps the authenticated native power monitor active only while schedule detection needs it. */
export class SystemEventsDetection implements SystemPowerSource {
	private powerActive = false;
	private powerListeners = new Set<(state: SystemPowerState) => void>();
	private stopped = false;
	private generation = 0;
	private helper?: SystemEventsHelper;
	private opening?: Promise<void>;
	private retry?: NodeJS.Timeout;
	private failures = 0;
	private readonly factory: SystemEventsHelperFactory;
	constructor(factory: SystemEventsHelperFactory = openSystemEventsHelper) {
		this.factory = factory;
	}
	subscribePower(listener: (state: SystemPowerState) => void): () => void {
		this.powerListeners.add(listener);
		return () => {
			this.powerListeners.delete(listener);
		};
	}
	setPowerActive(active: boolean): void {
		if (active === this.powerActive) return;
		this.powerActive = active;
		if (active) {
			if (!this.retry) void this.ensure();
			this.helper?.send({ power: true });
		} else this.release();
	}
	private ensure(): Promise<void> {
		if (this.stopped || this.helper) return Promise.resolve();
		if (this.opening) return this.opening;
		clearTimeout(this.retry);
		this.retry = undefined;
		const generation = ++this.generation;
		let lost = false;
		const failed = () => {
			if (generation !== this.generation || this.stopped || lost) return;
			lost = true;
			this.helper = undefined;
			for (const listener of this.powerListeners) listener({ available: false, fullWake: false });
			if (this.powerActive) {
				this.retry = setTimeout(
					() => void this.ensure(),
					Math.min(60_000, 1000 * 2 ** Math.min(this.failures++, 6)),
				);
				this.retry.unref();
			}
		};
		this.opening = this.factory((state) => {
			if (generation === this.generation && !this.stopped && !lost) {
				this.failures = 0;
				for (const listener of this.powerListeners) listener(state);
			}
		}, failed)
			.then((helper) => {
				if (generation !== this.generation || this.stopped || lost) helper.close();
				else this.helper = helper;
			})
			.catch(failed)
			.finally(() => {
				this.opening = undefined;
				if (!this.stopped && this.powerActive && generation !== this.generation) void this.ensure();
			});
		return this.opening;
	}
	private release(): void {
		++this.generation;
		this.helper?.close();
		this.helper = undefined;
		clearTimeout(this.retry);
		this.retry = undefined;
	}
	stop(): void {
		this.stopped = true;
		this.release();
		this.powerListeners.clear();
	}
}
