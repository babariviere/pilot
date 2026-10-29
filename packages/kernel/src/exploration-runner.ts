/** No persistent index/worker. Bound concurrent calls, cancel/join work before releasing its slot. */
import { Worker } from "node:worker_threads";
import type { ExplorationPage, ExplorationQuery } from "./exploration-contract.ts";
import type { AskContext } from "./policy.ts";

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
				reject(signal?.reason ?? new Error("Exploration cancelled"));
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

export async function runExploration(
	source: AskContext,
	query: ExplorationQuery,
	signal?: AbortSignal,
): Promise<ExplorationPage> {
	if (query.query !== undefined && (query.query.length > 256 || /[\r\n]/.test(query.query)))
		throw new Error("Exploration query must be one line, at most 256 UTF-16 units");
	if (query.tool === "code_search" && !query.query) throw new Error("code_search requires a nonempty literal query");
	if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 50))
		throw new Error("Exploration limit must be 1..50");
	if (query.cursor !== undefined && query.cursor.length > 512) throw new Error("Exploration cursor too long");
	const release = await slot(signal);
	let worker: Worker | undefined;
	let deadline: ReturnType<typeof setTimeout> | undefined;
	let hardStop: ReturnType<typeof setTimeout> | undefined;
	let abort: (() => void) | undefined;
	try {
		signal?.throwIfAborted();
		worker = new Worker(new URL("./exploration-worker.ts", import.meta.url), {
			// Preserve permission limits, not incompatible eval/test/V8 flags. NODE_OPTIONS still inherits.
			execArgv: workerPermissions(),
			workerData: { source, query },
			resourceLimits: { maxOldGenerationSizeMb: 128 },
		});
		return await new Promise<ExplorationPage>((resolve, reject) => {
			let cancellation: unknown;
			const stop = (reason: unknown) => {
				if (cancellation) return;
				cancellation = reason;
				worker!.postMessage("abort");
				hardStop = setTimeout(() => {
					void worker!.terminate();
				}, 250);
			};
			abort = () => stop(signal?.reason ?? new Error("Exploration cancelled"));
			signal?.addEventListener("abort", abort, { once: true });
			deadline = setTimeout(() => stop(new Error("Exploration deadline exceeded; narrow path/query")), 15_000);
			worker!.once("message", (message: { result?: ExplorationPage; error?: string }) => {
				if (cancellation) reject(cancellation);
				else if (message.error) reject(new Error(message.error));
				else if (message.result) resolve(message.result);
				else reject(new Error("Invalid exploration response"));
			});
			worker!.once("error", (error) => reject(cancellation ?? error));
			worker!.once("exit", (code) => reject(cancellation ?? new Error(`Exploration worker exited (${code})`)));
		});
	} finally {
		if (abort) signal?.removeEventListener("abort", abort);
		clearTimeout(deadline);
		clearTimeout(hardStop);
		if (worker) await worker.terminate();
		release();
	}
}
