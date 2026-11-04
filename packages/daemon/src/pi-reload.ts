import type { PiReloadStatus } from "@pilot/protocol";
import { Conflict } from "./errors.ts";

type State = "pending" | "reloading" | "reloaded" | "failed";

/** Event-driven, bounded reload fan-out. Busy workers stay pending, never interrupted or polled. */
export class PiReload<T> {
	private operationId: string | null = null;
	private readonly targets = new Map<string, { target: T | undefined; state: State; notified: boolean }>();
	private readonly listeners = new Set<(status: PiReloadStatus) => void>();
	private active = 0;
	private stopped = false;
	private wakeScheduled = false;
	private readonly ready: (id: string, target: T) => boolean;
	private readonly attempt: (id: string, target: T) => Promise<boolean>;

	constructor(ready: (id: string, target: T) => boolean, attempt: (id: string, target: T) => Promise<boolean>) {
		this.ready = ready;
		this.attempt = attempt;
	}

	status(): PiReloadStatus {
		const status: PiReloadStatus = {
			operationId: this.operationId,
			pending: 0,
			reloading: 0,
			reloaded: 0,
			failed: 0,
		};
		for (const row of this.targets.values()) status[row.state]++;
		return status;
	}

	onChange(listener: (status: PiReloadStatus) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	request(operationId: string, targets: ReadonlyMap<string, T>): PiReloadStatus {
		if (this.operationId === operationId) return this.status();
		if (
			this.stopped ||
			[...this.targets.values()].some((row) => row.state === "pending" || row.state === "reloading")
		)
			throw new Conflict("Pi configuration reload is already pending");
		this.operationId = operationId;
		this.targets.clear();
		for (const [id, target] of targets) this.targets.set(id, { target, state: "pending", notified: true });
		this.publish();
		this.drain();
		return this.status();
	}

	/** Only the affected chat's committed activity/command completion wakes it. */
	wake(id: string): void {
		const row = this.targets.get(id);
		if (!row || row.state === "reloaded" || row.state === "failed" || this.stopped) return;
		row.notified = true;
		// Wait for the notifying command's promise/finally barriers to release. This is
		// one event-driven yield, not a timer or a retry loop while a chat is busy.
		if (!this.wakeScheduled) {
			this.wakeScheduled = true;
			setImmediate(() => {
				this.wakeScheduled = false;
				this.drain();
			});
		}
	}

	wakeAll(): void {
		for (const id of this.targets.keys()) this.wake(id);
	}

	stop(): void {
		this.stopped = true;
		this.listeners.clear();
	}

	private drain(): void {
		if (this.stopped) return;
		for (const [id, row] of this.targets) {
			if (this.active >= 2) break;
			const target = row.target;
			if (target === undefined || row.state !== "pending" || !row.notified || !this.ready(id, target)) continue;
			row.state = "reloading";
			row.notified = false;
			this.active++;
			this.publish();
			void this.attempt(id, target)
				.then((done) => {
					row.state = done ? "reloaded" : "pending";
				})
				.catch(() => {
					row.state = "failed";
				})
				.finally(() => {
					if (row.state !== "pending") row.target = undefined;
					this.active--;
					this.publish();
					this.drain();
				});
		}
	}

	private publish(): void {
		if (!this.stopped) for (const listener of this.listeners) listener(this.status());
	}
}
