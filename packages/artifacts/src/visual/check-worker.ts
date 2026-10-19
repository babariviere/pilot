/**
 * Runs the visual pre-check off the kernel's event loop, then translates the shaders it saw to Metal. The parent
 * terminates this worker on timeout or abort.
 */
import { parentPort, workerData } from "node:worker_threads";
import { runVisualCheck, type VisualCheckInput } from "./check.ts";
import { translateVisualShader, VisualShaderError } from "./metal.ts";

/** A shader's translation, or naga's error with the line in the shader's GLSL. */
export type VisualShaderTranslation = { msl: string; entry: string } | { error: string; line?: number };

try {
	const result = await runVisualCheck(workerData as VisualCheckInput);
	const translations: VisualShaderTranslation[] = [];
	if (result.ok)
		for (const shader of result.shaders) {
			try {
				const { msl, entry } = translateVisualShader(shader.glsl, shader.inputs);
				translations.push({ msl, entry });
			} catch (error) {
				if (!(error instanceof VisualShaderError)) throw error;
				translations.push({ error: error.message, ...(error.line ? { line: error.line } : {}) });
			}
		}
	parentPort?.postMessage({ ...result, ...(result.ok ? { translations } : {}) });
} catch (error) {
	parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error), logs: [] });
}
