/**
 * Off-thread subprocesses for pilotd. Node's spawn is synchronous until the child starts, and under heavy
 * machine load (many agents building and testing) each spawn blocked the daemon's event loop for 100 ms or
 * more. Sidebar change summaries alone run several Git commands per session, which delayed message
 * admission and kernel IPC for seconds. A small pool of worker threads owns all daemon Git/gh/jj processes.
 */
import { basename } from "node:path";
import { Worker } from "node:worker_threads";

export interface ProcessRequest {
	id: number;
	file: string;
	args: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	/** Bounded input owned by the caller, e.g. NUL-delimited Git attribute paths. */
	stdin?: string;
	/** Kill after this long and report `timedOut`. */
	timeoutMs?: number;
	/** First signal for timeout, abort and overflow. Escalates to SIGKILL after `forceKillMs`. */
	killSignal?: NodeJS.Signals;
	forceKillMs?: number;
	/** Own process group. Kills target the whole group. */
	detached?: boolean;
	/** Retained stdout bound. */
	maxBytes: number;
	/** `truncate` keeps the prefix and stops the child; `fail` stops it and reports `overflowed`. */
	overflow: "truncate" | "fail";
	/** Retained stderr bound. Further output is discarded. Defaults to 64 KiB. */
	maxStderrBytes?: number;
}

export interface ProcessResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: Buffer;
	stderr: string;
	truncated: boolean;
	overflowed: boolean;
	timedOut: boolean;
	aborted: boolean;
	/** A child-process error after the child started, such as a failed kill. */
	error?: string;
}

export type WorkerCommand = { type: "run"; request: ProcessRequest } | { type: "stop"; id: number };
export type ProcessReply =
	| { type: "done"; id: number; result: ProcessResult }
	| { type: "error"; id: number; message: string; code?: string };

export type ProcessOptions = Omit<ProcessRequest, "id" | "file" | "args"> & { signal?: AbortSignal };

/** Each thread spawns sequentially. A few threads keep one slow spawn from queueing the rest. */
const MAX_THREADS = 4;
const IDLE_MS = 30_000;

type Pending = { resolve(result: ProcessResult): void; reject(error: Error): void };
interface Thread {
	worker: Worker;
	pending: Map<number, Pending>;
	idle?: ReturnType<typeof setTimeout>;
}

export class SubprocessPool {
	private readonly threads: Thread[] = [];
	private nextId = 1;
	private readonly maxThreads: number;
	private readonly idleMs: number;

	constructor(options: { maxThreads?: number; idleMs?: number } = {}) {
		this.maxThreads = Math.max(1, options.maxThreads ?? MAX_THREADS);
		this.idleMs = options.idleMs ?? IDLE_MS;
	}

	/** Number of live worker threads, for tests. */
	get size(): number {
		return this.threads.length;
	}

	run(file: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
		if (options.stdin !== undefined && Buffer.byteLength(options.stdin) > 32 * 1024 * 1024)
			return Promise.reject(new Error("Subprocess input exceeds 32 MiB"));
		const { signal, ...rest } = options;
		if (signal?.aborted) return Promise.reject(abortError(signal));
		const id = this.nextId++;
		const thread = this.pick();
		clearTimeout(thread.idle);
		thread.idle = undefined;
		thread.worker.ref();
		return new Promise<ProcessResult>((resolve, reject) => {
			const onAbort = () => thread.worker.postMessage({ type: "stop", id } satisfies WorkerCommand);
			signal?.addEventListener("abort", onAbort, { once: true });
			thread.pending.set(id, {
				resolve: (result) => {
					signal?.removeEventListener("abort", onAbort);
					resolve(result);
				},
				reject: (error) => {
					signal?.removeEventListener("abort", onAbort);
					reject(error);
				},
			});
			thread.worker.postMessage({
				type: "run",
				// A worker's process.env is a copy taken at thread start. Match spawn: use the daemon's current env.
				request: { ...rest, env: rest.env ?? { ...process.env }, id, file, args },
			} satisfies WorkerCommand);
		});
	}

	close(): Promise<void> {
		const threads = this.threads.splice(0);
		for (const thread of threads) {
			clearTimeout(thread.idle);
			for (const pending of thread.pending.values()) pending.reject(new Error("Subprocess pool closed"));
			thread.pending.clear();
		}
		return Promise.all(threads.map((thread) => thread.worker.terminate())).then(() => undefined);
	}

