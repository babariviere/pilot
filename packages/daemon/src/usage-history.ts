import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type {
	AIUsageAccounting,
	UsageHistoryPage,
	UsageHistoryQuery,
	UsageHistoryStatus,
	UsageHistoryWriteResult,
	UsageObservation,
} from "@pilot/protocol";
import { parseUsageObservation, USAGE_MAX_ROWS, USAGE_ROW_BYTES } from "./usage-history-validation.ts";

/** Trusted, local host API. No agent tool, telemetry serializer or network endpoint. */
export class UsageHistoryStore {
	private worker?: Worker;
	private serial = 0;
	private state: "open" | "closing" | "closed" = "open";
	private fault = false;
	private bytes = 0;
	private overflows = 0;
	private closing?: Promise<void>;
	private drained?: () => void;
	private maintenance?: Promise<UsageHistoryStatus>;
	private readonly home: string;
	private readonly erasureListeners = new Set<(status: UsageHistoryStatus) => Promise<void>>();
	/** Source adapters must drain/purge stale durable evidence before erasure acknowledges. */
	onErasure(listener: (status: UsageHistoryStatus) => Promise<void>): () => void {
		this.erasureListeners.add(listener);
		return () => this.erasureListeners.delete(listener);
	}
	private readonly clock: () => number;
	private readonly pending = new Map<
		number,
		{ bytes: number; resolve(value: unknown): void; reject(error: Error): void }
	>();
	constructor(home: string, clock: () => number = Date.now) {
		this.home = home;
		this.clock = clock;
	}

	private start(): Worker {
		if (this.worker) return this.worker;
		const worker = new Worker(new URL("./usage-history-worker.ts", import.meta.url), {
			workerData: { file: join(this.home, "accounting", "usage-history.sqlite"), now: this.clock() },
		});
		this.worker = worker;
		worker.on("message", ({ id, value, error }) => {
			const waiting = this.pending.get(id);
			if (!waiting) return;
			this.pending.delete(id);
			this.bytes -= waiting.bytes;
			if (error) waiting.reject(new Error("Usage history unavailable"));
			else waiting.resolve(value);
			this.idle();
		});
		const fail = () => {
			this.fault = true;
			for (const waiting of this.pending.values()) waiting.reject(new Error("Usage history unavailable"));
			this.pending.clear();
			this.bytes = 0;
			this.idle();
		};
		worker.on("error", fail);
		worker.on("exit", fail);
		worker.unref();
		return worker;
	}
	private idle(): void {
		if (this.pending.size) return;
		this.worker?.unref();
		const done = this.drained;
		this.drained = undefined;
		done?.();
	}
	private rpc<T>(method: string, args: Record<string, unknown> = {}, draining = false): Promise<T> {
		if ((!draining && this.state !== "open") || this.fault)
			return Promise.reject(new Error("Usage history unavailable"));
		let size: number;
		try {
			size = Buffer.byteLength(JSON.stringify(args));
		} catch {
			return Promise.reject(new Error("Invalid usage record"));
		}
		if (size > USAGE_ROW_BYTES + 1024 || this.pending.size >= 32 || this.bytes + size > 256 * 1024) {
			this.overflows = Math.min(Number.MAX_SAFE_INTEGER, this.overflows + 1);
			return Promise.reject(new Error("Usage history ingress full"));
		}
		return new Promise((resolve, reject) => {
			const worker = this.start();
			const id = ++this.serial;
			this.pending.set(id, {
				bytes: size,
				resolve: (value) => resolve(value as T),
				reject,
			});
			this.bytes += size;
			worker.ref();
			try {
				worker.postMessage({ id, method, args: { ...args, now: this.clock() } });
			} catch {
				this.pending.get(id)!.reject(new Error("Invalid usage message"));
				this.pending.delete(id);
				this.bytes -= size;
				this.idle();
			}
		});
	}
	async status(): Promise<UsageHistoryStatus> {
		return { ...(await this.rpc<UsageHistoryStatus>("status")), queueOverflows: this.overflows };
	}
	put(row: UsageObservation): Promise<UsageHistoryWriteResult> {
		try {
			return this.rpc("put", { row: parseUsageObservation(row) });
		} catch {
			// Send only a fixed rejection marker, never an oversized/unallowlisted payload.
			return this.rpc("put", {});
		}
	}
	/** Content-free adapter admission failure. Uses the same durable rejection counter and bounded ingress. */
	rejectCapture(): void {
		void this.rpc("put", {}).catch(() => undefined);
	}
	async page(query: UsageHistoryQuery): Promise<UsageHistoryPage> {
		if (query.after !== undefined && (typeof query.after !== "string" || query.after.length > 1024))
			throw new Error("Invalid usage cursor");
		const { kind, from, to, limit, after } = query;
		const page = await this.rpc<UsageHistoryPage>("page", { query: { kind, from, to, limit, after } });
		page.status.queueOverflows = this.overflows;
		return page;
	}
	expire(): Promise<UsageHistoryStatus> {
		if (this.maintenance) return this.maintenance;
		const pending = this.rpc<UsageHistoryStatus>("expire");
		this.maintenance = pending;
		void pending
			.finally(() => {
				if (this.maintenance === pending) this.maintenance = undefined;
			})
			.catch(() => undefined);
		return pending;
	}
	async eraseChat(chatId: string): Promise<UsageHistoryStatus> {
		const status = await this.rpc<UsageHistoryStatus>("erase", { chatId });
		await Promise.all([...this.erasureListeners].map((listener) => listener(status)));
		return status;
	}
	async clear(): Promise<UsageHistoryStatus> {
		const status = await this.rpc<UsageHistoryStatus>("erase");
		await Promise.all([...this.erasureListeners].map((listener) => listener(status)));
		return status;
	}

	/** Bounded compatibility migration only. No transcript scans, guessed dates or model attribution. */
	async importLegacy(chatId: string, summary: AIUsageAccounting): Promise<boolean> {
		const status = await this.status();
		// Undated cumulative summaries cannot be split at an erasure boundary. Never reimport them
		// after any erasure, even if a later usage publication advances their observedAt timestamp.
		if (status.captureFloor > 0 || status.retainedRows >= USAGE_MAX_ROWS) return false;
		if (summary.observedAt < Math.max(status.captureFloor, status.retentionFloor)) return true;
		for (const scope of ["direct", "child"] as const) {
			const result = await this.put({
				schemaVersion: 1,
				generation: status.generation,
				sourceId: chatId,
				operationId: `legacy:${scope}`,
				revision: Math.max(1, Math.floor(summary.observedAt)),
				kind: "checkpoint",
				scope,
				observedAt: Math.floor(summary.observedAt),
				coverage: "legacy",
				purpose: "unknown",
				attribution: { chatId },
				tokens: summary[scope].tokens,
				cost: summary[scope].cost,
			});
			if (result === "rejected" || result === "conflict") return false;
		}
		return true;
	}

	/** Start idle retention for an existing database without creating one in empty/test homes. */
	async maintainExisting(): Promise<void> {
		try {
			await lstat(join(this.home, "accounting", "usage-history.sqlite"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw new Error("Usage history unavailable");
		}
		await this.expire();
	}
	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.state = "closing";
		this.closing = (async () => {
			try {
				// Wait for pending calls to settle before placing the close barrier (queue may be full).
				if (this.pending.size)
					await new Promise<void>((done) => {
						this.drained = done;
					});
				if (this.worker && !this.fault) await this.rpc("close", {}, true);
			} finally {
				this.state = "closed";
				await this.worker?.terminate();
			}
		})();
		return this.closing;
	}
}
