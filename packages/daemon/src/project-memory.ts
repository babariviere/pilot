import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type {
	MemoryEntry,
	MemoryNode,
	MemoryRecall,
	MemoryTree,
	MemoryView,
	ProjectMemorySummary,
	SharedMemoryMutation,
	SharedMemoryCommitOutcome,
	SharedMemoryCheckpointManifest,
	SharedMemoryCheckpointPage,
	SharedMemoryChangePage,
	SharedMemoryReplicaState,
	SharedMemoryProposal,
	SharedMemoryRead,
	OperationHost,
} from "@pilot/protocol";
import { Conflict, ServiceUnavailable } from "./errors.ts";
import { captureMemory, type MemoryCompactionObserver, type MemoryCompactionTrace } from "./memory-compaction.ts";
import type { MemoryTreeOptions } from "./memory-disk.ts";
import { checkBindingKey } from "./shared-memory-common.ts";

type Nap = { lo: number; hi: number; epoch: number; prompt: string };
export type MemorySummarizer = (
	prompt: string,
	signal: AbortSignal,
	observe: MemoryCompactionObserver,
) => Promise<string>;
export function emptyMemorySummary(): ProjectMemorySummary {
	return { count: 0, recent: [], compaction: { state: "idle", pending: 0 } };
}

/** Disk RPC and background compaction. No model work is awaited by public read/write operations. */
export class ProjectMemoryService {
	private readonly root: string;
	private readonly worker: Worker;
	private serial = 0;
	private pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void; projectId: string }
	>();
	private summaries = new Map<string, ProjectMemorySummary>();
	private listeners = new Set<() => void>();
	private queue = new Set<string>();
	private running = new Map<string, AbortController>();
	private retries = new Map<string, { attempt: number; timer: NodeJS.Timeout; at: number; error: string }>();
	private failures = new Map<string, number>();
	private recalls = new Map<Worker, (error: Error) => void>();
	private stopped = false;
	private retired = new Set<string>();
	private broken?: Error;
	private readonly summarize?: MemorySummarizer;
	private readonly retryBaseMs: number;
	constructor(home: string, summarize?: MemorySummarizer, retryBaseMs = 30_000, originHost?: OperationHost) {
		this.summarize = summarize;
		this.retryBaseMs = retryBaseMs;
		this.root = join(home, "memory");
		this.worker = new Worker(new URL("./memory-worker.ts", import.meta.url), {
			workerData: { root: this.root, originHost },
		});
		this.worker.on(
			"message",
			(reply: {
				id: number;
				value?: unknown;
				error?: string;
				conflict?: boolean;
				summary?: ProjectMemorySummary;
			}) => {
				const pending = this.pending.get(reply.id);
				if (!pending) return;
				this.pending.delete(reply.id);
				if (reply.summary) {
					this.summaries.set(pending.projectId, reply.summary);
					this.emit();
				}
				if (reply.error) pending.reject(reply.conflict ? new Conflict(reply.error) : new Error(reply.error));
				else pending.resolve(reply.value);
				if (!this.pending.size) this.worker.unref();
			},
		);
		const fail = (error: Error) => {
			this.broken = error;
			for (const p of this.pending.values()) p.reject(error);
			this.pending.clear();
		};
		this.worker.on("error", fail);
		this.worker.on("exit", (code) => fail(new Error(`Memory worker exited (${code})`)));
		this.worker.unref();
	}
	private rpc<T>(projectId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
		if (this.stopped || this.broken)
			return Promise.reject(this.broken ?? new ServiceUnavailable("Memory service stopped"));
		if (this.pending.size >= 64) return Promise.reject(new ServiceUnavailable("Memory store busy, retry shortly"));
		return new Promise((resolve, reject) => {
			const id = ++this.serial;
			this.pending.set(id, { resolve: (value) => resolve(value as T), reject, projectId });
			this.worker.ref();
			this.worker.postMessage({ id, projectId, method, args });
		});
	}
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	private emit(): void {
		for (const listener of this.listeners) listener();
	}
	summary(projectId: string): ProjectMemorySummary {
		const summary = this.summaries.get(projectId) ?? emptyMemorySummary(),
			retry = this.retries.get(projectId);
		return {
			...summary,
			compaction: {
				pending: summary.compaction.pending,
				state: retry
					? "backoff"
					: this.running.has(projectId)
						? "running"
						: summary.compaction.pending
							? "pending"
							: "idle",
				...(retry ? { error: retry.error, retryAt: retry.at } : {}),
			},
		};
	}
	async load(projectId: string): Promise<ProjectMemorySummary> {
		this.retired.delete(projectId);
		await this.rpc(projectId, "load");
		this.schedule(projectId);
		return this.summary(projectId);
	}
	/** Release a removed project's lock and cancel its queued work. The durable log is retained. */
	async unload(projectId: string): Promise<void> {
		this.retired.add(projectId);
		this.queue.delete(projectId);
		const retry = this.retries.get(projectId);
		if (retry) clearTimeout(retry.timer);
		this.retries.delete(projectId);
		this.failures.delete(projectId);
		this.running.get(projectId)?.abort();
		await this.rpc(projectId, "unload");
		this.summaries.delete(projectId);
		this.emit();
	}
	/** `replaces` lists indices of notes this one corrects; a normalized duplicate of a live note is a Conflict. */
	async note(projectId: string, text: string, sessionId: string, replaces?: number[]): Promise<MemoryEntry> {
		const entry = await this.rpc<MemoryEntry>(projectId, "note", { text, sessionId, replaces });
		this.schedule(projectId);
		return entry;
	}
	async commitSharedNote(projectId: string, mutation: SharedMemoryMutation): Promise<SharedMemoryCommitOutcome> {
		const outcome = await this.rpc<SharedMemoryCommitOutcome>(projectId, "commitSharedNote", { mutation });
		this.schedule(projectId);
		return outcome;
	}
	beginCheckpoint(projectId: string): Promise<SharedMemoryCheckpointManifest> {
		return this.rpc(projectId, "beginCheckpoint");
	}
	checkpointPage(projectId: string, checkpointId: string, cursor: number): Promise<SharedMemoryCheckpointPage> {
		return this.rpc(projectId, "checkpointPage", { checkpointId, cursor });
	}
	changes(projectId: string, after: number, limit?: number): Promise<SharedMemoryChangePage> {
		return this.rpc(projectId, "changes", { after, limit });
	}
	stageReplica(
		bindingKey: string,
		manifest: SharedMemoryCheckpointManifest,
		page: SharedMemoryCheckpointPage,
	): Promise<void> {
		return this.rpc(bindingKey, "replica.stage", { manifest, page });
	}
	activateReplica(bindingKey: string, manifestId: string): Promise<void> {
		return this.rpc(bindingKey, "replica.activate", { manifestId });
	}
	applyReplicaChanges(bindingKey: string, batch: SharedMemoryChangePage): Promise<SharedMemoryReplicaState> {
		return this.rpc(bindingKey, "replica.changes", { batch });
	}
	queueReplicaProposal(bindingKey: string, mutation: SharedMemoryMutation): Promise<SharedMemoryProposal> {
		return this.rpc(bindingKey, "replica.queue", { mutation });
	}
	replicaProposals(bindingKey: string): Promise<SharedMemoryProposal[]> {
		return this.rpc(bindingKey, "replica.proposals");
	}
	applyProposalOutcome(bindingKey: string, outcome: SharedMemoryCommitOutcome): Promise<void> {
		return this.rpc(bindingKey, "replica.outcome", { outcome });
	}
	replicaState(bindingKey: string): Promise<SharedMemoryReplicaState> {
		return this.rpc(bindingKey, "replica.state");
	}
	async replicaRead(
		bindingKey: string,
		action: "wake" | "recall" | "zoom",
		args: Record<string, unknown>,
	): Promise<SharedMemoryRead> {
		if (action !== "recall") return this.rpc(bindingKey, "replica.read", { action, args });
		checkBindingKey(bindingKey);
		const regex = args.regex,
			lines = args.lines ?? 96;
		if (
			typeof regex !== "string" ||
			regex.length > 512 ||
			!Number.isInteger(lines) ||
			Number(lines) < 1 ||
			Number(lines) > 256
		)
			throw new Error("Invalid recall regex or line limit");
		new RegExp(regex, "i");
		if (this.recalls.size >= 2) throw new ServiceUnavailable("Memory search busy, retry shortly");
		await this.replicaState(bindingKey); // Ensure the database exists before opening the isolated reader.
		if (this.stopped) throw new ServiceUnavailable("Memory service stopped");
		if (this.recalls.size >= 2) throw new ServiceUnavailable("Memory search busy, retry shortly");
		return new Promise((resolve, reject) => {
			const worker = new Worker(new URL("./memory-worker.ts", import.meta.url), {
				workerData: {
					replicaRecall: { path: join(this.root, "shared-replicas", `${bindingKey}.sqlite`), regex, lines },
				},
			});
			const finish = (error?: Error, value?: SharedMemoryRead) => {
				if (!this.recalls.delete(worker)) return;
				clearTimeout(timer);
				void worker.terminate();
				if (error) reject(error);
				else resolve(value!);
			};
			this.recalls.set(worker, (error) => finish(error));
			const timer = setTimeout(
				() => finish(new Error("Memory search exceeded its 5-second limit; narrow the regex")),
				5_000,
			);
			worker.on("message", (reply) => finish(reply.error ? new Error(reply.error) : undefined, reply.value));
			worker.on("error", (error) => finish(error));
			worker.on("exit", (code) => finish(new Error(`Memory search exited (${code})`)));
		});
	}
	wake(projectId: string, lines = 96): Promise<MemoryView> {
		return this.rpc(projectId, "wake", { lines });
	}
	zoom(projectId: string, lo: number, hi: number): Promise<MemoryNode[]> {
		return this.rpc(projectId, "zoom", { lo, hi });
	}
	/** A bounded slice of the browsing tree: top-level blocks or one range's children, to a depth or along reveal paths. */
	tree(projectId: string, options: MemoryTreeOptions = {}): Promise<MemoryTree> {
		return this.rpc(projectId, "tree", { ...options });
	}
	async forget(projectId: string, lo: number, hi: number): Promise<{ ok: true }> {
		const result = await this.rpc<{ ok: true }>(projectId, "forget", { lo, hi });
		this.schedule(projectId);
		return result;
	}
	async recall(projectId: string, regex: string, lines = 96): Promise<MemoryRecall> {
		if (typeof regex !== "string" || regex.length > 512 || !Number.isInteger(lines) || lines < 1 || lines > 256)
			throw new Error("Invalid recall regex or line limit");
		// Compilation is cheap; matching untrusted regexes happens only in an isolated worker.
		new RegExp(regex, "i");
		if (this.recalls.size >= 2) throw new ServiceUnavailable("Memory search busy, retry shortly");
		const snapshot = await this.rpc<ProjectMemorySummary>(projectId, "load");
		if (this.stopped) throw new ServiceUnavailable("Memory service stopped");
		if (this.recalls.size >= 2) throw new ServiceUnavailable("Memory search busy, retry shortly");
		return new Promise((resolve, reject) => {
			const worker = new Worker(new URL("./memory-worker.ts", import.meta.url), {
				workerData: { recall: { dir: join(this.root, projectId), count: snapshot.count, regex, lines } },
			});
			const finish = (error?: Error, value?: MemoryRecall) => {
				if (!this.recalls.delete(worker)) return;
				clearTimeout(timer);
				void worker.terminate();
				if (error) reject(error);
				else resolve(value!);
			};
			this.recalls.set(worker, (error) => finish(error));
			const timer = setTimeout(
				() => finish(new Error("Memory search exceeded its 5-second limit; narrow the regex")),
				5_000,
			);
			worker.on("message", (reply) => finish(reply.error ? new Error(reply.error) : undefined, reply.value));
			worker.on("error", (error) => finish(error));
			worker.on("exit", (code) => finish(new Error(`Memory search exited (${code})`)));
		});
	}
	private schedule(projectId: string): void {
		if (
			this.stopped ||
			this.retired.has(projectId) ||
			!this.summarize ||
			!this.summary(projectId).compaction.pending ||
			this.retries.has(projectId)
		)
			return;
		this.queue.add(projectId);
		this.pump();
	}
	private pump(): void {
		if (this.stopped || !this.summarize) return;
		for (const projectId of this.queue) {
			if (this.running.size >= 2) break;
			if (this.running.has(projectId)) continue;
			this.queue.delete(projectId);
			const controller = new AbortController();
			this.running.set(projectId, controller);
			this.emit();
			void this.compact(projectId, controller);
		}
	}
	private async compact(projectId: string, controller: AbortController): Promise<void> {
		let timer: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;
		let trace: MemoryCompactionTrace | undefined;
		let diagnosticFailed = false;
		const saveTrace = async () => {
			if (!trace || this.stopped || this.retired.has(projectId)) return;
			try {
				await this.rpc(projectId, "diagnostic", { trace });
			} catch {
				// Diagnostics must not block valid summaries or leak private payloads in general logs.
				if (!diagnosticFailed) console.warn(`pilotd: memory ${projectId}: could not save compaction diagnostics`);
				diagnosticFailed = true;
			}
		};
		try {
			const nap = await this.rpc<Nap | undefined>(projectId, "next");
			if (!nap || this.stopped || controller.signal.aborted) return;
			trace = {
				version: 1,
				lo: nap.lo,
				hi: nap.hi,
				epoch: nap.epoch,
				startedAt: Date.now(),
				status: "running",
				prompt: captureMemory(nap.prompt),
				attempts: [],
			};
			await saveTrace();
			if (this.stopped || controller.signal.aborted) return;
			// Do not rely on a provider honoring cancellation to free the queue or stop the daemon.
			const aborted = new Promise<never>((_, reject) => {
				onAbort = () => reject(new Error("Memory compaction aborted or timed out"));
				controller.signal.addEventListener("abort", onAbort, { once: true });
			});
			timer = setTimeout(() => controller.abort(), 60_000);
			timer.unref();
			const text = await Promise.race([
				this.summarize!(nap.prompt, controller.signal, async (attempt) => {
					if (controller.signal.aborted || !trace || trace.status !== "running") return;
					if (attempt.number >= 1 && attempt.number <= 3) trace.attempts[attempt.number - 1] = attempt;
					await saveTrace();
				}),
				aborted,
			]);
			if (this.stopped || controller.signal.aborted) return;
			const stored = await this.rpc<boolean>(projectId, "put", { ...nap, text });
			trace.status = stored ? "succeeded" : "failed";
			if (!stored) trace.error = "Source memories changed during compaction; summary was not stored";
			trace.finishedAt = Date.now();
			await saveTrace();
			this.failures.delete(projectId);
		} catch (error) {
			if (trace) {
				trace.status = "failed";
				trace.finishedAt = Date.now();
				trace.error = "Compaction failed or was interrupted; inspect attempts for validation details";
				trace.failure = captureMemory(
					error instanceof Error ? { name: error.name, message: error.message } : String(error),
				);
				await saveTrace();
			}
			if (!this.stopped && !this.retired.has(projectId)) {
				this.queue.delete(projectId);
				const attempt = (this.failures.get(projectId) ?? 0) + 1;
				this.failures.set(projectId, attempt);
				const delay = Math.min(30 * 60_000, this.retryBaseMs * 2 ** Math.min(attempt - 1, 10));
				const retry = {
					attempt,
					at: Date.now() + delay,
					error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
					timer: setTimeout(() => {
						this.retries.delete(projectId);
						this.schedule(projectId);
					}, delay),
				};
				retry.timer.unref();
				this.retries.set(projectId, retry);
			}
		} finally {
			clearTimeout(timer);
			if (onAbort) controller.signal.removeEventListener("abort", onAbort);
			this.running.delete(projectId);
			this.emit();
			this.schedule(projectId);
			this.pump();
		}
	}
	async stop(): Promise<void> {
		this.stopped = true;
		this.queue.clear();
		for (const retry of this.retries.values()) clearTimeout(retry.timer);
		this.retries.clear();
		for (const controller of this.running.values()) controller.abort();
		for (const fail of this.recalls.values()) fail(new Error("Memory service stopped"));
		await this.worker.terminate();
		this.listeners.clear();
	}
}
