/**
 * Metal for shader nodes (docs/native-visuals.md, phase 3). The kernel translates each shader's GLSL to Metal Shading
 * Language at publish with naga (pinned, WebAssembly), so translation errors reach the agent and the app only compiles
 * the stored MSL. The GLSL is the same Shadertoy-style mainImage as shader artifacts, checked first with glslang.
 */
import { NagaError, nagaVersion, parseGlsl, validate, writeMsl } from "naga-wasm";

/** One shader node's translation, stored in the revision and found by the app through glsl and inputs. */
export interface VisualShader {
	/** The node's GLSL, exactly as trees carry it. */
	glsl: string;
	/** Input names in name order: float uniforms after the built-in ones. */
	inputs: string[];
	msl: string;
	/** The fragment function in msl. */
	entry: string;
}

/**
 * Byte offsets in the uniform buffer the app passes at buffer index 0 (struct PilotUniforms in the MSL). iResolution
 * is a float4 (z = 1, w = 0); each input is a float after inputs, and the struct size is rounded up to 16 bytes.
 */
export const VISUAL_SHADER_LAYOUT = Object.freeze({
	iMouse: 0,
	iResolution: 16,
	iTime: 32,
	iTimeDelta: 36,
	iFrame: 40,
	inputs: 44,
});

export const VISUAL_SHADER_TRANSLATOR = `naga ${nagaVersion}`;

export class VisualShaderError extends Error {
	readonly line?: number;
	constructor(message: string, line?: number) {
		super(message);
		this.line = line;
	}
}

function prelude(inputs: readonly string[]): string[] {
	return [
		"#version 450",
		"layout(location = 0) out vec4 pilotFragColor;",
		"layout(set = 0, binding = 0) uniform PilotUniforms {",
		"  vec4 iMouse;",
		"  vec4 pilotResolution;",
		"  float iTime;",
		"  float iTimeDelta;",
		"  int iFrame;",
		...inputs.map((name) => `  float ${name};`),
		"};",
		"#define iResolution pilotResolution.xyz",
	];
}

/**
 * Shadertoy's origin is the bottom left and its alpha straight; Metal's are the top left and premultiplied, so the
 * wrapper flips y and premultiplies.
 */
const FOOTER =
	"\nvoid main() {\n  vec4 color = vec4(0.0);\n  mainImage(color, vec2(gl_FragCoord.x, pilotResolution.y - gl_FragCoord.y));\n  pilotFragColor = vec4(color.rgb * color.a, color.a);\n}\n";

/** Vulkan GLSL for naga: the prelude, the agent's GLSL and a main that calls mainImage. */
export function visualShaderGlsl(glsl: string, inputs: readonly string[]): string {
	return `${prelude(inputs).join("\n")}\n${glsl}${FOOTER}`;
}

/** Translate one shader to MSL. Throws VisualShaderError with a line in the agent's GLSL when naga rejects it. */
export function translateVisualShader(glsl: string, inputs: readonly string[]): VisualShader {
	const offset = prelude(inputs).length;
	const glslLines = glsl.split(/\r?\n/).length;
	let code: string;
	let entry: string | undefined;
	try {
		const module = parseGlsl(visualShaderGlsl(glsl, inputs), { stage: "fragment" });
		try {
			const info = validate(module);
			try {
				const output = writeMsl(module, info, { langVersion: [2, 4], reflect: true });
				code = output.code;
				const point = output.reflection.entryPoints.main;
				entry = point && "name" in point ? point.name : undefined;
			} finally {
				info.free();
			}
		} finally {
			module.free();
		}
	} catch (error) {
		if (!(error instanceof NagaError)) throw error;
		const at = Number(error.formatted.match(/glsl:(\d+):\d+/)?.[1]);
		const line = at > offset && at <= offset + glslLines ? at - offset : undefined;
		throw new VisualShaderError(error.message, line);
	}
	if (!entry) throw new VisualShaderError("naga wrote no fragment function");
	return { glsl, inputs: [...inputs], msl: bindUniforms(code, inputs), entry };
}

/**
 * naga has no MSL binding map in WebAssembly, so it marks the uniform block with a placeholder attribute. The only
 * resource is that block: bind it to buffer 0, and check that its members sit at VISUAL_SHADER_LAYOUT's offsets.
 */
function bindUniforms(msl: string, inputs: readonly string[]): string {
	const placeholders = msl.match(/\[\[user\(fake\d+\)\]\]/g) ?? [];
	if (placeholders.length !== 1)
		throw new VisualShaderError("the shader declares resources of its own; use inputs for values instead");
	const struct = msl.match(/struct PilotUniforms \{\n([\s\S]*?)\n\};/)?.[1];
	const members = (struct ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !/^char _pad\d+\[\d+\];$/.test(line));
	const expected = [
		"metal::float4 iMouse;",
		"metal::float4 pilotResolution;",
		"float iTime;",
		"float iTimeDelta;",
		"int iFrame;",
		...inputs.map((name) => `float ${name};`),
	];
	for (let index = 0; index < expected.length; index++)
		if (members[index] !== expected[index]) {
			const input = index - 5;
			throw new VisualShaderError(
				input >= 0
					? `input "${inputs[input]}" is a reserved word in Metal; rename it`
					: "Pilot could not lay out the shader's uniforms for Metal",
			);
		}
	if (members.length !== expected.length)
		throw new VisualShaderError("Pilot could not lay out the shader's uniforms for Metal");
	return msl.replace(placeholders[0]!, "[[buffer(0)]]");
}
