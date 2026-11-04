import assert from "node:assert/strict";
import { test } from "node:test";
import type { ArtifactWrite } from "@pilot/protocol";
import { previewArtifact } from "./preview.ts";

test("old preview callers get explicit rejection without loading a renderer", async () => {
	for (const kind of ["html", "react", "swiftui"])
		await assert.rejects(
			previewArtifact({ title: "Legacy", kind, source: "while (true) {}" } as ArtifactWrite),
			/Supported kinds: image, visual, shader/,
		);
	for (const kind of ["image", "visual", "shader"] as const)
		await assert.rejects(previewArtifact({ title: "Draft", kind, source: "unused" }), /preview is unavailable/);
});
