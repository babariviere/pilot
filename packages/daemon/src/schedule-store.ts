import { Worker } from "node:worker_threads";
import type { DashboardScheduledItem, ScheduledItem } from "@pilot/protocol";
import { Conflict, NotFound, ServiceUnavailable } from "./errors.ts";

/** Bounded cached index, async durable mutations, and revision/state compare-and-swap claims. */
export class ScheduleStore {
	private readonly worker: Worker;
	private readonly items = new Map<string, ScheduledItem>();
	private readonly listeners = new Set<() => void>();
	private serial = 0;
	private broken?: Error;
	private closed = false;
	private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	constructor(file: string) {
		this.worker = new Worker(new URL("./schedules-worker.ts", import.meta.url), { workerData: { file } });
		this.worker.on("message", (reply: { id: number; value: unknown; error?: string; kind?: string }) => {
			const p = this.pending.get(reply.id);
			if (!p) return;
			this.pending.delete(reply.id);
			if (reply.error)
				p.reject(
					reply.kind === "conflict"
						? new Conflict(reply.error)
						: reply.kind === "not_found"
							? new NotFound(reply.error)
							: new Error(reply.error),
				);
			else p.resolve(reply.value);
			if (!this.pending.size) this.worker.unref();
		});
		const fail = (error: Error) => {
			this.broken = error;
			for (const p of this.pending.values()) p.reject(error);
			this.pending.clear();
		};
		this.worker.on("error", fail);
		this.worker.on("exit", (code) => fail(new Error(`Schedule worker exited (${code})`)));
		this.worker.unref();
	}
	private rpc<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
		if (this.closed || this.broken)
			return Promise.reject(this.broken ?? new ServiceUnavailable("Schedule store closed"));
		if (this.pending.size >= 64) return Promise.reject(new ServiceUnavailable("Schedule store busy; retry shortly"));
		return new Promise((resolve, reject) => {
			const id = ++this.serial;
			this.pending.set(id, { resolve: (v) => resolve(v as T), reject });
			this.worker.ref();
			this.worker.postMessage({ id, method, ...args });
		});
	}
	async load(now = Date.now()): Promise<void> {
		const rows = await this.rpc<ScheduledItem[]>("load", { now });
		this.items.clear();
		for (const item of rows) this.items.set(item.id, item);
	}
	list(projectId?: string): ScheduledItem[] {
		return structuredClone([...this.items.values()].filter((item) => !projectId || item.projectId === projectId));
	}
	/** Large HTTP/WS indexes are encoded off the daemon event loop. */
	snapshot(projectId?: string, ws = false): Promise<string> {
		return this.rpc("snapshot", { expected: { projectId, ws } });
	}
	pendingItems(): Array<Pick<ScheduledItem, "id" | "revision" | "trigger" | "at" | "wakeObserved" | "sleepObserved">> {
		return [...this.items.values()]
			.filter((item) => item.state === "pending")
			.map(({ id, revision, trigger, at, wakeObserved, sleepObserved }) => ({
				id,
				revision,
				trigger,
				at,
				wakeObserved,
				sleepObserved,
			}));
	}
	/** Lightweight projection: dashboard builds never copy stored prompt payloads. */
	dashboard(projectId: string): DashboardScheduledItem[] {
		return [...this.items.values()]
			.filter((item) => item.projectId === projectId && (item.state === "pending" || item.state === "failed"))
			.sort((a, b) => (a.at ?? a.createdAt) - (b.at ?? b.createdAt))
			.map((item) => ({
				id: item.id,
				title: item.title,
				kind: item.target.kind,
				trigger: item.trigger,
				networkNames: item.networkNames ? [...item.networkNames] : undefined,
				at: item.state === "failed" ? item.updatedAt : item.at,
				state: item.state as "pending" | "failed",
				error: item.error,
				sessionId: item.sessionId,
			}));
	}
	require(id: string): ScheduledItem {
		const item = this.items.get(id);
		if (!item) throw new NotFound(`Unknown schedule: ${id}`);
		return structuredClone(item);
	}
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	private emit(): void {
		for (const listener of this.listeners) listener();
	}
	async create(item: ScheduledItem): Promise<ScheduledItem> {
		const saved = await this.rpc<ScheduledItem>("create", { item });
		this.items.set(saved.id, saved);
		this.emit();
		return structuredClone(saved);
	}
	/** A claim is durable before its result resolves. Concurrent edit/cancel/claim has one winner. */
	async replace(expected: ScheduledItem, next: ScheduledItem): Promise<ScheduledItem> {
		const saved = await this.rpc<ScheduledItem>("replace", {
			expected,
			item: { ...next, revision: expected.revision + 1 },
		});
		this.items.set(saved.id, saved);
		this.emit();
		return structuredClone(saved);
	}
	async remove(expected: ScheduledItem): Promise<void> {
		await this.rpc("remove", { expected, item: expected });
		this.items.delete(expected.id);
		this.emit();
	}
	async close(): Promise<void> {
		if (this.closed) return;
		try {
			await this.rpc("close");
		} finally {
			this.closed = true;
			await this.worker.terminate();
		}
	}
}
