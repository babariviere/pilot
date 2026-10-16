import { Worker } from "node:worker_threads";
import { NoticeDispatcher } from "./notice-dispatcher.ts";
import type { WatchNotice, WatchNoticeSink, WatchObservation, WatchTransition } from "./watch-delivery.ts";
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
				if (await sink.deliver(notice)) await this.rpc("acknowledge", { notice, now });
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
	}
	bindSink(sink: WatchNoticeSink | undefined): void {
		this.sink = sink;
		this.dispatcher.schedule();
	}
	/** Call on control-chat state changes, including a return to idle. */
	sinkChanged(): void {
		this.dispatcher.schedule();
	}
	async observe(events: WatchObservation[]): Promise<number> {
		const matched = await this.rpc<number>("observe", { events, self: this.sink?.sessionId });
		if (matched) {
			this.changed();
			this.dispatcher.schedule();
		}
		return matched;
	}
	async transition(input: WatchTransition): Promise<number> {
		const matched = await this.rpc<number>("transition", { input, self: this.sink?.sessionId });
		if (matched) {
			this.changed();
			this.dispatcher.schedule();
		}
		return matched;
	}
	async flush(now = Date.now()): Promise<void> {
		await this.dispatcher.flush(now);
	}
	/** Tag an admitted start/send before its completion can publish. Suppressed once, durably. */
	attributeSessionRun(sessionId: string, origin: string): Promise<void> {
		return this.rpc("attribute", { sessionId, origin });
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
		this.changed();
		return result;
	}
	async remove(id: string): Promise<boolean> {
		const result = await this.rpc<boolean>("remove", id);
		if (result) this.changed();
		return result;
	}
	list(): Promise<Watch[]> {
		return this.rpc("list");
	}
	targets(kind: WatchTarget["kind"]): Promise<WatchTarget[]> {
		return this.rpc("targets", kind);
	}
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	protected changed(): void {
		for (const listener of this.listeners) listener();
	}
	async close(): Promise<void> {
		if (this.closed) return;
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
