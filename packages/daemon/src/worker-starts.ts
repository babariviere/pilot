import { ServiceUnavailable } from "./errors.ts";

type Worker = { ready: Promise<void> };
type Job<T> = { id: string; open(): T | Promise<T>; resolve(worker: T): void; reject(error: unknown): void };

/** Bound cold imports/extension loading, not running agents. One queued opening per session. */
export class WorkerStarts<T extends Worker> {
	private readonly pending = new Map<string, Promise<T>>();
	private readonly waiting: Job<T>[] = [];
	private active = 0;
	private closed = false;

	open(id: string, open: () => T | Promise<T>): Promise<T> {
		if (this.closed) return Promise.reject(new ServiceUnavailable("pilotd is shutting down"));
		const existing = this.pending.get(id);
		if (existing) return existing;
		const promise = new Promise<T>((resolve, reject) => this.waiting.push({ id, open, resolve, reject }));
		this.pending.set(id, promise);
		this.drain();
		return promise;
	}

	private drain(): void {
		while (!this.closed && this.active < 2 && this.waiting.length) {
			const job = this.waiting.shift()!;
			this.active++;
			void (async () => {
				try {
					const worker = await job.open();
					await worker.ready;
					job.resolve(worker);
				} catch (error) {
					job.reject(error);
				} finally {
					this.pending.delete(job.id);
					this.active--;
					this.drain();
				}
			})();
		}
	}

	/** Live owners are closed by SessionManager; queued openings must never fork after shutdown. */
	close(): void {
		this.closed = true;
		for (const job of this.waiting.splice(0)) {
			this.pending.delete(job.id);
			job.reject(new ServiceUnavailable("pilotd is shutting down"));
		}
	}
}
