/** Bounded RPC to the project-memory storage worker. No synchronous disk work in pilotd. */
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { ControlJob, ControlMemoryState, ControlMessage, ControlMessageInput } from "./control-memory-disk.ts";
import type { ControlLine } from "./control-view.ts";

export class ControlMemory {
	private readonly worker: Worker;
	private serial = 0;
	private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private broken?: Error;
	private stopping?: Promise<void>;
	constructor(home: string) {
		this.worker = new Worker(new URL("./memory-worker.ts", import.meta.url), {
			workerData: { root: join(home, "memory") },
		});
		this.worker.on("message", ({ id, value, error }: { id: number; value?: unknown; error?: string }) => {
			const request = this.pending.get(id);
			if (!request) return;
			this.pending.delete(id);
			if (error) request.reject(new Error(error));
			else request.resolve(value);
			if (!this.pending.size) this.worker.unref();
		});
		const fail = (error: Error) => {
			this.broken = error;
			for (const request of this.pending.values()) request.reject(error);
			this.pending.clear();
		};
		this.worker.on("error", fail);
		this.worker.on("exit", (code) => fail(new Error(`Control memory worker exited (${code})`)));
		this.worker.unref();
	}
	private rpc<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
		if (this.broken || this.stopping) return Promise.reject(this.broken ?? new Error("Control memory stopped"));
		if (this.pending.size >= 64) return Promise.reject(new Error("Control memory busy, retry shortly"));
		return new Promise((resolve, reject) => {
			const id = ++this.serial;
			this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
			this.worker.ref();
			this.worker.postMessage({ id, method: `control.${method}`, args });
		});
	}
	state(): Promise<ControlMemoryState> {
		return this.rpc("state");
	}
	append(message: ControlMessageInput): Promise<ControlMessage[]> {
		return this.rpc("append", { message });
	}
	view(): Promise<ControlLine[]> {
		return this.rpc("view");
	}
	next(): Promise<ControlJob | undefined> {
		return this.rpc("next");
	}
	put(id: number, n: number, text: string): Promise<void> {
		return this.rpc("put", { id, n, text });
	}
	fail(id: number, n: number): Promise<void> {
		return this.rpc("fail", { id, n });
	}
	message(
		id: number,
		offset = 0,
	): Promise<ReturnType<import("./control-memory-disk.ts").ControlMemoryDisk["message"]>> {
		return this.rpc("message", { id, offset });
	}
	children(id: number, n: number): Promise<ControlLine[]> {
		return this.rpc("children", { id, n });
	}
	date(id: number): Promise<string> {
		return this.rpc("date", { id });
	}
	stop(): Promise<void> {
		if (this.stopping) return this.stopping;
		// FIFO close follows admitted mutations. A failed worker is still safe to terminate.
		const close = this.rpc("close");
		this.stopping = close
			.catch(() => {})
			.then(async () => {
				await this.worker.terminate();
			});
		return this.stopping;
	}
}
