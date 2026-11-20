/** SQLite lives on one worker. Dashboard reads use only five lightweight rows and counts per source. */
import { Worker } from "node:worker_threads";
import type { DashboardTrackedSource, TrackedKind } from "@pilot/protocol";
import { NotFound, ServiceUnavailable } from "../../runtime/contracts/errors.ts";
import { SOURCE_KINDS, sourceId, sourceLabel } from "../source-kinds.ts";
import type { SourceCheckpoint } from "./tracked-items-disk.ts";
import {
	type TrackedItemArgs,
	type TrackedItemMethod,
	type TrackedItemOps,
	type TrackedItemReply,
	type TrackedSourceSnapshot,
	trackedItemOps,
} from "./tracked-items-ops.ts";

export type { InboxQuery, InboxTracked, SourceCheckpoint, TrackedInput, TrackedQuery } from "./tracked-items-disk.ts";

/** Each operation of trackedItemOps, called with the same arguments on the worker. */
type RemoteOps = {
	[K in TrackedItemMethod]: (...args: TrackedItemArgs<K>) => Promise<ReturnType<TrackedItemOps[K]>>;
};

class TrackedItemClient {
	private readonly worker: Worker;
	private serial = 0;
	private stopped = false;
	private broken?: Error;
	private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private readonly snapshots = new Map<string, TrackedSourceSnapshot>();
	private readonly listeners = new Set<(projectId: string) => void>();
	static {
		for (const method of Object.keys(trackedItemOps) as TrackedItemMethod[])
			Object.defineProperty(TrackedItemClient.prototype, method, {
				value(this: TrackedItemClient, ...args: TrackedItemArgs<typeof method>) {
					return this.call(method, args);
				},
				writable: true,
				configurable: true,
			});
	}
	constructor(path: string) {
		this.worker = new Worker(new URL("./tracked-items-worker.ts", import.meta.url), { workerData: { path } });
		this.worker.on("message", (reply: TrackedItemReply) => {
			const pending = this.pending.get(reply.id);
			if (!pending) return;
			this.pending.delete(reply.id);
			if (!this.pending.size) this.worker.unref();
			if (reply.ok) {
				for (const snapshot of reply.snapshots ?? [])
					this.snapshots.set(sourceId(snapshot.projectId, snapshot.kind), snapshot);
				pending.resolve(reply.value);
				for (const projectId of reply.changed ?? []) for (const listener of this.listeners) listener(projectId);
			} else pending.reject(reply.code === "not_found" ? new NotFound(reply.message) : new Error(reply.message));
		});
		const fail = (error: Error) => {
			this.broken = error;
			for (const pending of this.pending.values()) pending.reject(error);
			this.pending.clear();
		};
		this.worker.on("error", fail);
		this.worker.on("exit", (code) => fail(new Error(`Tracking store exited (${code})`)));
		this.worker.unref();
	}
	/** Drop caches for removed projects; durable records remain recoverable on disk. */
	unload(projectId: string): void {
		for (const kind of SOURCE_KINDS) this.snapshots.delete(sourceId(projectId, kind));
	}
	checkpoint(id: string): SourceCheckpoint | undefined {
		return structuredClone(this.snapshots.get(id)?.checkpoint);
	}
	preview(projectId: string, kind: TrackedKind): DashboardTrackedSource {
		return structuredClone(
			this.snapshots.get(sourceId(projectId, kind))?.preview ?? {
				source: kind,
				label: sourceLabel(kind),
				status: "idle",
				total: 0,
				items: [],
			},
		);
	}
	/** Cached Inbox counts of a source by effective label ("" for none). */
	inboxCounts(projectId: string, kind: TrackedKind): Record<string, number> {
		return { ...this.snapshots.get(sourceId(projectId, kind))?.inbox };
	}
	onChange(listener: (projectId: string) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	async close(): Promise<void> {
		if (this.stopped) return;
		await this.call("close", []);
		this.stopped = true;
		this.listeners.clear();
		this.snapshots.clear();
	}
	private call<K extends TrackedItemMethod>(method: K, args: TrackedItemArgs<K>): Promise<unknown>;
	private call(method: "close", args: []): Promise<unknown>;
	private call(method: TrackedItemMethod | "close", args: unknown[]): Promise<unknown> {
		if (this.stopped || this.broken)
			return Promise.reject(this.broken ?? new ServiceUnavailable("Tracking store closed"));
		if (this.pending.size >= 64) return Promise.reject(new ServiceUnavailable("Tracking store busy, retry shortly"));
		return new Promise((resolve, reject) => {
			const id = ++this.serial;
			this.pending.set(id, { resolve, reject });
			this.worker.ref();
			try {
				this.worker.postMessage({ id, method, args });
			} catch (error) {
				this.pending.delete(id);
				reject(error);
				if (!this.pending.size) this.worker.unref();
			}
		});
	}
}

export type TrackedItemStore = TrackedItemClient & RemoteOps;
export const TrackedItemStore = TrackedItemClient as new (path: string) => TrackedItemStore;
