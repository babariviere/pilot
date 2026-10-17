import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareArtifact } from "./render.ts";
import { checkShader, formatShaderErrors, shaderFragmentSource } from "./shader.ts";

const valid = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
	vec2 uv = fragCoord / iResolution.xy;
	fragColor = vec4(uv, 0.5 + 0.5 * sin(iTime + float(iFrame) * iTimeDelta), 1.0) * step(0.0, iMouse.x);
}`;

test("valid shaders publish with the WebGL2 player and their escaped source", async () => {
	const source = `${valid}\n// </script><!-- not markup`;
	const { html, libraries } = await prepareArtifact({ title: "Waves", kind: "shader", source });
	assert.deepEqual(libraries, []);
	assert.match(html, /<canvas id="pilot-shader"/);
	assert.match(html, /getContext\("webgl2"/);
	assert.match(html, /prefers-reduced-motion: reduce/);
	assert.match(html, /pilotHostVisible/);
	// Source text can never close the player's script element.
	assert.equal(html.split("</script>").length, html.split("<script").length);
	assert.doesNotMatch(html, /<!-- not markup/);
	assert.ok(html.indexOf("Content-Security-Policy") < html.indexOf("pilot-shader"));
});

test("compile errors reject publication with lines in the agent's source", async () => {
	const source =
		"void mainImage(out vec4 fragColor, in vec2 fragCoord) {\n\tvec2 uv = fragCoord / iResolution.xy;\n\tfloat x = 1;\n\tfragColor = vec4(uv, x, 1.0);\n}";
	const errors = await checkShader(source);
	assert.equal(errors[0]?.line, 3);
	assert.match(errors[0]!.message, /cannot convert/);
	assert.ok(errors.every((error) => !/compilation terminated|No code generated/.test(error.message)));
	await assert.rejects(
		prepareArtifact({ title: "Broken", kind: "shader", source }),
		(error: Error) => /line 3: .*cannot convert/.test(error.message) && error.message.includes("float x = 1;"),
	);
});

test("undeclared identifiers and a missing mainImage are explained", async () => {
	const undeclared = await checkShader("void mainImage(out vec4 c, in vec2 p) {\n\tc = vec4(missing);\n}");
	assert.equal(undeclared[0]?.line, 2);
	assert.match(undeclared[0]!.message, /missing/);
	const absent = await checkShader("vec4 color() { return vec4(1.0); }");
	assert.equal(absent.length, 1);
	assert.equal(absent[0]?.line, undefined);
	assert.match(formatShaderErrors(absent, ""), /Define void mainImage\(out vec4 fragColor, in vec2 fragCoord\)/);
});

test("shaders omit #version and libraries", async () => {
	await assert.rejects(
		prepareArtifact({ title: "Versioned", kind: "shader", source: `#version 300 es\n${valid}` }),
		/must omit #version/,
	);
	await assert.rejects(
		prepareArtifact({ title: "Libraries", kind: "shader", source: valid, libraries: ["three"] }),
		/do not use libraries/,
	);
	assert.match(shaderFragmentSource(valid), /^#version 300 es\n[\s\S]*#line 1\n/);
});

test("an aborted check stops its worker", async () => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(checkShader(valid, { signal: controller.signal }));
});
