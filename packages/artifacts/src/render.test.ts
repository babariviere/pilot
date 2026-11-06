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

test("validation normalizes titles, preserves source bytes and keeps visual JSON byte limits", () => {
	const prefix = "() => () => null // ";
	const source = prefix + "é".repeat((256 * 1024 - prefix.length) / 2);
	assert.equal(Buffer.byteLength(source), 256 * 1024);
	const write = { title: "  Native  ", kind: "visual" as const, source };
	assert.deepEqual(validateArtifact(write), { ...write, title: "Native", libraries: [] });
	assert.throws(() => validateArtifact({ ...write, source: `${source}é` }), /256 KiB/);
	const data = "é".repeat((1024 * 1024 - 2) / 2);
	assert.equal(validateArtifact({ ...write, data }).data, data);
	assert.throws(() => validateArtifact({ ...write, data: `${data}é` }), /1 MiB/);
});

test("public preparation accepts JSON data without changing its result shape", async () => {
	const data = { label: "é", values: [0, false, null] };
	const prepared = await prepareArtifact({
		title: "  Serializer  ",
		kind: "visual",
		source:
			'({ ui, data }) => { if (data.label !== "é") throw Error("wrong data"); return () => ui.text(data.label); }',
		data,
	});
	assert.equal(prepared.visual?.check.nodes, 1);
	assert.deepEqual(Object.keys(prepared).sort(), ["html", "libraries", "visual"]);
});
