import { parentPort, workerData } from "node:worker_threads";
import type { RetainedCallInput, RetainedCallQuery, RetainedCallRef, RetainedSide } from "./retained-call-contract.ts";
import { scanRetainedCalls } from "./retained-call-scan.ts";

const controller = new AbortController();
let waiting: { resolve(bytes: Uint8Array): void; reject(error: Error): void } | undefined;
parentPort!.on("message", (message) => {
	if (message === "abort") {
		controller.abort(new Error("Retained comparison cancelled"));
		waiting?.reject(controller.signal.reason);
	} else if (message.bytes instanceof Uint8Array) {
		const current = waiting;
		waiting = undefined;
		current?.resolve(message.bytes);
	}
});
const request = (ref: RetainedCallRef | { stage: RetainedSide }) =>
	new Promise<Uint8Array>((resolve, reject) => {
		controller.signal.throwIfAborted();
		waiting = { resolve, reject };
		parentPort!.postMessage({ read: ref });
	});
try {
	const { input, query } = workerData as { input: RetainedCallInput; query: RetainedCallQuery };
	const result = await scanRetainedCalls(
		input,
		query,
		request,
		async (side) => {
			await request({ stage: side });
		},
		controller.signal,
	);
	parentPort!.postMessage({ result });
} catch (error) {
	parentPort!.postMessage({ error: error instanceof Error ? error.message : "Retained comparison failed" });
} finally {
	parentPort!.close();
}
