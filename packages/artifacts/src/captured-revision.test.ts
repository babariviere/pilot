import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	parseStoredArtifactRevision,
	parseStoredVisualRevision,
	readStoredFile,
	StoredArtifactTooLarge,
} from "./stored-revision.ts";

const expected = { id: "11111111-1111-1111-1111-111111111111", sessionId: "owner", projectId: "project", revision: 1 };
const value = {
	...expected,
	title: "Saved",
	kind: "html",
	createdAt: 1,
	updatedAt: 2,
	libraries: [],
	source: "<script>throw Error('never execute')</script>\r\né😀",
	html: "not a source",
	visual: { api: 1, engine: "saved" },
};

for (const kind of ["html", "react", "swiftui", "shader", "visual", "image"]) {
	test(`passive captured ${kind} keeps exact bytes without preparing a preview`, () => {
		const bytes = Buffer.from(`\uFEFF${JSON.stringify({ ...value, kind }, null, 2).replaceAll("\n", "\r\n")}\r\n`);
		const result = parseStoredArtifactRevision(bytes, expected);
		assert.equal(result.bytes, bytes);
		assert.equal(result.artifact.source, value.source);
		assert.equal(result.artifact.html, value.html);
		assert.equal(result.artifact.kind, kind);
		if (kind !== "visual") assert.throws(() => parseStoredVisualRevision(bytes, expected), /Unsupported/);
	});
}

test("captured parser refuses mismatched identities and corrupt input without source in errors", () => {
	for (const patch of [
		{ id: "other" },
		{ sessionId: "other" },
		{ projectId: "other" },
		{ revision: 2 },
		{ kind: "unknown" },
		{ source: null },
		{ title: null },
		{ libraries: null },
	]) {
		assert.throws(
			() => parseStoredArtifactRevision(Buffer.from(JSON.stringify({ ...value, ...patch })), expected),
			/mismatch|Unsupported/,
		);
	}
	for (const bytes of [Buffer.from("private invalid JSON"), Buffer.from([0xff])]) {
		assert.throws(() => parseStoredArtifactRevision(bytes, expected), {
			message: "Invalid stored artifact JSON or UTF-8",
		});
	}
	assert.throws(() => parseStoredArtifactRevision(new Uint8Array(1024 * 1024 + 1), expected), StoredArtifactTooLarge);
});

test("captured file reader limits before hydration, refuses final symlink and keeps missing explicit", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "captured-passive-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "1.json");
	await writeFile(path, JSON.stringify(value));
	assert.deepEqual(Buffer.from(await readStoredFile(path, 4096)), Buffer.from(JSON.stringify(value)));
	await assert.rejects(readStoredFile(path, 1), StoredArtifactTooLarge);
	await symlink(path, join(root, "link"));
	await assert.rejects(readStoredFile(join(root, "link"), 4096));
	await assert.rejects(readStoredFile(join(root, "missing"), 4096), { code: "ENOENT" });
});
