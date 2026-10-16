import { performance } from "node:perf_hooks";
import { ServiceUnavailable } from "./errors.ts";

/** Synchronous admission and idle check, so no new work can slip into an update window. */
export class UpdateGate {
	private pending = 0;
	private pausedUntil = 0;
	private freezes = 0;

	private readonly leaseMs: number;
	private readonly now: () => number;

	constructor(leaseMs = 30_000, now: () => number = () => performance.now()) {
		this.leaseMs = leaseMs;
		this.now = now;
	}

	get paused(): boolean {
		return this.freezes > 0 || this.now() < this.pausedUntil;
	}
	freezeAdmissions(): () => void {
		this.freezes++;
		let released = false;
		return () => {
			if (!released) {
				released = true;
				this.freezes--;
			}
		};
	}
	get admissions(): number {
		return this.pending;
	}
	get frozen(): boolean {
		return this.freezes > 0;
	}

	assertOpen(): void {
		if (this.paused)
			throw new ServiceUnavailable(
				"pilotd is preparing for an update; new work is temporarily paused. Retry shortly.",
			);
	}

	/** Call before the first await. Always release in finally, including failed admissions. */
	begin(): () => void {
		this.assertOpen();
		this.pending++;
		let ended = false;
		return () => {
			if (ended) return;
			ended = true;
			this.pending--;
		};
	}

	/** Freeze immediately, including while earlier admissions settle. */
	pause(): boolean {
		this.pausedUntil = this.now() + this.leaseMs;
		return this.pending === 0;
	}

	release(): void {
		this.pausedUntil = 0;
	}

	/** Busy attempts do not pause anything. Successful repeated attempts renew the bounded lease. */
	prepare(workersBusy: boolean): boolean {
		if (workersBusy || this.pending !== 0) return false;
		this.pausedUntil = this.now() + this.leaseMs;
		return true;
	}
}
