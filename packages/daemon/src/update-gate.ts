import { performance } from "node:perf_hooks";
import { ServiceUnavailable } from "./errors.ts";

/** Synchronous admission and idle check, so no new work can slip into an update window. */
export class UpdateGate {
	private pending = 0;
	private pausedUntil = 0;

	constructor(
		private readonly leaseMs = 30_000,
		private readonly now: () => number = () => performance.now(),
	) {}

	assertOpen(): void {
		if (this.now() < this.pausedUntil)
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

	/** Busy attempts do not pause anything. Successful repeated attempts renew the bounded lease. */
	prepare(workersBusy: boolean): boolean {
		if (workersBusy || this.pending !== 0) return false;
		this.pausedUntil = this.now() + this.leaseMs;
		return true;
	}
}
