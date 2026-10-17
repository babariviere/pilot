/** Shadertoy-style GLSL artifacts. The fragment shader is checked with glslang (WebAssembly, no GPU or
 * browser) before publication, then rendered by a small WebGL2 player inside the sandboxed artifact page. */
import { Worker } from "node:worker_threads";

/** Lines numbered from here belong to Pilot's wrapper, not the agent's source. */
const WRAPPER_LINE = 100_000;
const CHECK_TIMEOUT_MS = 10_000;
const MAX_ERRORS = 10;

const PRELUDE = [
	"#version 300 es",
	"precision highp float;",
	"precision highp int;",
	"uniform vec3 iResolution;",
	"uniform float iTime;",
	"uniform float iTimeDelta;",
	"uniform int iFrame;",
	"uniform vec4 iMouse;",
	"out vec4 pilotFragColor;",
].join("\n");

/** A full-viewport triangle without vertex buffers. */
export const SHADER_VERTEX_SOURCE =
	"#version 300 es\nvoid main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.0-1.0,0.0,1.0);}";

/** Wrap mainImage so compiler line numbers match the agent's source. */
export function shaderFragmentSource(source: string): string {
	return (
		PRELUDE +
		"\n#line 1\n" +
		source +
		"\n#line " +
		WRAPPER_LINE +
		"\nvoid main() {\n\tpilotFragColor = vec4(0.0);\n\tmainImage(pilotFragColor, gl_FragCoord.xy);\n}\n"
	);
}

