/** Shared pool for disposable analyses: two running, eight waiting. Join before releasing a slot. */
import { Worker } from "node:worker_threads";

let active = 0;
const pending: Array<() => void> = [];

function workerPermissions(): string[] {
	const flags: string[] = [];
	for (let i = 0; i < process.execArgv.length; i++) {
		const flag = process.execArgv[i]!;
		if (/^--(?:(?:experimental-)?permission|allow-[a-z-]+)(?:=|$)/.test(flag)) {
			flags.push(flag);
			if (["--allow-fs-read", "--allow-fs-write"].includes(flag) && process.execArgv[i + 1])
				flags.push(process.execArgv[++i]!);
		}
	}
	return flags;
}
async function slot(signal?: AbortSignal): Promise<() => void> {
	signal?.throwIfAborted();
	if (active >= 2) {
		if (pending.length >= 8) throw new Error("Exploration busy; retry later");
		await new Promise<void>((resolve, reject) => {
			const ready = () => {
				signal?.removeEventListener("abort", abort);
				resolve();
			};
			const abort = () => {
				pending.splice(pending.indexOf(ready), 1);
				signal?.removeEventListener("abort", abort);
				reject(signal ? signal.reason : new Error("Exploration cancelled"));
			};
			pending.push(ready);
			signal?.addEventListener("abort", abort, { once: true });
		});
	} else active++;
	return () => {
		const next = pending.shift();
		if (next) next();
		else active--;
	};
}

/** Shared admission, permission inheritance, deadline and join rules for disposable analyses. */
export async function runAnalysisWorker<T>(
	url: URL,
	data: unknown,
	signal?: AbortSignal,
	read?: (ref: unknown) => Promise<Uint8Array>,
): Promise<T> {
	const release = await slot(signal);
	let worker: Worker | undefined;
	let deadline: ReturnType<typeof setTimeout> | undefined;
	let hardStop: ReturnType<typeof setTimeout> | undefined;
	let abort: (() => void) | undefined;
	let reading: Promise<void> | undefined;
	try {
		signal?.throwIfAborted();
		worker = new Worker(url, {
			// Preserve permission limits, not incompatible eval/test/V8 flags. NODE_OPTIONS still inherits.
			execArgv: workerPermissions(),
			workerData: data,
			resourceLimits: { maxOldGenerationSizeMb: 128 },
		});
		return await new Promise<T>((resolve, reject) => {
			let cancelled = false;
			let cancellation: unknown;
			const stop = (reason: unknown) => {
				if (cancelled) return;
				cancelled = true;
				cancellation = reason;
				worker!.postMessage("abort");
				hardStop = setTimeout(() => {
					void worker!.terminate();
				}, 250);
			};
			abort = () => stop(signal ? signal.reason : new Error("Exploration cancelled"));
			signal?.addEventListener("abort", abort, { once: true });
			deadline = setTimeout(() => stop(new Error("Exploration deadline exceeded; narrow path/query")), 15_000);
			worker!.on("message", (message: { result?: T; error?: string; read?: unknown }) => {
				if (message.read !== undefined) {
					if (!read || reading || cancelled) {
						stop(new Error("Invalid exploration byte request"));
						return;
					}
					reading = (async () => {
						try {
							const bytes = await read(message.read);
							if (!cancelled) worker!.postMessage({ bytes });
						} catch (error) {
							stop(error);
						} finally {
							reading = undefined;
						}
					})();
					return;
				}
				if (cancelled) reject(cancellation);
				else if (message.error) reject(new Error(message.error));
				else if (message.result) resolve(message.result);
				else reject(new Error("Invalid exploration response"));
			});
			worker!.once("error", (error) => reject(cancelled ? cancellation : error));
			worker!.once("exit", (code) =>
				reject(cancelled ? cancellation : new Error(`Exploration worker exited (${code})`)),
			);
		});
	} finally {
		if (abort) signal?.removeEventListener("abort", abort);
		clearTimeout(deadline);
		clearTimeout(hardStop);
		if (worker) await worker.terminate();
		await reading;
		release();
	}
}
