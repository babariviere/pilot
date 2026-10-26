/**
 * Disk replication for the in-memory mission store. Each committed changeset goes to a worker thread that applies
 * it to missions.sqlite; durable() resolves once every commit so far is on disk.
 */
import { Worker } from "node:worker_threads";
import { isWatchNotice } from "./worker-notice.ts";

/** How long close() blocks pilotd's shutdown waiting for the last changesets. */
const CLOSE_TIMEOUT_MS = 10_000;

/** A replica reply carries a finite sequence number. Node's watch mode posts module-watch notices to the same port. */
export function replicaReply(reply: unknown): { seq: number; error?: string } | undefined {
	if (typeof reply !== "object" || reply === null) return undefined;
	const record = reply as { seq?: unknown; error?: unknown };
	if (typeof record.seq !== "number" || !Number.isFinite(record.seq)) return undefined;
	if (record.error !== undefined && typeof record.error !== "string") return undefined;
	return { seq: record.seq, error: record.error };
}

export class MissionReplica {
	private readonly worker: Worker;
	/** Written by the worker after each committed batch, so close() can wait synchronously. */
	private readonly applied = new Int32Array(new SharedArrayBuffer(8));
	private requested = 0;
	private synced = 0;
	private failure?: Error;
	private closed = false;
	private readonly waiters: { seq: number; resolve: () => void; reject: (error: Error) => void }[] = [];
	private readonly onFailure: (error: Error) => void;

	constructor(file: string, onFailure: (error: Error) => void) {
		this.onFailure = onFailure;
		this.worker = new Worker(new URL("./mission-replica-worker.ts", import.meta.url), {
			workerData: { file, applied: this.applied },
		});
		// Never keeps pilotd or a test process alive; close() drains on the caller's thread.
		this.worker.unref();
		this.worker.on("message", (reply: unknown) => this.applyReply(reply));
		this.worker.on("error", (error) => this.fail(error));
		this.worker.on("exit", (code) => {
			if (!this.closed) this.fail(new Error(`Mission store replica exited with code ${code}`));
		});
	}

	push(changes: Uint8Array): void {
		if (this.closed) throw new Error("Mission store is closed");
		const seq = ++this.requested;
		this.worker.postMessage({ seq, changes }, [changes.buffer as ArrayBuffer]);
	}

	/** Accepts only this replica's own replies. A foreign message must never change the saved sequence. */
	applyReply(reply: unknown): void {
		if (isWatchNotice(reply)) return;
		const message = replicaReply(reply);
		if (!message) return;
		if (message.error !== undefined) {
			const error = new Error(`Mission store could not be saved: ${message.error}`);
			// Acknowledgements waiting now fail; later ones wait for the worker's retry to succeed.
			for (const waiter of this.waiters.splice(0)) waiter.reject(error);
			if (!this.failure) this.onFailure(error);
			this.failure = error;
			return;
		}
		this.failure = undefined;
		this.synced = Math.max(this.synced, message.seq);
		this.settle();
	}

	/** Resolves when every commit so far is on disk. */
	durable(): Promise<void> {
		const seq = this.requested;
		if (this.synced >= seq) return Promise.resolve();
		if (this.failure) return Promise.reject(this.failure);
		return new Promise((resolve, reject) => this.waiters.push({ seq, resolve, reject }));
	}

	get pending(): boolean {
		return this.synced < this.requested;
	}

	/** Blocks until the worker has saved every commit (bounded), then stops it. Only for shutdown. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		const deadline = Date.now() + CLOSE_TIMEOUT_MS;
		for (;;) {
			const applied = Atomics.load(this.applied, 0);
			if (applied >= this.requested) break;
			const left = deadline - Date.now();
			// [1] set before every commit is saved means the worker could not open the file at all.
			if (left <= 0 || Atomics.load(this.applied, 1)) {
				console.warn(`pilotd: mission store closed with ${this.requested - applied} unsaved changes`);
				break;
			}
			Atomics.wait(this.applied, 0, applied, left);
		}
		this.synced = Math.max(this.synced, Atomics.load(this.applied, 0));
		this.settle();
		const error = new Error("Mission store closed before saving");
		for (const waiter of this.waiters.splice(0)) waiter.reject(error);
		// Wait for the worker to release the file, so the next store (or a migration) can open it at once.
		this.worker.postMessage({ close: true });
		Atomics.wait(this.applied, 1, 0, Math.max(0, deadline - Date.now()));
	}

	private settle(): void {
		for (let i = this.waiters.length - 1; i >= 0; i--) {
			const waiter = this.waiters[i]!;
			if (waiter.seq > this.synced) continue;
			this.waiters.splice(i, 1);
			waiter.resolve();
		}
	}

	private fail(error: Error): void {
		if (this.closed) return;
		this.failure = error;
		for (const waiter of this.waiters.splice(0)) waiter.reject(error);
		this.onFailure(error);
	}
}
