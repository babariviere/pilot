/** Isolated entry, loaded from the host snapshot. No endpoint or installed dispatcher. */
import { readFile } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";
import {
	checkVisual,
	SHADER_CHECK_TIMEOUT_MS,
	SHADER_CHECK_WORKER_RESOURCES,
	VISUAL_CHECK_WORKER_RESOURCES,
	VisualCheckError,
} from "@pilot/artifacts/visual-check";
import { VISUAL_CHECK_SAMPLING } from "@pilot/artifacts/visual-check-policy";

const controller = new AbortController();
parentPort!.on("message", () => controller.abort());
const send = (value: unknown) => parentPort!.postMessage(value);
try {
	const actualConfiguration = {
		options: workerData.options,
		sampling: VISUAL_CHECK_SAMPLING,
		initialWorkerTimeoutOnly: true,
		environment: "empty",
		shaderTimeoutMs: SHADER_CHECK_TIMEOUT_MS,
		initialResources: VISUAL_CHECK_WORKER_RESOURCES,
		shaderResources: SHADER_CHECK_WORKER_RESOURCES,
	};
	send({ type: "configuration", configuration: actualConfiguration });
	if (JSON.stringify(actualConfiguration) !== JSON.stringify(workerData.expectedConfiguration))
		throw new Error("Visual execution configuration mismatch");
	const result = await checkVisual(workerData.input, {
		...workerData.options,
		signal: controller.signal,
		load: async () => ({
			wasm: await WebAssembly.compile(await readFile(new URL(workerData.wasm))),
			runtime: await readFile(new URL(workerData.runtime), "utf8"),
		}),
		observer: {
			stage: (stage, state, index) => send({ type: "stage", stage, state, index, at: Date.now() }),
			initial: (result) => send({ type: "sample", result }),
			provenance: (scope, receipt, index) => send({ type: "provenance", scope, receipt, index }),
		},
	});
	controller.signal.throwIfAborted();
	send({ type: "result", result });
} catch (error) {
	send({
		type: "error",
		state: controller.signal.aborted ? "cancelled" : error instanceof VisualCheckError ? "failed" : "unavailable",
		message: error instanceof Error ? error.message.slice(0, 4096) : "Visual precheck unavailable",
	});
} finally {
	// checkVisual has settled and joined every worker it created before closing this channel.
	send({ type: "provenance", scope: "host", receipt: Reflect.get(globalThis, "__retainedVisualProvenance")?.() });
	send({ type: "settled" });
	parentPort!.close();
}
