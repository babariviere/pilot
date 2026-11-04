import assert from "node:assert/strict";
import { test } from "node:test";
import type { ArtifactWrite } from "@pilot/protocol";
import { prepareArtifact, validateArtifact } from "./render.ts";

for (const kind of ["html", "react", "swiftui", "future"]) {
	test(`${kind} cannot be validated or prepared, even with executable source`, async () => {
		const write = { title: "Retired", kind, source: "while (true) {}" } as ArtifactWrite;
		assert.throws(() => validateArtifact(write), /Supported kinds: image, visual, shader/);
		await assert.rejects(prepareArtifact(write), /Legacy HTML, React and SwiftUI artifacts are read-only/);
	});
}

test("native publication checks its source and keeps the compatibility document inert", async () => {
	const prepared = await prepareArtifact({
		title: "Native",
		kind: "visual",
		source: 'function visual({ ui }) { return () => ui.text("Native"); }',
	});
	assert.equal(prepared.visual?.check.nodes, 1);
	assert.deepEqual(prepared.libraries, []);
	assert.doesNotMatch(prepared.html, /library\/|artifact-root|Native\);/);
	assert.match(prepared.html, /Content-Security-Policy/);
});

test("publication rejects invalid metadata, oversized text and browser libraries", () => {
	const write: ArtifactWrite = { title: "Native", kind: "visual", source: "() => () => null" };
	assert.throws(() => validateArtifact({ ...write, title: " " }), /title/);
	assert.throws(() => validateArtifact({ ...write, source: "😀".repeat(131_073) }), /512 KiB/);
	assert.throws(() => validateArtifact({ ...write, libraries: ["react"] }), /do not use libraries/);
	assert.throws(() => validateArtifact({ ...write, libraries: "react" as never }), /must be an array/);
});
