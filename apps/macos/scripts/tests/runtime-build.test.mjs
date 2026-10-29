import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeRuntimeBuild } from "../runtime-build.mjs";

test("Swift runtime stamp binds immutable source, package and actual bundled Node", () => {
	const root = mkdtempSync(join(tmpdir(), "swift-runtime-build-"));
	try {
		writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.89.0" }));
		assert.throws(() => writeRuntimeBuild(root, "unknown"));
		writeRuntimeBuild(root, "a".repeat(40));
		assert.deepEqual(JSON.parse(readFileSync(join(root, "runtime-build.json"), "utf8")), {
			schema: 1,
			source: "a".repeat(40),
			version: "1.89.0",
			protocol: 1,
			platform: process.platform,
			arch: process.arch,
			node: process.versions.node,
		});
		assert.throws(() => writeRuntimeBuild(root, "b".repeat(40)), "never overwrite a conflicting stamp");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
