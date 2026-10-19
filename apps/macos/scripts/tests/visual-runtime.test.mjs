// The app runs visuals on the same runtime.js the kernel's pre-check runs. VisualRuntime.swift embeds it; this test
// fails when the copy is stale. PILOT_UPDATE_VISUAL_RUNTIME=1 rewrites the copy.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

const runtime = new URL("../../../../packages/artifacts/src/visual/runtime.js", import.meta.url);
const embedded = new URL("../../Sources/PilotVisualsKit/VisualRuntime.swift", import.meta.url);

export function swiftSource(text) {
	assert.ok(!text.includes('"""##') && !text.includes("\\##"), "runtime.js must not contain a Swift raw string delimiter");
	return (
		"// Generated from packages/artifacts/src/visual/runtime.js by apps/macos/scripts/tests/visual-runtime.test.mjs.\n" +
		"// Do not edit: run PILOT_UPDATE_VISUAL_RUNTIME=1 node --test apps/macos/scripts/tests/visual-runtime.test.mjs.\n\n" +
		"/// The shared visual runtime, byte for byte, as the kernel's publish-time pre-check runs it.\n" +
		"public enum VisualRuntime {\n" +
		'    public static let source = ##"""\n' +
		text +
		'"""##\n' +
		"}\n"
	);
}

test("the app embeds the kernel's visual runtime unchanged", () => {
	const text = readFileSync(runtime, "utf8");
	assert.ok(text.endsWith("\n"), "runtime.js ends with a newline, which the raw string keeps");
	const expected = swiftSource(text);
	if (process.env.PILOT_UPDATE_VISUAL_RUNTIME === "1") writeFileSync(embedded, expected);
	assert.equal(
		readFileSync(embedded, "utf8"),
		expected,
		"Run PILOT_UPDATE_VISUAL_RUNTIME=1 node --test apps/macos/scripts/tests/visual-runtime.test.mjs",
	);
});