export function validateShaderSource(source: string): void {
	if (/^[ \t]*#[ \t]*version\b/m.test(source))
		throw new Error(
			"Shader source must omit #version. It is compiled as GLSL ES 3.00 with iResolution, iTime, iTimeDelta, iFrame and iMouse declared",
		);
}

export interface ShaderDiagnostic {
	/** One-based line in the agent's source, absent for errors in Pilot's wrapper. */
	line?: number;
	message: string;
}

interface GlslangDiagnostic {
	severity: "warning" | "error";
	stage: string;
	message: string;
	line?: number;
}

/** glslang's summary lines repeat what the real diagnostics already say. */
const NOISE = /^(?:'' : compilation terminated|\d+ compilation errors?\.\s+No code generated\.)\s*$/;

export function shaderErrors(diagnostics: GlslangDiagnostic[]): ShaderDiagnostic[] {
	const errors: ShaderDiagnostic[] = [];
	for (const diagnostic of diagnostics) {
		// glslang pads quoted types (' const int'); collapse whitespace and that padding.
		const message = diagnostic.message.replace(/\s+/g, " ").replaceAll(" ' ", " '").trim();
		if (diagnostic.severity !== "error" || NOISE.test(message)) continue;
		const line =
			diagnostic.stage === "fragment" && diagnostic.line && diagnostic.line < WRAPPER_LINE
				? diagnostic.line
				: undefined;
		errors.push(line === undefined ? { message: wrapperMessage(message) } : { line, message });
	}
	return errors;
}

function wrapperMessage(message: string): string {
	return /mainImage|main/.test(message)
		? `Define void mainImage(out vec4 fragColor, in vec2 fragCoord) and no main function (${message})`
		: message;
}

export function formatShaderErrors(errors: ShaderDiagnostic[], source: string): string {
	const lines = source.split(/\r?\n/);
	const shown = errors.slice(0, MAX_ERRORS).map((error) => {
		if (error.line === undefined) return error.message;
		const code = lines[error.line - 1]?.trim();
		return `line ${error.line}: ${error.message}${code ? `\n    ${code.slice(0, 200)}` : ""}`;
	});
	if (errors.length > MAX_ERRORS) shown.push(`…and ${errors.length - MAX_ERRORS} more`);
	return (
		"Shader does not compile as GLSL ES 3.00. Nothing was published. Fix these errors and try again:\n" +
		shown.join("\n")
	);
}

/** Compile in a worker, so a pathological shader can be stopped without blocking the event loop. */
export async function checkShader(
	source: string,
	options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ShaderDiagnostic[]> {
	options.signal?.throwIfAborted();
	const worker = new Worker(new URL("./shader-check-worker.ts", import.meta.url), {
		workerData: { vertex: SHADER_VERTEX_SOURCE, fragment: shaderFragmentSource(source) },
		resourceLimits: { maxOldGenerationSizeMb: 64 },
		stdout: true,
		stderr: true,
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort: (() => void) | undefined;
	try {
		const diagnostics = await new Promise<GlslangDiagnostic[]>((resolve, reject) => {
			worker.once("message", (message: { diagnostics?: GlslangDiagnostic[]; error?: string }) =>
				message.diagnostics
					? resolve(message.diagnostics)
					: reject(new Error(message.error ?? "Shader check failed")),
			);
			worker.once("error", reject);
			worker.once("exit", (code) => reject(new Error(`Shader check stopped (exit ${code})`)));
			timer = setTimeout(() => reject(new ShaderCheckTimeout()), options.timeoutMs ?? CHECK_TIMEOUT_MS);
			abort = () => reject(options.signal?.reason ?? new Error("Shader check aborted"));
			options.signal?.addEventListener("abort", abort, { once: true });
		});
		return shaderErrors(diagnostics);
	} finally {
		if (timer) clearTimeout(timer);
		if (abort) options.signal?.removeEventListener("abort", abort);
		await worker.terminate();
	}
}

export class ShaderCheckTimeout extends Error {
	constructor() {
		super("Shader check timed out. Simplify macros, loops or constant expressions and try again");
	}
}

/** Reject shaders that do not compile, with line numbers in the agent's source. A broken checker is not the
 * shader's fault: publication continues and the viewer reports WebKit's own compile log instead. */
export async function assertShaderCompiles(source: string, signal?: AbortSignal): Promise<void> {
	validateShaderSource(source);
	let errors: ShaderDiagnostic[];
	try {
		errors = await checkShader(source, { signal });
	} catch (error) {
		signal?.throwIfAborted();
		if (error instanceof ShaderCheckTimeout) throw error;
		console.warn("pilot: shader check unavailable", error);
		return;
	}
	if (errors.length) throw new Error(formatShaderErrors(errors, source));
}

const shaderStyles =
	"html,body{background:transparent}body{padding:0}#pilot-shader{display:block;width:100%;max-width:960px;aspect-ratio:16/9;margin-inline:auto;touch-action:none}.pilot-shader-error{margin:0;padding:12px 14px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;color:#b42318;background:var(--pilot-muted);border:1px solid var(--pilot-border);border-radius:var(--pilot-radius)}";

/** Runs at display rate only while it can be seen: the page is visible, the canvas intersects the
 * viewport and the host has not scrolled the view away (data-pilot-host-visible). Reduce Motion draws
 * still frames at iTime 0, redrawn on resize and pointer input. */
const player = String.raw`(() => {
const canvas = document.getElementById("pilot-shader");
const fail = (title, detail) => {
	const box = document.createElement("pre");
	box.className = "pilot-shader-error";
	box.textContent = detail ? title + "\n\n" + detail : title;
	canvas.replaceWith(box);
	console.error(detail ? title + "\n" + detail : title);
};
const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: false, antialias: false, depth: false,
	stencil: false, powerPreference: "low-power" });
if (!gl) return fail("WebGL2 is unavailable in this viewer.");
const mapLog = (log) => (log || "").replace(/ERROR: 0:(\d+): /g, (_m, line) => Number(line) >= WRAPPER_LINE ? "ERROR: " : "ERROR: line " + line + ": ").trim();
let program = null, uniforms = {}, lost = false;
const build = () => {
	const compile = (type, text) => {
		const shader = gl.createShader(type);
		gl.shaderSource(shader, text);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(mapLog(gl.getShaderInfoLog(shader)));
		return shader;
	};
	const vertex = compile(gl.VERTEX_SHADER, VERTEX), fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT);
	const next = gl.createProgram();
	gl.attachShader(next, vertex);
	gl.attachShader(next, fragment);
	gl.linkProgram(next);
	gl.deleteShader(vertex);
	gl.deleteShader(fragment);
	if (!gl.getProgramParameter(next, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(mapLog(gl.getProgramInfoLog(next)));
	program = next;
	gl.useProgram(program);
	for (const name of ["iResolution", "iTime", "iTimeDelta", "iFrame", "iMouse"]) uniforms[name] = gl.getUniformLocation(program, name);
};
try { build(); } catch (error) { return fail("Shader does not compile", error.message); }
const MAX_PIXELS = 2400000;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const mouse = [0, 0, 0, 0];
let time = 0, frame = 0, raf = 0, last = 0, onScreen = true;
const resize = (width, height) => {
	let scale = Math.min(devicePixelRatio || 1, 2);
	if (width * height * scale * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (width * height));
	canvas.width = Math.max(1, Math.round(width * scale));
	canvas.height = Math.max(1, Math.round(height * scale));
};
const draw = (delta) => {
	if (!program || lost) return;
	gl.viewport(0, 0, canvas.width, canvas.height);
	gl.uniform3f(uniforms.iResolution, canvas.width, canvas.height, 1);
	gl.uniform1f(uniforms.iTime, time);
	gl.uniform1f(uniforms.iTimeDelta, delta);
	gl.uniform1i(uniforms.iFrame, frame);
	gl.uniform4f(uniforms.iMouse, mouse[0], mouse[1], mouse[2], mouse[3]);
	gl.drawArrays(gl.TRIANGLES, 0, 3);
	frame++;
	// Shadertoy: a positive w marks only the frame of the click.
	if (mouse[3] > 0) mouse[3] = -mouse[3];
};
const running = () => !reduceMotion.matches && !lost && program !== null && onScreen &&
	document.visibilityState === "visible" && document.documentElement.dataset.pilotHostVisible !== "false";
const tick = (now) => {
	raf = 0;
	const delta = last ? Math.min((now - last) / 1000, 0.1) : 0;
	last = now;
	time += delta;
	draw(delta);
	schedule();
};
const schedule = () => {
	if (running()) { if (!raf) raf = requestAnimationFrame(tick); return; }
	if (raf) cancelAnimationFrame(raf);
	raf = 0;
	// Resume without a jump in iTime.
	last = 0;
};
const still = () => { if (!raf) draw(0); };
const box = canvas.getBoundingClientRect();
resize(box.width, box.height);
draw(0);
new ResizeObserver(([entry]) => { resize(entry.contentRect.width, entry.contentRect.height); still(); }).observe(canvas);
new IntersectionObserver(([entry]) => { onScreen = entry.isIntersecting; schedule(); }).observe(canvas);
new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ["data-pilot-host-visible"] });
document.addEventListener("visibilitychange", schedule);
reduceMotion.addEventListener("change", schedule);
const point = (event) => {
	const rect = canvas.getBoundingClientRect();
	return [(event.clientX - rect.left) * canvas.width / rect.width, (rect.bottom - event.clientY) * canvas.height / rect.height];
};
canvas.addEventListener("pointerdown", (event) => {
	const [x, y] = point(event);
	mouse[0] = mouse[2] = x;
	mouse[1] = mouse[3] = y;
	canvas.setPointerCapture(event.pointerId);
	still();
});
canvas.addEventListener("pointermove", (event) => {
	if (!(event.buttons & 1)) return;
	[mouse[0], mouse[1]] = point(event);
	still();
});
const release = () => { mouse[2] = -Math.abs(mouse[2]); mouse[3] = -Math.abs(mouse[3]); still(); };
canvas.addEventListener("pointerup", release);
canvas.addEventListener("pointercancel", release);
canvas.addEventListener("webglcontextlost", (event) => { event.preventDefault(); lost = true; program = null; schedule(); });
canvas.addEventListener("webglcontextrestored", () => {
	lost = false;
	try { build(); } catch (error) { return fail("Shader does not compile", error.message); }
	draw(0);
	schedule();
});
schedule();
})();`;

/** JSON with "<" escaped cannot close the script element or open an HTML comment. */
const scriptValue = (value: string) => JSON.stringify(value).replaceAll("<", "\\u003c");

export function shaderDocumentBody(source: string): string {
	const constants =
		"const VERTEX=" +
		scriptValue(SHADER_VERTEX_SOURCE) +
		";const FRAGMENT=" +
		scriptValue(shaderFragmentSource(source)) +
		";const WRAPPER_LINE=" +
		WRAPPER_LINE +
		";";
	return (
		"<style>" +
		shaderStyles +
		'</style><canvas id="pilot-shader" aria-label="Animated shader"></canvas><script>{' +
		constants +
		player +
		"}</script>"
	);
}
