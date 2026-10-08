/** Keep SQLite scans and snapshot construction off the daemon's WebSocket event loop. */
import { Worker } from "node:worker_threads";
import { type PersistedSessionView, type SubagentTranscriptRead, snapshotWorkerEntry } from "@pilot/kernel";
import { ServiceUnavailable } from "./errors.ts";

const MAX_QUEUED_READS = 32;

export type SizedSessionView = PersistedSessionView & { bytes: number };
type Job = {
	directory: string;
	cwd: string;
	includeTodos: boolean;
	promise?: Promise<PersistedSessionView>;
	unlisten?(): void;
	/** Read a pi-extensions subagent conversation from `runs.sqlite` instead of the session. */
	subagentConversation?: string;
	after?: number;
	resolve(view: SizedSessionView): void;
	reject(error: Error): void;
};

export class ColdViewReader {
	private readonly waiting: Job[] = [];
	private readonly active = new Set<Worker>();
	private closed = false;

	/** Abort only queued work. Once started, a read can still populate a shared snapshot cache. */
	read(directory: string, cwd: string, includeTodos = true, signal?: AbortSignal): Promise<SizedSessionView> {
		if (this.closed) return Promise.reject(new Error("Session reader is closed"));
		if (signal?.aborted) return Promise.reject(new DOMException("Session snapshot read cancelled", "AbortError"));
		if (this.waiting.length >= MAX_QUEUED_READS)
			return Promise.reject(new ServiceUnavailable("Session history is busy. Retry shortly."));
		let job!: Job;
		const promise = new Promise<SizedSessionView>((resolve, reject) => {
			job = { directory, cwd, includeTodos, resolve, reject };
			if (signal) {
				const cancel = () => this.cancelQueued(job);
				job.unlisten = () => signal.removeEventListener("abort", cancel);
				signal.addEventListener("abort", cancel, { once: true });
			}
			this.waiting.push(job);
			this.drain();
		});
		job.promise = promise;
		return promise;
	}

	/** Return whether the shared read was still queued and has now been cancelled. */
	cancel(promise: Promise<PersistedSessionView>): boolean {
		const job = this.waiting.find((job) => job.promise === promise);
		return job ? this.cancelQueued(job) : false;
	}

	private cancelQueued(job: Job): boolean {
		const index = this.waiting.indexOf(job);
		if (index < 0) return false;
		this.waiting.splice(index, 1);
		job.unlisten?.();
		job.reject(new DOMException("Session snapshot read cancelled", "AbortError"));
		return true;
	}

	/** One-shot read of a subagent conversation, optionally only entries after `after`. */
	readSubagent(directory: string, conversationId: string, after?: number): Promise<SubagentTranscriptRead> {
		if (this.closed) return Promise.reject(new Error("Session reader is closed"));
		if (this.waiting.length >= MAX_QUEUED_READS)
			return Promise.reject(new ServiceUnavailable("Session history is busy. Retry shortly."));
		return new Promise<SizedSessionView>((resolve, reject) => {
			this.waiting.push({
				directory,
				cwd: directory,
				includeTodos: false,
				subagentConversation: conversationId,
				...(after === undefined ? {} : { after }),
				resolve,
				reject,
			});
			this.drain();
		}).then(({ bytes: _bytes, ...view }) => view as unknown as SubagentTranscriptRead);
	}

	private drain(): void {
		while (!this.closed && this.active.size < 2 && this.waiting.length) {
			const job = this.waiting.shift()!;
			job.unlisten?.();
			let worker: Worker;
			try {
				worker = new Worker(snapshotWorkerEntry, {
					workerData: {
						directory: job.directory,
						cwd: job.cwd,
						includeTodos: job.includeTodos,
						...(job.subagentConversation === undefined ? {} : { subagentConversation: job.subagentConversation }),
						...(job.after === undefined ? {} : { after: job.after }),
					},
					execArgv: [],
				});
			} catch (error) {
				job.reject(error instanceof Error ? error : new Error(String(error)));
				continue;
			}
			this.active.add(worker);
			let received = false;
			const timer = setTimeout(() => {
				job.reject(new Error("Session snapshot read timed out"));
				void worker.terminate();
			}, 30_000);
			timer.unref();
			worker.once("message", (packet: { view?: PersistedSessionView; bytes?: number; error?: string }) => {
				received = true;
				if (packet.view && typeof packet.bytes === "number") job.resolve({ ...packet.view, bytes: packet.bytes });
				else job.reject(new Error(packet.error ?? "Invalid session snapshot result"));
			});
			worker.once("error", (error) => {
				received = true;
				job.reject(error);
			});
			worker.once("exit", (code) => {
				clearTimeout(timer);
				this.active.delete(worker);
				if (!received) job.reject(new Error(`Session reader exited with code ${code}`));
				this.drain();
			});
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const job of this.waiting.splice(0)) {
			job.unlisten?.();
			job.reject(new Error("Session reader is closed"));
		}
		await Promise.all([...this.active].map((worker) => worker.terminate()));
	}
}
