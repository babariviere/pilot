/**
 * The two mockup visuals in packages/protocol/fixtures/visual pass the publication check. The desktop app renders the
 * same files in its visual pane probe, so they stay working examples of stored visual revisions.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { loadQuickJSWasm } from "@earendil-works/pi-codemode";
import { runVisualCheck } from "./check.ts";
import { visualRuntime } from "./session.ts";

const fixtures = new URL("../../../protocol/fixtures/visual/", import.meta.url);

test("the mockup fixtures pass the publication check", async () => {
	for (const name of ["mockup-mobile.js", "mockup-desktop.js"]) {
		const text = await readFile(new URL(name, fixtures), "utf8");
		const result = await runVisualCheck({
			wasm: await loadQuickJSWasm(),
			runtime: await visualRuntime(),
			source: text.slice(text.indexOf("function visual")).trim(),
			data: "null",
			seed: "reference",
			now: 0,
		});
		assert.ok(result.ok, `${name}: ${JSON.stringify(result)}`);
		assert.ok(result.report.controls >= 6 && result.report.interactions >= 6, name);
	}
});
