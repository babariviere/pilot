/** Keep SQLite scans and snapshot construction off the daemon's WebSocket event loop. */
import { Worker } from "node:worker_threads";
import {
	type EarlierEntriesRead,
	type PersistedSessionView,
	type SubagentTranscriptRead,
	snapshotWorkerEntry,
} from "@pilot/kernel";
import type { DiagnosticHistoryPage, DiagnosticTargetReference } from "@pilot/protocol";
import { ServiceUnavailable } from "./errors.ts";
import { isWatchNotice } from "./worker-notice.ts";

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
	/** Read a page of entries hidden by compaction instead of the active view. */
	earlier?: { before: number; limit: number };
	/** Read a bounded page from one explicitly authorized diagnostics target. */
	diagnosticHistory?: { target: DiagnosticTargetReference; before?: number; limit: number };
	todoCount?: boolean;
	resolve(view: SizedSessionView): void;
	reject(error: Error): void;
};

export class ColdViewReader {
	private readonly waiting: Job[] = [];
	private readonly active = new Set<Worker>();
	private closed = false;
	/** The reader entry is injectable so a test can post a foreign message first. */
	private readonly entry: URL;

	constructor(entry: URL = snapshotWorkerEntry) {
		this.entry = entry;
	}

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

	/** One-shot read of the session's entries below `before`, hidden from the active view by compaction. */
	readEarlier(directory: string, before: number, limit: number): Promise<EarlierEntriesRead> {
		if (this.closed) return Promise.reject(new Error("Session reader is closed"));
		if (this.waiting.length >= MAX_QUEUED_READS)
			return Promise.reject(new ServiceUnavailable("Session history is busy. Retry shortly."));
		return new Promise<SizedSessionView>((resolve, reject) => {
			this.waiting.push({
				directory,
				cwd: directory,
				includeTodos: false,
				earlier: { before, limit },
				resolve,
				reject,
			});
			this.drain();
		}).then(({ bytes: _bytes, ...view }) => view as unknown as EarlierEntriesRead);
	}

	/** One-shot bounded target-history read. The worker truncates content before crossing the daemon boundary. */
	readDiagnosticHistory(
		directory: string,
		target: DiagnosticTargetReference,
		before: number | undefined,
		limit: number,
	): Promise<DiagnosticHistoryPage> {
		if (this.closed) return Promise.reject(new Error("Session reader is closed"));
		if (this.waiting.length >= MAX_QUEUED_READS)
			return Promise.reject(new ServiceUnavailable("Session history is busy. Retry shortly."));
		return new Promise<SizedSessionView>((resolve, reject) => {
			this.waiting.push({
				directory,
				cwd: directory,
				includeTodos: false,
				diagnosticHistory: { target, ...(before === undefined ? {} : { before }), limit },
				resolve,
				reject,
			});
			this.drain();
		}).then(({ bytes: _bytes, ...view }) => view as unknown as DiagnosticHistoryPage);
	}

	/** Read only the small progress document, never transcript entries or Markdown bodies. */
	readTodoCount(directory: string): Promise<number> {
		if (this.closed) return Promise.reject(new Error("Session reader is closed"));
		if (this.waiting.length >= MAX_QUEUED_READS)
			return Promise.reject(new ServiceUnavailable("Session history is busy. Retry shortly."));
		return new Promise<SizedSessionView>((resolve, reject) => {
			this.waiting.push({ directory, cwd: directory, includeTodos: false, todoCount: true, resolve, reject });
			this.drain();
		}).then((view) => (view as unknown as { openCount: number }).openCount);
	}

	/** Fresh, bounded provenance read. Never uses the transcript snapshot cache. */
	private drain(): void {
		while (!this.closed && this.active.size < 2 && this.waiting.length) {
			const job = this.waiting.shift()!;
			job.unlisten?.();
			let worker: Worker;
			try {
				worker = new Worker(this.entry, {
					workerData: {
						directory: job.directory,
						cwd: job.cwd,
						includeTodos: job.includeTodos,
						...(job.subagentConversation === undefined ? {} : { subagentConversation: job.subagentConversation }),
						...(job.after === undefined ? {} : { after: job.after }),
						...(job.earlier === undefined ? {} : { earlier: job.earlier }),
						...(job.diagnosticHistory === undefined ? {} : { diagnosticHistory: job.diagnosticHistory }),
						...(job.todoCount ? { todoCount: true } : {}),
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
			worker.on("message", (packet: { view?: PersistedSessionView; bytes?: number; error?: string }) => {
				// Node's watch mode posts module-watch notices to the worker's parent port.
				// They are not read results and must not consume the one real answer.
				if (isWatchNotice(packet)) return;
				if (received) return;
				received = true;
				clearTimeout(timer);
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
