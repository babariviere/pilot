/** One bounded, idle-reclaimed reader thread. Large file scans never run on pilotd's event loop. */
import { Worker } from "node:worker_threads";

export interface UntrackedFile {
	path: string;
	binary: "auto" | "text" | "binary";
	bigFileThreshold: number;
}

export interface LineStat {
	additions: number;
	deletions: number;
}

interface Flight {
	resolve(value: LineStat[]): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

export class UntrackedStats {
	private worker?: Worker;
	private readonly pending = new Map<number, Flight>();
	private nextId = 0;
	private idle?: ReturnType<typeof setTimeout>;
	private scannedBytes = 0;

	/** Diagnostic counter for operation-count tests and offline benchmarks. */
	get bytesRead(): number {
		return this.scannedBytes;
	}

	private readonly idleMs: number;

	constructor(idleMs = 30_000) {
		this.idleMs = idleMs;
	}

	read(cwd: string, files: UntrackedFile[]): Promise<LineStat[]> {
		if (!files.length) return Promise.resolve([]);
		if (this.pending.size >= 16) return Promise.reject(new Error("Untracked file statistics are busy"));
		clearTimeout(this.idle);
		const worker = this.worker ?? this.start();
		worker.ref();
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => void this.close(new Error("Untracked file statistics timed out")), 60_000);
			this.pending.set(id, { resolve, reject, timer });
			worker.postMessage({ id, cwd, files });
		});
	}

	async close(error = new Error("Untracked file reader closed")): Promise<void> {
		clearTimeout(this.idle);
		const worker = this.worker;
		this.worker = undefined;
		for (const flight of this.pending.values()) {
			clearTimeout(flight.timer);
			flight.reject(error);
		}
		this.pending.clear();
		if (worker) await worker.terminate();
	}

	private start(): Worker {
		const worker = new Worker(new URL("./untracked-stats-worker.ts", import.meta.url));
		this.worker = worker;
		worker.on("message", (reply: { id: number; stats?: LineStat[]; bytesRead: number; error?: string }) => {
			if (this.worker !== worker) return;
			const flight = this.pending.get(reply.id);
			if (!flight) return;
			this.pending.delete(reply.id);
			clearTimeout(flight.timer);
			this.scannedBytes += reply.bytesRead;
			if (reply.stats) flight.resolve(reply.stats);
			else flight.reject(new Error(reply.error ?? "Untracked statistics failed"));
			if (!this.pending.size) {
				worker.unref();
				this.idle = setTimeout(() => void this.close(), this.idleMs);
				this.idle.unref();
			}
		});
		const fail = (error: Error) => {
			if (this.worker === worker) void this.close(error);
		};
		worker.on("error", fail);
		worker.on("exit", (code) => fail(new Error(`Untracked file reader exited: ${code}`)));
		return worker;
	}
}

export const untrackedStats = new UntrackedStats();
