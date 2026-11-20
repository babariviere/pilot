import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	parseStoredArtifactRevision,
	ArtifactNotFound,
	readStoredFile,
	StoredArtifactTooLarge,
} from "../storage/stored-revision.ts";

const expected = { id: "11111111-1111-1111-1111-111111111111", sessionId: "owner", projectId: "project", revision: 1 };
const value = {
	...expected,
	title: "Saved",
	kind: "image",
	createdAt: 1,
	updatedAt: 2,
	libraries: [],
	source:
		"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==",
	html: "not a source",
	visual: { api: 1, engine: "saved" },
};

test("passive captured image keeps exact bytes without preparing a preview", () => {
	const bytes = Buffer.from(`\uFEFF${JSON.stringify(value, null, 2).replaceAll("\n", "\r\n")}\r\n`);
	const result = parseStoredArtifactRevision(bytes, expected);
	assert.equal(result.bytes, bytes);
	assert.equal(result.artifact.source, value.source);
	assert.equal(result.artifact.html, value.html);
	assert.equal(result.artifact.kind, "image");
	assert.ok(!("libraries" in result.artifact));
	assert.ok(!("visual" in result.artifact));
});

for (const kind of ["html", "react", "swiftui", "shader", "visual", "unknown"]) {
	test(`captured parser excludes ${kind}`, () => {
		assert.throws(
			() => parseStoredArtifactRevision(Buffer.from(JSON.stringify({ ...value, kind })), expected),
			ArtifactNotFound,
		);
	});
}

test("captured parser refuses mismatched identities and corrupt input without source in errors", () => {
	for (const patch of [
		{ id: "other" },
		{ sessionId: "other" },
		{ projectId: "other" },
		{ revision: 2 },
		{ source: null },
		{ title: null },
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
