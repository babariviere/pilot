import { Worker } from "node:worker_threads";
import type { ControlAuthorizationNeeded, ControlFollowUp } from "@pilot/protocol";
import { NoticeDispatcher } from "./notice-dispatcher.ts";
import type {
	WatchNotice,
	WatchNoticeSink,
	WatchObservation,
	WatchRemoval,
	WatchTransition,
} from "./watch-delivery.ts";
import { validateWatch, type Watch, type WatchInput, type WatchTarget } from "./watches.ts";

/** Bounded RPC mailbox. No SQLite connection or unbounded watch cache on the event loop. */
export class WatchService {
	private readonly worker: Worker;
	private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	private readonly listeners = new Set<() => void>();
	private serial = 0;
	private closed = false;
	private broken?: Error;
	private sink?: WatchNoticeSink;
	private readonly dispatcher: NoticeDispatcher;
	private expiryTimer?: ReturnType<typeof setTimeout>;
	private expiryUpdate?: Promise<void>;
	private expiryDirty = false;
	private closing = false;
	private dashboardCache: {
		watches: Watch[];
		total: number;
		followUps: ControlFollowUp[];
		followUpsTotal: number;
		authorizationNeeded: ControlAuthorizationNeeded[];
		authorizationNeededTotal: number;
	} = {
		watches: [],
		total: 0,
		followUps: [],
		followUpsTotal: 0,
		authorizationNeeded: [],
		authorizationNeededTotal: 0,
	};
	/** Memory only. Refreshed by watch changes, never by a dashboard request. */
	dashboard() {
		return this.dashboardCache;
	}
	ready(): Promise<void> {
		return this.expiryUpdate ?? Promise.resolve();
	}
	private removalAudit?: (removal: WatchRemoval) => Promise<void>;
	private auditing?: Promise<void>;
	constructor(path: string) {
		this.dispatcher = new NoticeDispatcher({
			deadlines: async (now) => {
				await this.rpc("activity", { busy: !!this.sink && !this.sink.canSend(), now });
				const at = await this.rpc<number | undefined>("deadline", now);
				return at === undefined ? [] : [{ key: "control", at }];
			},
			eligible: () => !!this.sink && this.sink.canSend(),
			deliver: async (_key, now) => {
				const sink = this.sink;
				if (!sink) return;
				const retry = await this.rpc<WatchNotice | undefined>("pending");
				if (!sink.canSend(retry?.requestId)) return;
				const notice = await this.rpc<WatchNotice | undefined>("prepare", now);
				if (!notice || sink !== this.sink || !sink.canSend(notice.requestId)) return;
				if (await sink.deliver(notice)) {
					await this.rpc("acknowledge", { notice, now });
					await this.changed();
				}
			},
		});
		this.worker = new Worker(new URL("./watch-worker.ts", import.meta.url), { workerData: { path } });
		this.worker.on("message", (reply: { id: number; value?: unknown; error?: string }) => {
			const call = this.pending.get(reply.id);
			if (!call) return;
			this.pending.delete(reply.id);
			if (reply.error) call.reject(new Error(reply.error));
			else call.resolve(reply.value);
			if (!this.pending.size) this.worker.unref();
		});
		const fail = (error: Error) => {
			this.broken = error;
			for (const call of this.pending.values()) call.reject(error);
			this.pending.clear();
		};
		this.worker.on("error", fail);
		this.worker.on("exit", (code) => fail(new Error(`Watch worker exited (${code})`)));
		this.worker.unref();
		this.dispatcher.start();
		this.refreshExpiry();
	}
	bindSink(sink: WatchNoticeSink | undefined): void {
		this.sink = sink;
		if (sink)
			void this.rpc("self", sink.sessionId).catch((error) =>
				console.warn(`pilotd: watch identity failed: ${error}`),
			);
		this.dispatcher.schedule();
	}
	/** Call on control-chat state changes, including a return to idle. */
	sinkChanged(): void {
		this.dispatcher.schedule();
	}
	async observe(events: WatchObservation[]): Promise<number> {
		const matched = await this.rpc<number>("observe", { events, self: this.sink?.sessionId });
		if (matched) {
			await this.changed();
			this.dispatcher.schedule();
		}
		return matched;
	}
	async transition(input: WatchTransition): Promise<number> {
		const matched = await this.rpc<number>("transition", { input, self: this.sink?.sessionId });
		if (matched) {
			await this.changed();
			this.dispatcher.schedule();
		}
		return matched;
	}
	cursor(source: string): Promise<number> {
		return this.rpc("cursor", source);
	}
	async consume(source: string, events: WatchObservation[]): Promise<number> {
		const matched = await this.rpc<number>("consume", { source, events, self: this.sink?.sessionId });
		if (matched) {
			await this.changed();
			this.dispatcher.schedule();
		}
		return matched;
	}
	async flush(now = Date.now()): Promise<void> {
		await this.dispatcher.flush(now);
	}
	/** Tag an admitted start/send before its completion can publish. Suppressed once, durably. */
	async attributeSessionRun(
		sessionId: string,
		origin: string,
		requestIds: string[] = [],
		recoveredOnly = false,
	): Promise<void> {
		await this.rpc("attribute", { sessionId, origin, requestIds, recoveredOnly });
		if (requestIds.some((id) => id.startsWith("control:"))) await this.changed();
	}
	async followThrough(requestId: string, authorizationId: string, sessionId?: string): Promise<void> {
		await this.rpc("followThrough", { requestId, authorizationId, sessionId });
		await this.changed();
	}
	/** A newly created chat has no older run. Arm before startup can fail, without generic run attribution. */
	async followThroughCreated(sessionId: string, requestId: string): Promise<void> {
		await this.rpc("followThroughCreated", { sessionId, requestId });
		await this.changed();
	}
	async cancelFollowThrough(requestId: string, onlyQueued = false): Promise<void> {
		await this.rpc("cancelFollowThrough", { requestId, onlyQueued });
		await this.changed();
	}
	followThroughActive(requestId: string): Promise<boolean> {
		return this.rpc("followThroughActive", requestId);
	}
	async authorizationNeeded(item: ControlAuthorizationNeeded): Promise<void> {
		await this.rpc("authorizationNeeded", item);
		await this.changed();
	}
	async resolveAuthorization(id: string): Promise<boolean> {
		const resolved = await this.rpc<boolean>("resolveAuthorization", id);
		if (resolved) await this.changed();
		return resolved;
	}
	protected rpc<T>(op: string, args?: unknown): Promise<T> {
		if (this.closed || this.broken) return Promise.reject(this.broken ?? new Error("Watch service closed"));
		if (this.pending.size >= 256) return Promise.reject(new Error("Watch service overloaded"));
		const id = ++this.serial;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
			this.worker.ref();
			this.worker.postMessage({ id, op, args });
		});
	}
	async add(input: WatchInput): Promise<Watch> {
		const result = await this.rpc<Watch>("add", validateWatch(input));
		await this.changed();
		return result;
	}
	async remove(id: string): Promise<boolean> {
		const result = await this.rpc<boolean>("remove", id);
		if (result) await this.changed();
		return result;
	}
	bindRemovalAudit(audit: ((removal: WatchRemoval) => Promise<void>) | undefined): void {
		this.removalAudit = audit;
	}
	async removeTarget(kind: "chat" | "mission", id: string, reason: WatchRemoval["reason"]): Promise<number> {
		const removed = await this.rpc<number>("removeTarget", { kind, id, reason });
		// Implicit result watches can be removed even when the explicit-watch count is zero.
		await this.changed();
		this.dispatcher.schedule();
		await this.flushRemovalAudit();
		return removed;
	}
	/** Replay the durable audit outbox before accepting new lifecycle work on startup. */
	async flushRemovalAudit(): Promise<void> {
		if (this.auditing) {
			await this.auditing;
			return this.flushRemovalAudit();
		}
		if (!this.removalAudit) return;
		this.auditing = (async () => {
			while (this.removalAudit) {
				const rows = await this.rpc<WatchRemoval[]>("removalAudit");
				if (!rows.length) return;
				for (const removal of rows) {
					const audit = this.removalAudit;
					if (!audit) return;
					await audit(removal);
					await this.rpc("acknowledgeRemoval", removal.watch.id);
				}
			}
		})();
		try {
			await this.auditing;
		} finally {
			this.auditing = undefined;
		}
	}
	list(): Promise<Watch[]> {
		return this.rpc("list");
	}
	/** Trusted saved instruction, only when present in this frozen delivery. Includes fired one-time watches. */
	authority(id: string, requestId: string): Promise<Watch | undefined> {
		return this.rpc("authority", { id, requestId });
	}
	page(after?: string, limit = 40): Promise<import("@pilot/protocol").WatchesResponse> {
		if (after !== undefined && (typeof after !== "string" || !/^[a-f0-9-]{36}$/.test(after)))
			return Promise.reject(new Error("Invalid watch cursor"));
		if (!Number.isInteger(limit) || limit < 1 || limit > 100)
			return Promise.reject(new Error("limit must be 1..100"));
		return this.rpc("page", { after, limit });
	}
	targets(kind: WatchTarget["kind"]): Promise<WatchTarget[]> {
		return this.rpc("targets", kind);
	}
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	protected changed(): Promise<void> {
		this.refreshExpiry();
		return this.ready();
	}
	private refreshExpiry(): void {
		this.expiryDirty = true;
		if (this.expiryUpdate || this.closing) return;
		this.expiryUpdate = (async () => {
			while (this.expiryDirty && !this.closing) {
				this.expiryDirty = false;
				this.dashboardCache = await this.rpc("dashboard");
				for (const listener of this.listeners) listener();
				const at = await this.rpc<number | undefined>("expiry");
				clearTimeout(this.expiryTimer);
				if (at !== undefined && !this.closing) {
					this.expiryTimer = setTimeout(() => this.changed(), Math.max(1, Math.min(2147483647, at - Date.now())));
					this.expiryTimer.unref();
				}
			}
		})()
			.catch((error) => console.warn(`pilotd: watch expiry failed: ${error}`))
			.finally(() => {
				this.expiryUpdate = undefined;
			});
	}
	async close(): Promise<void> {
		if (this.closed) return;
		this.closing = true;
		clearTimeout(this.expiryTimer);
		await this.expiryUpdate;
		await this.auditing?.catch(() => {});
		await this.dispatcher.stop();
		try {
			await this.rpc("close");
		} finally {
			this.closed = true;
			this.listeners.clear();
			await this.worker.terminate();
		}
	}
}
