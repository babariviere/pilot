import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";

test("the pinned CLI binds its dispatcher to patched external Undici, not the embedded copy", async () => {
	const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
	const bundle = new URL("./bundle/chunks/chunk-MM3LKT73.js", sdk);
	const source = await readFile(bundle, "utf8");
	assert.ok(source.includes('var undici=__toESM(require("undici"),1);'));
	assert.ok(!source.includes("require_undici()"), "the embedded Undici root must never initialize");
	const require = createRequire(bundle);
	assert.equal((require("undici/package.json") as { version: string }).version, "8.12.3");
});
