/** The daemon owns one worker and one exclusive lease. No synchronous SQLite on its event loop. */
import { Worker } from "node:worker_threads";
import type { ControlHostErrorResponse } from "@pilot/protocol";
import { ControlHostError } from "./control-host-policy.ts";

export class ControlHostStore {
	private readonly worker: Worker;
	private serial = 0;
	private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	private fault?: Error;
	private closing?: Promise<void>;
	constructor(path: string) {
		this.worker = new Worker(new URL("./control-host-worker.ts", import.meta.url), { workerData: { path } });
		this.worker.on(
			"message",
			({
				id,
				value,
				error,
			}: {
				id: number;
				value?: unknown;
				error?: ControlHostErrorResponse & { status: number };
			}) => {
				const call = this.pending.get(id);
				if (!call) return;
				this.pending.delete(id);
				if (error)
					call.reject(
						error.status >= 500
							? new Error(error.error)
							: new ControlHostError(error.code, error.error, error.status),
					);
				else call.resolve(value);
				if (!this.pending.size) this.worker.unref();
			},
		);
		const fail = (error: Error) => {
			this.fault = error;
			for (const call of this.pending.values()) call.reject(error);
			this.pending.clear();
		};
		this.worker.on("error", fail);
		this.worker.on("exit", (code) => fail(new Error(`Control host worker exited (${code})`)));
		this.worker.unref();
	}
	call<T>(method: string, args: unknown = {}): Promise<T> {
		if (this.fault || this.closing) return Promise.reject(this.fault ?? new Error("Control host store closed"));
		if (this.pending.size >= 64)
			return Promise.reject(new ControlHostError("capacity", "Control host mailbox full", 503));
		return new Promise((resolve, reject) => {
			const id = ++this.serial;
			this.pending.set(id, { resolve: (v) => resolve(v as T), reject });
			this.worker.ref();
			this.worker.postMessage({ id, method, args });
		});
	}
	close(): Promise<void> {
		if (!this.closing) {
			const close = this.call("close");
			this.closing = close.then(async () => {
				await this.worker.terminate();
			});
		}
		return this.closing;
	}
}
