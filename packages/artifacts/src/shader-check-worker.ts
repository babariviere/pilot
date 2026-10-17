/** Runs glslang off the kernel's event loop. The parent terminates this worker on timeout or abort. */
import { parentPort, workerData } from "node:worker_threads";
import { createValidator } from "glslang-wasm-validator";

const { vertex, fragment } = workerData as { vertex: string; fragment: string };
try {
	const validator = await createValidator();
	try {
		const result = validator.checkPass({ vertex, fragment });
		parentPort?.postMessage({
			diagnostics: result.diagnostics.map(({ severity, stage, message, line }) => ({
				severity,
				stage,
				message,
				line,
			})),
		});
	} finally {
		validator.dispose();
	}
} catch (error) {
	parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
