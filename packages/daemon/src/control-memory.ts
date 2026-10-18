/** Bounded RPC to the project-memory storage worker. No synchronous disk work in pilotd. */
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type {
	ControlMemoryLine,
	ControlMemoryMessagesResponse,
	ControlMemoryNodeResponse,
	ControlMemoryStats,
} from "@pilot/protocol";
import type { ControlAuditEntry } from "./control-actions.ts";
import type { ControlJob, ControlMemoryState, ControlMessage, ControlMessageInput } from "./control-memory-disk.ts";
import type { ControlLine } from "./control-view.ts";

export class ControlMemory {
	private readonly worker: Worker;
	private serial = 0;
	private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private broken?: Error;
	private stopping?: Promise<void>;
	private readonly listeners = new Set<() => void>();
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
	/** Log appends, built summaries (which may merge the view) and job state changes. Not coalesced. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	private async changing<T>(work: Promise<T>): Promise<T> {
		const value = await work;
		for (const listener of this.listeners) listener();
		return value;
	}
	state(): Promise<ControlMemoryState> {
		return this.rpc("state");
	}
	retry(): Promise<void> {
		return this.changing(this.rpc("retry"));
	}
	turnView(key: string): Promise<ControlLine[]> {
		return this.rpc("turnView", { key });
	}
	auditAppend(entry: Omit<ControlAuditEntry, "seq">): Promise<ControlAuditEntry> {
		return this.rpc("auditAppend", { entry });
	}
	auditOperation(operationId: string): Promise<ControlAuditEntry | undefined> {
		return this.rpc("auditOperation", { operationId });
	}
	auditPage(before?: number, limit?: number): Promise<ControlAuditEntry[]> {
		return this.rpc("auditPage", { before, limit });
	}
	append(message: ControlMessageInput): Promise<ControlMessage[]> {
		return this.changing(this.rpc("append", { message }));
	}
	view(): Promise<ControlLine[]> {
		return this.rpc("view");
	}
	next(): Promise<ControlJob | undefined> {
		return this.rpc("next");
	}
	context(id: number, n: number): Promise<ControlLine[]> {
		return this.rpc("context", { id, n });
	}
	put(id: number, n: number, text: string): Promise<void> {
		return this.changing(this.rpc("put", { id, n, text }));
	}
	fail(id: number, n: number): Promise<void> {
		return this.changing(this.rpc("fail", { id, n }));
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
	/** Read-only browsing for the app. Never offered to agents. */
	viewLines(): Promise<ControlMemoryLine[]> {
		return this.rpc("viewLines");
	}
	async node(id: number, n: number, offset?: number): Promise<ControlMemoryNodeResponse> {
		if (n === 1) return this.message(id, offset);
		if (offset !== undefined) throw new Error("Only whole messages have pages");
		return { lines: await this.rpc<ControlMemoryLine[]>("childLines", { id, n }) };
	}
	messages(before?: number, limit?: number, q?: string): Promise<ControlMemoryMessagesResponse> {
		return this.rpc("messages", { before, limit, q });
	}
	stats(): Promise<ControlMemoryStats> {
		return this.rpc("stats");
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
