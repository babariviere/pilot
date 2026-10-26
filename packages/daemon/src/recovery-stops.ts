import { Worker } from "node:worker_threads";
import { type KernelSubagent, type RecoveryStop, stopRecoveryWorkerEntry } from "@pilot/kernel";
import { ServiceUnavailable } from "./errors.ts";
import { isWatchNotice } from "./worker-notice.ts";
import { WorkerStarts } from "./worker-starts.ts";

/** Rare explicit recovery cancellations, bounded independently of model startup admission. */
export class RecoveryStops {
	private readonly starts = new WorkerStarts<{ ready: Promise<void>; subagents?: KernelSubagent[] }>();
	private pending = 0;

	async stop(spec: RecoveryStop): Promise<KernelSubagent[]> {
		if (this.pending >= 32) throw new ServiceUnavailable("Session recovery is busy. Retry shortly.");
		this.pending++;
		try {
			const result = await this.starts.open(spec.sessionId, () => {
				const worker = new Worker(stopRecoveryWorkerEntry, { workerData: spec, execArgv: [] });
				const result: { ready: Promise<void>; subagents?: KernelSubagent[] } = { ready: Promise.resolve() };
				result.ready = new Promise<void>((resolve, reject) => {
					let packet: { subagents?: KernelSubagent[]; error?: string } | undefined;
					let failure: Error | undefined;
					const timer = setTimeout(() => {
						failure = new Error("Recovery stop timed out");
						void worker.terminate();
					}, 60_000);
					worker.on("message", (value) => {
						// Node's watch mode posts module-watch notices to the worker's parent port.
						if (isWatchNotice(value)) return;
						packet = value;
					});
					worker.once("error", (error) => {
						failure = error;
					});
					worker.once("exit", (code) => {
						clearTimeout(timer);
						if (failure || code !== 0 || !packet?.subagents)
							reject(failure ?? new Error(packet?.error ?? `Recovery stop exited with code ${code}`));
						else {
							result.subagents = packet.subagents;
							resolve();
						}
					});
				});
				return result;
			});
			return result.subagents!;
		} finally {
			this.pending--;
		}
	}

	close(): void {
		this.starts.close();
	}
}
