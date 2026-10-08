/** Keep SQLite scans and snapshot construction off the daemon's WebSocket event loop. */
import { Worker } from "node:worker_threads";
import { type PersistedSessionView, snapshotWorkerEntry } from "@pilot/kernel";

export type SizedSessionView = PersistedSessionView & { bytes: number };
type Job = { directory: string; cwd: string; resolve(view: SizedSessionView): void; reject(error: Error): void };

export class ColdViewReader {
	private readonly waiting: Job[] = [];
	private readonly active = new Set<Worker>();
	private closed = false;

	read(directory: string, cwd: string): Promise<SizedSessionView> {
		if (this.closed) return Promise.reject(new Error("Session reader is closed"));
		return new Promise((resolve, reject) => {
			this.waiting.push({ directory, cwd, resolve, reject });
			this.drain();
		});
	}

	private drain(): void {
		while (!this.closed && this.active.size < 2 && this.waiting.length) {
			const job = this.waiting.shift()!;
			let worker: Worker;
			try {
				worker = new Worker(snapshotWorkerEntry, {
					workerData: { directory: job.directory, cwd: job.cwd },
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
		for (const job of this.waiting.splice(0)) job.reject(new Error("Session reader is closed"));
		await Promise.all([...this.active].map((worker) => worker.terminate()));
	}
}
