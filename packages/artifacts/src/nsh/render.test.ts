import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { ArtifactWrite } from "@pilot/protocol";
import { prepareArtifact, validateArtifact } from "./render.ts";

test("NSH preparation carries exact source metadata without producing a document", async () => {
	const source = '\uFEFFexport default () => "é😀";\r\n';
	assert.deepEqual(await prepareArtifact({ title: "Source", kind: "nsh", source, entry: "view.tsx" }), {
		html: "",
		nsh: {
			api: 1,
			runtime: "nsh 0.6.1",
			entry: "view.tsx",
			sourceSha256: createHash("sha256").update(source).digest("hex"),
			sourceBytes: Buffer.byteLength(source),
		},
	});
});

for (const kind of ["html", "react", "swiftui", "visual", "shader", "future"]) {
	test(`${kind} cannot be validated or prepared, even with executable source`, async () => {
		const write = { title: "Retired", kind, source: "while (true) {}" } as ArtifactWrite;
		assert.throws(() => validateArtifact(write), /Supported artifact kinds: image, nsh/);
		await assert.rejects(prepareArtifact(write), /Supported artifact kinds: image, nsh/);
	});
}

test("publication normalizes NSH titles and rejects invalid metadata", () => {
	const write: ArtifactWrite = {
		title: "  Native  ",
		kind: "nsh",
		source: "export default () => null",
		entry: "view.tsx",
	};
	assert.deepEqual(validateArtifact(write), { ...write, title: "Native" });
	assert.throws(() => validateArtifact({ ...write, title: " " }), /title/);
	assert.throws(() => validateArtifact({ ...write, source: "😀".repeat(131_073) }), /512 KiB/);
});
