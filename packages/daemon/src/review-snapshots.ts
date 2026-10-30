import { stat } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import type { JjOwnershipStore } from "./jj-ownership.ts";
import type { JjOwnershipBinding } from "./jj-ownership-contract.ts";
import {
	captureRequest,
	type ReviewCaptureRequest,
	type ReviewSnapshot,
	type ReviewSourceRef,
} from "./review-snapshot-contract.ts";

export type { ReviewCaptureRequest, ReviewSnapshot, ReviewSourceRef } from "./review-snapshot-contract.ts";

/**
 * Internal host API only. Calling capture authorizes exactly this comparison, not arbitrary files,
 * task attribution or acceptance. A future transport must separately authorize access before calling.
 * No live enrollment, startup capture, review engine or cleanup behavior is installed here.
 */
export class ReviewSnapshotStore {
	private worker?: Worker;
	private fault?: Error;
	private serial = 0;
	private closing = false;
	private capturing = false;
	private drain?: Promise<void>;
	private readonly pending = new Map<
		number,
		{ resolve(value: unknown): void; reject(error: Error): void; done: Promise<unknown> }
	>();
	private readonly file: string;
	private readonly ledger: Pick<JjOwnershipStore, "get">;
	constructor(file: string, ledger: Pick<JjOwnershipStore, "get">) {
		this.file = file;
		this.ledger = ledger;
	}

	private rpc<T>(method: string, args: object, signal?: AbortSignal): Promise<T> {
		if (this.fault) return Promise.reject(this.fault);
		if (this.pending.size >= 8) return Promise.reject(new Error("Snapshot store busy"));
		signal?.throwIfAborted();
		if (!this.worker) {
			const worker = new Worker(new URL("./review-snapshot-worker.ts", import.meta.url), {
				workerData: { file: this.file },
			});
			this.worker = worker;
			worker.on("message", ({ id, value, error }) => {
				const waiter = this.pending.get(id);
				if (!waiter) return;
				this.pending.delete(id);
				if (error) waiter.reject(new Error(error));
				else waiter.resolve(value);
				if (!this.pending.size) worker.unref();
			});
			const fail = (error: Error) => {
				this.fault = error;
				for (const waiter of this.pending.values()) waiter.reject(error);
				this.pending.clear();
			};
			worker.on("error", fail);
			worker.on("exit", (code) => fail(new Error(`Snapshot worker exited (${code})`)));
			worker.unref();
		}
		const id = ++this.serial;
		let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
		const done = new Promise<T>((yes, no) => {
			resolve = (value) => yes(value as T);
			reject = no;
		});
		this.pending.set(id, { resolve, reject, done });
		const abort = () => this.worker!.postMessage({ cancel: id });
		signal?.addEventListener("abort", abort, { once: true });
		this.worker.ref();
		this.worker.postMessage({ id, method, args });
		return done.finally(() => signal?.removeEventListener("abort", abort));
	}
	private open() {
		if (this.closing) throw new Error("Snapshot store closed");
	}

	async capture(input: ReviewCaptureRequest, signal?: AbortSignal): Promise<ReviewSnapshot> {
		this.open();
		if (this.capturing) throw new Error("Snapshot capture busy");
		const request = captureRequest(input);
		this.capturing = true;
		try {
			const prior = await this.rpc<{ status: "absent" | "interrupted" | "done"; snapshot?: ReviewSnapshot }>(
				"lookup",
				{ request },
				signal,
			);
			if (prior.status === "done") return prior.snapshot!;
			const provenance =
				prior.status === "absent"
					? {
							capturedAt: Date.now(),
							ledger: await this.ledger.get(request.repositoryId, request.changeId),
							taskAttribution: "unknown",
						}
					: undefined;
			this.open();
			return await this.rpc("capture", { request, provenance }, signal);
		} finally {
			this.capturing = false;
		}
	}

	private async exists(): Promise<boolean> {
		return (
			this.worker !== undefined ||
			stat(this.file).then(
				() => true,
				(e: NodeJS.ErrnoException) => {
					if (e.code !== "ENOENT") throw e;
					return false;
				},
			)
		);
	}
	async get(snapshotId: string): Promise<ReviewSnapshot> {
		this.open();
		if (!(await this.exists())) throw new Error("No retained comparison store");
		return this.rpc("get", { snapshotId });
	}
	/** Read-only discovery never creates a store or captures a comparison. */
	async list(
		binding: JjOwnershipBinding,
		after = 0,
	): Promise<{
		comparisons: {
			snapshotId: string;
			sequence: number;
			capturedAt: number;
			request: ReviewCaptureRequest;
			status: ReviewSnapshot["manifest"]["status"];
		}[];
		next: number | null;
	}> {
		this.open();
		if (!(await this.exists())) return { comparisons: [], next: null };
		return this.rpc("list", { binding, after });
	}
	async read(snapshotId: string, ref: ReviewSourceRef): Promise<Uint8Array> {
		this.open();
		if (!(await this.exists())) throw new Error("No retained comparison store");
		return this.rpc("read", { snapshotId, ref });
	}
	async diff(snapshotId: string): Promise<Uint8Array> {
		this.open();
		if (!(await this.exists())) throw new Error("No retained comparison store");
		return this.rpc("diff", { snapshotId });
	}
	/** Exact-operation recovery, not a freshness check or permission to retry a different comparison. */
	lookup(
		input: ReviewCaptureRequest,
	): Promise<{ status: "absent" | "interrupted" | "done"; snapshot?: ReviewSnapshot }> {
		this.open();
		return this.rpc("lookup", { request: captureRequest(input) });
	}

	close(): Promise<void> {
		if (this.drain) return this.drain;
		this.closing = true;
		this.drain = (async () => {
			for (const id of this.pending.keys()) this.worker?.postMessage({ cancel: id });
			await Promise.allSettled([...this.pending.values()].map((p) => p.done));
			if (this.worker) {
				try {
					if (!this.fault) await this.rpc("close", {});
				} finally {
					await this.worker.terminate();
				}
			}
		})();
		return this.drain;
	}
}
