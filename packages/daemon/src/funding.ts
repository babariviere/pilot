/** Async funding owner. SQLite and fsync run only on its worker. */
import { Worker } from "node:worker_threads";
import type { FundingOwner, FundingQuote, FundingTokens, FundingView } from "@pilot/protocol";
import { FundingRefused } from "./funding-errors.ts";
export class Funding {
	private readonly worker: Worker;
	private serial = 0;
	private fault?: Error;
	private readonly clock: () => number;
	private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
	/** This instance is the file's only writer, so a cached switch stays exact after the first read. */
	private limits?: Promise<boolean>;
	/** Requests let through while limits were off. Their settle has nothing to record. Oldest dropped first. */
	private readonly unlimited = new Set<string>();
	constructor(file: string, clock = Date.now) {
		this.clock = clock;
		this.worker = new Worker(new URL("./funding-worker.ts", import.meta.url), { workerData: { file } });
		this.worker.on("message", ({ id, value, error, refused }) => {
			const p = this.pending.get(id);
			this.pending.delete(id);
			if (error) p?.reject(refused ? new FundingRefused(error) : new Error(error));
			else p?.resolve(value);
			if (!this.pending.size) this.worker.unref();
		});
		const fail = (e: Error) => {
			this.fault = e;
			for (const p of this.pending.values()) p.reject(e);
			this.pending.clear();
		};
		this.worker.on("error", fail);
		this.worker.on("exit", () => fail(new Error("Funding owner closed")));
		this.worker.unref();
	}
	private rpc<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
		// 32 queued writes are roughly 112ms at the measured 3.50ms p95 reserve/settle pair.
		// This limits queued work, not a latency guarantee on slower disks (technical/funding.md).
		if (this.fault || this.pending.size >= 32) return Promise.reject(this.fault ?? new Error("Funding busy"));
		return new Promise((resolve, reject) => {
			const id = ++this.serial;
			this.pending.set(id, { resolve: (v) => resolve(v as T), reject });
			this.worker.ref();
			this.worker.postMessage({ id, method, args: { ...args, now: this.clock() } });
		});
	}
	read(projectId?: string): Promise<FundingView> {
		return this.rpc("read", { projectId });
	}
	/** Whether spending limits are on. Read once from disk, then kept in memory. */
	enabled(): Promise<boolean> {
		if (!this.limits) {
			this.limits = this.rpc<boolean>("enabled");
			this.limits.catch(() => {
				this.limits = undefined;
			});
		}
		return this.limits;
	}
	async setEnabled(expected: number, enabled: boolean): Promise<void> {
		try {
			await this.rpc("setEnabled", { expected, enabled });
		} finally {
			// A lost reply may or may not have saved; read the switch again.
			this.limits = undefined;
		}
	}
	/** Lets one request through without a reservation while limits are off. */
	skip(requestId: string): { id: string; maximumMicros: number } {
		this.unlimited.add(requestId);
		if (this.unlimited.size > 4096) this.unlimited.delete(this.unlimited.values().next().value!);
		return { id: requestId, maximumMicros: 0 };
	}
	/** True once for a request that {@link skip} let through. */
	skipped(requestId: string): boolean {
		return this.unlimited.delete(requestId);
	}
	configure(
		projectId: string | undefined,
		expected: number,
		value: Pick<FundingView, "missionDefaultMicros" | "quickFixDefaultMicros" | "dailyMicros">,
	): Promise<void> {
		return this.rpc("configure", { projectId, expected, value });
	}
	fund(owner: FundingOwner, expected: number, amount: number): Promise<void> {
		return this.rpc("fund", { owner, expected, amount });
	}
	open(owner: FundingOwner, amount: number): Promise<void> {
		return this.rpc("open", { owner, amount });
	}
	reserve(
		owner: FundingOwner,
		requestId: string,
		quote: FundingQuote,
		job = "agent",
	): Promise<{ id: string; maximumMicros: number }> {
		return this.rpc("reserve", { owner, requestId, quote, job });
	}
	settle(owner: FundingOwner, requestId: string, usage?: FundingTokens): Promise<void> {
		return this.rpc("settle", { owner, requestId, usage });
	}
	async close() {
		try {
			await this.rpc("close");
		} finally {
			await this.worker.terminate();
		}
	}
}
