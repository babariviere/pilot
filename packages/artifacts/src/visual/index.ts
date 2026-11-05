/** Publish-time checks for visual artifacts: limits, the pre-check in a worker thread, then shader GLSL and Metal. */
import { Worker } from "node:worker_threads";
import type { ArtifactVisual, ArtifactVisualShader } from "@pilot/protocol";
import { checkShader, formatShaderDiagnostics, type ShaderDiagnostic } from "../shader.ts";
import type { VisualCheckInput, VisualCheckResult } from "./check.ts";
import type { VisualShaderTranslation } from "./check-worker.ts";
import { VISUAL_API_VERSION, VISUAL_LIMITS } from "./schema.ts";
import { visualRuntime } from "./session.ts";

export { SHADER_CHECK_TIMEOUT_MS, SHADER_CHECK_WORKER_RESOURCES } from "../shader.ts";
export { visualRuntime };

/** setup, views, 24 interactions and 96 draws at their limits stay well below this; it only stops a stuck worker. */
export const VISUAL_CHECK_TIMEOUT_MS = 30_000;
export const VISUAL_CHECK_WORKER_RESOURCES = Object.freeze({ maxOldGenerationSizeMb: 64, stackSizeMb: 8 });

/** Check sizes and serialize data. Returns the data as JSON text. */
export function validateVisualWrite(source: string, data: unknown): string {
	if (Buffer.byteLength(source, "utf8") > VISUAL_LIMITS.sourceBytes) throw new Error("Visual source exceeds 256 KiB");
	if (!/^(?:function\b|async\b|\(|[\p{L}_$][\p{L}\p{N}_$]*\s*=>)/u.test(source.trim()))
		throw new Error(
			"Visual source must be the text of one function. Define function visual({ ui, state, data }) { ... } in the script and pass source: String(visual)",
		);
	let json: string | undefined;
	try {
		json = JSON.stringify(data === undefined ? null : data);
	} catch (error) {
		throw new Error(`Visual data must be JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (json === undefined) throw new Error("Visual data must be JSON");
	if (Buffer.byteLength(json, "utf8") > VISUAL_LIMITS.dataBytes) throw new Error("Visual data exceeds 1 MiB of JSON");
	return json;
}

export class VisualCheckError extends Error {}

/** Host-only execution tracing. Not a check result or an acceptance decision. */
export interface VisualCheckObserver {
	stage(
		stage: "loading" | "initial" | "glsl" | "metal",
		state: "started" | "passed" | "failed" | "unavailable" | "joined",
		index?: number,
	): void;
	initial(result: VisualCheckResult): void;
	provenance?(scope: "initial" | "glsl", receipt: unknown, index?: number): void;
}

/** Run the pre-check. Throws VisualCheckError with "line N: ..." for a visual that fails. */
export async function checkVisual(
	input: { source: string; data: string; id: string },
	options: {
		signal?: AbortSignal;
		timeoutMs?: number;
		now?: number;
		/** Only the isolated host adapter supplies these exact, pinned runtime inputs. */
		load?: () => Promise<{ wasm: object; runtime: string }>;
		observer?: VisualCheckObserver;
	} = {},
): Promise<ArtifactVisual> {
	options.signal?.throwIfAborted();
	const observer = options.observer;
	observer?.stage("loading", "started");
	let loaded: { wasm: object; runtime: string };
	try {
		loaded = options.load
			? await options.load()
			: {
					wasm: await (await import("@earendil-works/pi-codemode")).loadQuickJSWasm(),
					runtime: await visualRuntime(),
				};
		options.signal?.throwIfAborted();
		observer?.stage("loading", "passed");
	} catch (error) {
		observer?.stage("loading", "unavailable");
		throw error;
	} finally {
		observer?.stage("loading", "joined");
	}
	const workerData: VisualCheckInput & { trace: boolean } = {
		...loaded,
		trace: !!observer,
		source: input.source,
		data: input.data,
		seed: input.id,
		now: options.now ?? Date.now(),
	};
	options.signal?.throwIfAborted();
	observer?.stage("initial", "started");
	const worker = new Worker(new URL("./check-worker.ts", import.meta.url), {
		workerData,
		// QuickJS's 512 KiB stack guard must trip before the thread's own stack does.
		resourceLimits: VISUAL_CHECK_WORKER_RESOURCES,
		stdout: true,
		stderr: true,
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort: (() => void) | undefined;
	let result: VisualCheckResult & { translations?: VisualShaderTranslation[] };
	try {
		result = await new Promise<VisualCheckResult>((resolve, reject) => {
			worker.on("message", (message) => {
				if (message?.visualStage === "metal") {
					observer?.stage("metal", message.state, message.index);
					return;
				}
				observer?.provenance?.("initial", message.provenance);
				resolve(message);
			});
			worker.once("error", reject);
			worker.once("exit", (code) => reject(new Error(`Visual check stopped (exit ${code})`)));
			timer = setTimeout(
				() => reject(new VisualCheckError("Visual check timed out")),
				options.timeoutMs ?? VISUAL_CHECK_TIMEOUT_MS,
			);
			abort = () => reject(options.signal?.reason ?? new Error("Visual check aborted"));
			options.signal?.addEventListener("abort", abort, { once: true });
			if (options.signal?.aborted) abort();
		});
	} catch (error) {
		observer?.stage("initial", error instanceof VisualCheckError ? "failed" : "unavailable");
		throw error;
	} finally {
		if (timer) clearTimeout(timer);
		if (abort) options.signal?.removeEventListener("abort", abort);
		await worker.terminate();
		observer?.stage("initial", "joined");
	}
	options.signal?.throwIfAborted();
	observer?.initial(result);
	observer?.stage("initial", result.ok ? "passed" : result.unavailable ? "unavailable" : "failed");
	if (!result.ok) {
		if (result.unavailable) throw new Error(`Visual check unavailable: ${result.error}`);
		const logs = result.logs.length ? `\nconsole output:\n${result.logs.join("\n")}` : "";
		throw new VisualCheckError(`Visual check failed. Nothing was published. ${result.error}${logs}`);
	}
	const shaders: ArtifactVisualShader[] = [];
	for (const [index, shader] of result.shaders.entries()) {
		// glslang first: it checks the same GLSL ES 3.00 as shader artifacts, with the clearest messages.
		observer?.stage("glsl", "started", index);
		let errors: ShaderDiagnostic[];
		try {
			errors = await checkShader(shader.glsl, {
				signal: options.signal,
				inputs: shader.inputs,
				observe: (receipt) => observer?.provenance?.("glsl", receipt, index),
				joined: () => observer?.stage("glsl", "joined", index),
			});
			options.signal?.throwIfAborted();
			observer?.stage("glsl", errors.length ? "failed" : "passed", index);
		} catch (error) {
			observer?.stage("glsl", "unavailable", index);
			throw error;
		}
		const name = JSON.stringify(shader.name);
		if (errors.length)
			throw new VisualCheckError(
				`Visual check failed. Nothing was published. shader ${name} does not compile as GLSL ES 3.00:\n` +
					formatShaderDiagnostics(errors, shader.glsl),
			);
		const translation = result.translations?.[index];
		if (!translation) throw new Error("Visual check unavailable. The shader was not translated to Metal");
		if ("error" in translation)
			throw new VisualCheckError(
				`Visual check failed. Nothing was published. shader ${name} could not be translated to Metal: ` +
					formatShaderDiagnostics([{ line: translation.line, message: translation.error }], shader.glsl),
			);
		shaders.push({ glsl: shader.glsl, inputs: shader.inputs, msl: translation.msl, entry: translation.entry });
	}
	const check = { ...result.report, ...(shaders.length ? { shaders: shaders.length } : {}) };
	return { api: VISUAL_API_VERSION, engine: result.engine, check, ...(shaders.length ? { shaders } : {}) };
}

/** Shown by apps that do not know the visual kind. */
export const VISUAL_FALLBACK_BODY =
	'<p style="color:var(--pilot-muted-foreground)">Open this visual in a newer version of Pilot to view it.</p>';
