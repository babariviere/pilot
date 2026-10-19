import assert from "node:assert/strict";
import { test } from "node:test";
import { checkVisual, VisualCheckError } from "./index.ts";
import { translateVisualShader, VISUAL_SHADER_LAYOUT, VisualShaderError } from "./metal.ts";

const plasma = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
  float v = sin(uv.x * 6.0 + iTime * speed) + sin(length(uv) * 9.0 - iTime);
  fragColor = vec4(0.5 + 0.5 * cos(vec3(0.0, 2.0, 4.0) + v), glow);
}`;

test("shaders translate to MSL with the uniforms at buffer 0 in the documented layout", () => {
	const shader = translateVisualShader(plasma, ["glow", "speed"]);
	assert.equal(shader.entry, "main_");
	assert.deepEqual(shader.inputs, ["glow", "speed"]);
	assert.match(shader.msl, /constant PilotUniforms& global \[\[buffer\(0\)\]\]/);
	assert.doesNotMatch(shader.msl, /\[\[user\(fake/);
	assert.match(shader.msl, /fragment main__Output main_\(|fragment \w+ main_\(/);
	const struct = shader.msl.match(/struct PilotUniforms \{\n([\s\S]*?)\n\};/)?.[1] ?? "";
	assert.deepEqual(
		struct.split("\n").map((line) => line.trim()),
		[
			"metal::float4 iMouse;",
			"metal::float4 pilotResolution;",
			"float iTime;",
			"float iTimeDelta;",
			"int iFrame;",
			"float glow;",
			"float speed;",
			"char _pad7[12];",
		],
	);
	assert.deepEqual(VISUAL_SHADER_LAYOUT, {
		iMouse: 0,
		iResolution: 16,
		iTime: 32,
		iTimeDelta: 36,
		iFrame: 40,
		inputs: 44,
	});
	// The same GLSL translates the same way, so the app's lookup by text finds it.
	assert.equal(translateVisualShader(plasma, ["glow", "speed"]).msl, shader.msl);
});

test("translation errors name the line in the agent's GLSL and reserved Metal words", () => {
	assert.throws(
		() => translateVisualShader("void mainImage(out vec4 c, in vec2 p) {\n  c = vec4(nope);\n}", []),
		(error: unknown) => error instanceof VisualShaderError && error.line === 2 && /nope/.test(error.message),
	);
	assert.throws(
		() => translateVisualShader("void mainImage(out vec4 c, in vec2 p) { c = vec4(kernel); }", ["kernel"]),
		/input "kernel" is a reserved word in Metal/,
	);
	assert.throws(
		() =>
			translateVisualShader(
				"layout(set = 1, binding = 0) uniform Extra { float x; };\nvoid mainImage(out vec4 c, in vec2 p) { c = vec4(x); }",
				[],
			),
		/declares resources of its own/,
	);
});

test("publication checks every shader the views show and stores its Metal", async () => {
	const source = `({ ui, state }) => {
  const s = state({ speed: 1, alt: false });
  return () => ui.column([
    ui.toggle({ label: "Alt", value: s.alt, onChange: (v) => (s.alt = v) }),
    ui.shader({ key: "plasma", inputs: { speed: s.speed, glow: 1 }, glsl: s.alt ? ${JSON.stringify(plasma.replace("glow", "0.5"))} : ${JSON.stringify(plasma)} }),
  ]);
}`;
	const visual = await checkVisual({ source, data: "null", id: "a" });
	// The toggle reveals a second shader; both are translated.
	assert.equal(visual.check.shaders, 2);
	assert.equal(visual.shaders?.length, 2);
	assert.deepEqual(
		visual.shaders?.map((shader) => [shader.inputs, shader.entry]),
		[
			[["glow", "speed"], "main_"],
			[["glow", "speed"], "main_"],
		],
	);
	await assert.rejects(
		checkVisual({
			source:
				'({ ui }) => () => ui.shader({ key: "x", glsl: "void mainImage(out vec4 c, in vec2 p) {\\n  c = vec4(nope);\\n}" })',
			data: "null",
			id: "a",
		}),
		(error: unknown) =>
			error instanceof VisualCheckError &&
			error.message.startsWith(
				'Visual check failed. Nothing was published. shader "x" does not compile as GLSL ES 3.00:\nline 2: ',
			),
	);
	const plain = await checkVisual({ source: '({ ui }) => () => ui.text("x")', data: "null", id: "a" });
	assert.equal(plain.shaders, undefined);
	assert.equal(plain.check.shaders, undefined);
});
