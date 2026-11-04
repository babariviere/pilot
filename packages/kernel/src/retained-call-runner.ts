import { runExplorationWorker } from "./exploration-runner.ts";
import type {
	RetainedCallProvider,
	RetainedCallQuery,
	RetainedCallRef,
	RetainedCallResult,
} from "./retained-call-contract.ts";

export type { RetainedCallQuery, RetainedCallResult } from "./retained-call-contract.ts";

/** No capture, live fallback, grant caching, endpoint or provider/model execution. */
export async function compareRetainedCalls(
	provider: RetainedCallProvider,
	query: RetainedCallQuery = {},
	signal?: AbortSignal,
): Promise<RetainedCallResult> {
	const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]);
	const input = structuredClone(provider.input);
	bounded.throwIfAborted();
	await provider.authorize();
	bounded.throwIfAborted();
	const result = await runExplorationWorker<RetainedCallResult>(
		new URL("./retained-call-worker.ts", import.meta.url),
		{ input, query },
		bounded,
		async (value) => {
			if (
				value &&
				typeof value === "object" &&
				"stage" in value &&
				["before", "after"].includes(String(value.stage))
			) {
				bounded.throwIfAborted();
				await provider.authorize();
				return new Uint8Array();
			}
			const ref = value as RetainedCallRef;
			if (!ref || ref.snapshotId !== input.snapshotId || !["before", "after"].includes(ref.side))
				throw new Error("Cross-pair retained read");
			const entry = input[ref.side].find((entry) => entry.path === ref.path);
			if (entry?.state !== "text" || entry.sha256 !== ref.sha256 || !entry.mode.startsWith("100"))
				throw new Error("Unadmitted retained read");
			bounded.throwIfAborted();
			await provider.authorize();
			const bytes = await provider.read(ref, bounded);
			if (bytes.length !== entry.bytes) throw new Error("Retained byte hash/size mismatch");
			await provider.authorize();
			bounded.throwIfAborted();
			return bytes;
		},
	);
	await provider.authorize();
	bounded.throwIfAborted();
	return result;
}
