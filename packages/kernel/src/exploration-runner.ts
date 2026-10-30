/** No persistent index/worker. Bound concurrent calls, cancel/join work before releasing its slot. */
import { Worker } from "node:worker_threads";
import type { CallPathPage, CallPathQuery } from "./call-path-contract.ts";
import type { ExplorationPage, ExplorationQuery } from "./exploration-contract.ts";
import type { ImpactPage, ImpactQuery } from "./impact-contract.ts";
import type { AskContext } from "./policy.ts";

type ExplorationInput = ExplorationQuery | CallPathQuery | ImpactQuery;
type ExplorationResult = ExplorationPage | CallPathPage | ImpactPage;

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

export function runExploration(source: AskContext, query: CallPathQuery, signal?: AbortSignal): Promise<CallPathPage>;
export function runExploration(source: AskContext, query: ImpactQuery, signal?: AbortSignal): Promise<ImpactPage>;
export function runExploration(
	source: AskContext,
	query: ExplorationQuery,
	signal?: AbortSignal,
): Promise<ExplorationPage>;
export function runExploration(
	source: AskContext,
	query: ExplorationInput,
	signal?: AbortSignal,
): Promise<ExplorationResult>;
export async function runExploration(
	source: AskContext,
	query: ExplorationInput,
	signal?: AbortSignal,
): Promise<ExplorationResult> {
	if (query.tool === "code_call_paths" || query.tool === "code_impact") {
		if (query.tool === "code_call_paths" && !["callers", "callees"].includes(query.direction))
			throw new Error("Call-path direction must be callers or callees");
		if (query.tool === "code_impact") {
			if (!Array.isArray(query.symbols) || query.symbols.length < 1 || query.symbols.length > 8)
				throw new Error("Impact requires 1..8 exact callable symbols");
			if (query.expectedRevision !== undefined && !/^[a-f0-9]{64}$/.test(query.expectedRevision))
				throw new Error("Invalid expectedRevision");
		}
		for (const symbol of query.tool === "code_impact" ? query.symbols : [query.symbol]) {
			if (
				!symbol ||
				typeof symbol.path !== "string" ||
				![symbol.line, symbol.column].every((n) => Number.isSafeInteger(n) && n >= 1)
			)
				throw new Error("Call-path symbol requires exact path/line/column");
			if (symbol.contentHash !== undefined && !/^[a-f0-9]{64}$/.test(symbol.contentHash))
				throw new Error("Invalid symbol contentHash");
			if (symbol.frameId !== undefined && (typeof symbol.frameId !== "string" || symbol.frameId.length > 4400))
				throw new Error("Invalid symbol frameId");
		}
		if (query.depth !== undefined && (!Number.isSafeInteger(query.depth) || query.depth < 1 || query.depth > 6))
			throw new Error("Call-path depth must be 1..6");
	} else if (query.query !== undefined && (query.query.length > 256 || /[\r\n]/.test(query.query)))
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
		return await new Promise<ExplorationResult>((resolve, reject) => {
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
			worker!.once("message", (message: { result?: ExplorationResult; error?: string }) => {
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
