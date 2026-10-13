/** SQLite lives on one worker. Dashboard reads use only five lightweight rows and counts per source. */
import { Worker } from "node:worker_threads";
import type {
	DashboardTrackedSource,
	TrackedItem,
	TrackedItemList,
	TrackedItemPatch,
	TrackedKind,
} from "@pilot/protocol";
import { NotFound, ServiceUnavailable } from "./errors.ts";
import type { SourceCheckpoint, TrackedInput, TrackedQuery } from "./tracked-items-disk.ts";
export { validatePatch } from "./tracked-items-disk.ts";
export type { SourceCheckpoint, TrackedInput, TrackedQuery } from "./tracked-items-disk.ts";
type Snapshot = {
	projectId: string;
	kind: TrackedKind;
	preview: DashboardTrackedSource;
	checkpoint?: SourceCheckpoint;
};
export class TrackedItemStore {
	private readonly worker: Worker;
	private serial = 0;
	private stopped = false;
	private broken?: Error;
	private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private readonly snapshots = new Map<string, Snapshot>();
	private readonly listeners = new Set<(projectId: string) => void>();
	constructor(path: string) {
		this.worker = new Worker(new URL("./tracked-items-worker.ts", import.meta.url), { workerData: { path } });
		this.worker.on(
			"message",
			(reply: {
				id: number;
				value?: unknown;
				error?: string;
				notFound?: boolean;
				projectId?: string;
				snapshots?: Snapshot[];
			}) => {
				const pending = this.pending.get(reply.id);
				if (!pending) return;
				this.pending.delete(reply.id);
				for (const snapshot of reply.snapshots ?? [])
					this.snapshots.set(`${snapshot.projectId}:${snapshot.kind}`, snapshot);
				if (reply.error) pending.reject(reply.notFound ? new NotFound(reply.error) : new Error(reply.error));
				else pending.resolve(reply.value);
				if (!this.pending.size) this.worker.unref();
				if (reply.projectId) for (const listener of this.listeners) listener(reply.projectId);
			},
		);
		const fail = (error: Error) => {
			this.broken = error;
			for (const pending of this.pending.values()) pending.reject(error);
			this.pending.clear();
		};
		this.worker.on("error", fail);
		this.worker.on("exit", (code) => fail(new Error(`Tracking store exited (${code})`)));
		this.worker.unref();
	}
	async load(projectIds: string[]): Promise<void> {
		const snapshots = await this.rpc<Snapshot[]>("load", { projectIds });
		for (const snapshot of snapshots) this.snapshots.set(`${snapshot.projectId}:${snapshot.kind}`, snapshot);
	}
	/** Drop caches for removed projects; durable records remain recoverable on disk. */
	unload(projectId: string): void {
		this.snapshots.delete(`${projectId}:linear`);
		this.snapshots.delete(`${projectId}:slack`);
	}
	checkpoint(id: string): SourceCheckpoint | undefined {
		return structuredClone(this.snapshots.get(id)?.checkpoint);
	}
	preview(projectId: string, kind: TrackedKind): DashboardTrackedSource {
		return structuredClone(
			this.snapshots.get(`${projectId}:${kind}`)?.preview ?? {
				source: kind,
				label: kind === "linear" ? "Linear" : "Slack",
				status: "idle",
				total: 0,
				items: [],
			},
		);
	}
	list(query: TrackedQuery): Promise<TrackedItemList> {
		return this.rpc("list", query);
	}
	require(id: string): Promise<TrackedItem> {
		return this.rpc("require", { id });
	}
	commit(
		projectId: string,
		kind: TrackedKind,
		items: TrackedInput[],
		checkpoint?: SourceCheckpoint,
		activeIds?: string[],
	): Promise<void> {
		return this.rpc("commit", { projectId, kind, items, checkpoint, activeIds });
	}
	patch(id: string, patch: TrackedItemPatch): Promise<TrackedItem> {
		return this.rpc("patch", { id, patch });
	}
	onChange(listener: (projectId: string) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	async close(): Promise<void> {
		if (this.stopped) return;
		await this.rpc("close", {});
		this.stopped = true;
		this.listeners.clear();
		this.snapshots.clear();
	}
	private rpc<T>(method: string, args: unknown): Promise<T> {
		if (this.stopped || this.broken)
			return Promise.reject(this.broken ?? new ServiceUnavailable("Tracking store closed"));
		if (this.pending.size >= 64) return Promise.reject(new ServiceUnavailable("Tracking store busy, retry shortly"));
		return new Promise((resolve, reject) => {
			const id = ++this.serial;
			this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
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