	private pick(): Thread {
		let best: Thread | undefined;
		for (const thread of this.threads) if (!best || thread.pending.size < best.pending.size) best = thread;
		if (best && (best.pending.size === 0 || this.threads.length >= this.maxThreads)) return best;
		return this.spawnThread();
	}

	private spawnThread(): Thread {
		const worker = new Worker(new URL("./subprocess-worker.ts", import.meta.url));
		const thread: Thread = { worker, pending: new Map() };
		this.threads.push(thread);
		const fail = (error: Error) => {
			const index = this.threads.indexOf(thread);
			if (index >= 0) this.threads.splice(index, 1);
			clearTimeout(thread.idle);
			for (const pending of thread.pending.values()) pending.reject(error);
			thread.pending.clear();
		};
		worker.on("message", (reply: ProcessReply) => {
			const pending = thread.pending.get(reply.id);
			if (!pending) return;
			thread.pending.delete(reply.id);
			if (reply.type === "done") {
				// Structured clone delivers a Uint8Array. Callers expect a Buffer without another copy.
				const stdout = reply.result.stdout as Uint8Array;
				pending.resolve({
					...reply.result,
					stdout: Buffer.from(stdout.buffer, stdout.byteOffset, stdout.byteLength),
				});
			} else {
				pending.reject(Object.assign(new Error(reply.message), reply.code ? { code: reply.code } : {}));
			}
			if (thread.pending.size === 0) this.release(thread);
		});
		worker.on("error", (error) => fail(error));
		worker.on("exit", (code) => fail(new Error(`Subprocess worker exited with code ${code}`)));
		return thread;
	}

	/** An idle thread must not keep pilotd (or a test) alive, and is reclaimed after a while. */
	private release(thread: Thread): void {
		thread.worker.unref();
		clearTimeout(thread.idle);
		thread.idle = setTimeout(() => {
			if (thread.pending.size !== 0) return;
			const index = this.threads.indexOf(thread);
			if (index >= 0) this.threads.splice(index, 1);
			void thread.worker.terminate();
		}, this.idleMs);
		thread.idle.unref();
	}
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" });
}

export const subprocesses = new SubprocessPool();

export interface ExecOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	maxBytes: number;
	killSignal?: NodeJS.Signals;
	signal?: AbortSignal;
}

/** Failure shaped like execFile's: exit `code`, retained `stdout` and `stderr`. */
export class ProcessFailed extends Error {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly killed: boolean;
	readonly timedOut: boolean;
	constructor(message: string, result: ProcessResult) {
		super(message);
		this.code = result.code;
		this.stdout = result.stdout.toString("utf8");
		this.stderr = result.stderr;
		this.killed = result.signal !== null;
		this.timedOut = result.timedOut;
	}
}

/** Off-thread execFile: resolves stdout on exit 0, else rejects with {@link ProcessFailed}. */
export async function execFileOffThread(
	file: string,
	args: string[],
	options: ExecOptions,
	pool: SubprocessPool = subprocesses,
): Promise<string> {
	const result = await pool.run(file, args, {
		...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
		...(options.env !== undefined ? { env: options.env } : {}),
		...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
		...(options.killSignal ? { killSignal: options.killSignal } : {}),
		...(options.signal ? { signal: options.signal } : {}),
		maxBytes: options.maxBytes,
		overflow: "fail",
	});
	if (result.aborted && options.signal) throw abortError(options.signal);
	// Never echo argv: it can contain multi-line GraphQL, source text or credentials. Callers retain stderr.
	const command = basename(file);
	if (result.overflowed) throw new ProcessFailed("stdout maxBuffer length exceeded", result);
	if (result.timedOut)
		throw new ProcessFailed(`Command timed out: ${command} (${options.timeoutMs}ms timeout)`, result);
	if (result.code !== 0)
		throw new ProcessFailed(
			`Command failed: ${command} (exit ${result.code ?? result.signal ?? "unknown"})${
				result.stderr ? `: ${result.stderr.replace(/\s+/g, " ").trim().slice(0, 512)}` : ""
			}`,
			result,
		);
	return result.stdout.toString("utf8");
}
