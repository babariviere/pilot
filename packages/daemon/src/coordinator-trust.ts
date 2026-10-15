import { Worker } from "node:worker_threads";
/** Resolve the pinned SDK's locked trust read before entering a read-only configuration view. */
export function coordinatorTrust(cwd: string, agentDir: string, trustDirectory?: string): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL("./coordinator-trust-worker.ts", import.meta.url), {
			workerData: { cwd, agentDir, trustDirectory },
		});
		const timer = setTimeout(() => {
			void worker.terminate();
			reject(new Error("Project trust read timed out"));
		}, 20_000);
		let trusted: boolean | undefined;
		worker.on("message", (message) => {
			if (typeof message?.trusted === "boolean") trusted = message.trusted;
		});
		worker.on("error", () => {});
		worker.once("exit", (code) => {
			clearTimeout(timer);
			if (code === 0 && trusted !== undefined) resolve(trusted);
			else reject(new Error("Project trust could not be read"));
		});
	});
}
