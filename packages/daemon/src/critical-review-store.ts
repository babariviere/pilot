/** Separate from ReviewStore/read marks. SQLite/fsync never run on pilotd's event loop. */
import { Worker } from "node:worker_threads";
import type { CriticalReviewRecord, CriticalReviewRecords } from "@pilot/protocol";

export class CriticalReviewStore {
	private readonly worker: Worker;
	private serial = 0;
	private closed = false;
	private fault?: Error;
	private readonly clock: () => number;
	private readonly invalidations = new Set<() => void>();
	onPrivateInvalidation(listener: () => void): () => void {
		this.invalidations.add(listener);
		return () => this.invalidations.delete(listener);
	}
	private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	constructor(file: string, clock: () => number = Date.now) {
		this.clock = clock;
		this.worker = new Worker(new URL("./critical-review-worker.ts", import.meta.url), { workerData: { file } });
		this.worker.on("message", ({ id, value, error }) => {
			const waiting = this.pending.get(id);
			if (!waiting) return;
			this.pending.delete(id);
			if (error) waiting.reject(new Error(error));
			else waiting.resolve(value);
			if (!this.pending.size) this.worker.unref();
		});
		const fail = (error: Error) => {
			this.fault = error;
			for (const listener of this.invalidations) listener();
			this.invalidations.clear();
			for (const waiting of this.pending.values()) waiting.reject(error);
			this.pending.clear();
		};
		this.worker.on("error", fail);
		this.worker.on("exit", (code) => fail(new Error(`Critical review store exited (${code})`)));
		this.worker.unref();
	}
	/** Internal host RPC, deliberately not exposed to agents or HTTP. */
	rpc<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
		if (this.closed || this.fault) return Promise.reject(this.fault ?? new Error("Critical review store closed"));
		if (this.pending.size >= 32) return Promise.reject(new Error("Critical review store busy"));
		return new Promise((resolve, reject) => {
			const id = ++this.serial;
			this.pending.set(id, {
				resolve: (value) => {
					if (method === "eraseSource" || method === "expire")
						for (const listener of this.invalidations) listener();
					resolve(value as T);
				},
				reject,
			});
			this.worker.ref();
			this.worker.postMessage({ id, method, args: { now: this.clock(), ...args } });
		});
	}
	/** Immutable create, idempotent only for byte-equivalent canonical content. */
	put<T extends CriticalReviewRecord>(record: T): Promise<T> {
		return this.rpc("put", { record });
	}
	get<K extends keyof CriticalReviewRecords>(kind: K, id: string): Promise<CriticalReviewRecords[K] | undefined> {
		return this.rpc("get", { kind, id });
	}
	list<K extends keyof CriticalReviewRecords>(kind: K, after = "", limit = 100): Promise<CriticalReviewRecords[K][]> {
		return this.rpc("list", { kind, after, limit });
	}
	async close(): Promise<void> {
		if (this.closed) return;
		for (const listener of this.invalidations) listener();
		this.invalidations.clear();
		try {
			await this.rpc("close");
		} finally {
			this.closed = true;
			await this.worker.terminate();
		}
	}
}
