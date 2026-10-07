import assert from "node:assert/strict";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadArtifactImage, MAX_IMAGE_BYTES, validateImageSource } from "./image.ts";
import { prepareArtifact, validateArtifact } from "./render.ts";
import { ArtifactStore } from "./store.ts";

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==",
	"base64",
);
const source = `data:image/png;base64,${png.toString("base64")}`;

test("image preparation fits the viewport, embeds bytes and preserves the sandbox", async () => {
	const prepared = await prepareArtifact({ title: "Image", kind: "image", source });
	assert.deepEqual(prepared.libraries, []);
	assert.ok(prepared.html.includes(`src="${source}"`));
	assert.match(prepared.html, /object-fit:contain/);
	assert.match(prepared.html, /height:100vh/);
	assert.match(prepared.html, /connect-src 'none'/);
	assert.doesNotMatch(prepared.html, /pilot-artifact:\/\/library\//);
	assert.throws(
		() => validateArtifact({ title: "Image", kind: "image", source, libraries: ["react"] }),
		/do not use libraries/,
	);
});

test("image revisions survive removal of the original file and can be updated and reopened", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-image-"));
	try {
		await writeFile(join(dir, "image.png"), png);
		const embedded = await loadArtifactImage("image.png", dir);
		assert.equal(embedded, source);
		const store = new ArtifactStore(dir, { sessionId: "images" });
		const first = await store.create({ title: "Image", kind: "image", source: embedded });
		await rm(join(dir, "image.png"));
		const reopened = new ArtifactStore(dir, { sessionId: "images" });
		assert.equal((await reopened.get(first.id)).source, source);
		assert.ok((await reopened.get(first.id)).html.includes(source));
		const second = await reopened.update(first.id, { title: "Renamed image", kind: "image", source }, 1);
		assert.equal(second.revision, 2);
		assert.equal((await reopened.get(first.id, 1)).title, "Image");
		assert.equal((await reopened.list())[0]?.kind, "image");
		await assert.rejects(
			reopened.update(first.id, { title: "Stale", kind: "image", source }, 1),
			/revision conflict/,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("image inputs reject URLs, malformed data, mismatched formats and non-files", async () => {
	for (const url of ["https://example.com/a.png", "http://localhost/a.png", "file:///tmp/a.png"])
		await assert.rejects(loadArtifactImage(url, tmpdir()), /local path or data URL/);
	for (const invalid of [
		"data:text/html;base64,PHNjcmlwdD4=",
		"data:image/png;base64,invalid",
		source.replace("image/png", "image/jpeg"),
		`${source}" onerror="alert(1)`,
		"data:image/svg+xml;base64,PHN2Zz4=",
	])
		assert.throws(() => validateImageSource(invalid));
	await assert.rejects(loadArtifactImage(tmpdir(), tmpdir()), /regular file/);
	await assert.rejects(loadArtifactImage(`${source}<script>`, tmpdir()), /base64/);
	const dir = await mkdtemp(join(tmpdir(), "pilot-image-bad-"));
	try {
		await writeFile(join(dir, "fake.png"), "<script>alert(1)</script>");
		await assert.rejects(loadArtifactImage("fake.png", dir), /PNG, JPEG, GIF or WebP/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("image byte limits allow larger-than-code images but reject oversized files and data URLs", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-image-limit-"));
	try {
		const path = join(dir, "large.png");
		await writeFile(path, png);
		await truncate(path, MAX_IMAGE_BYTES);
		const embedded = await loadArtifactImage(path, dir);
		validateImageSource(embedded);
		assert.ok(embedded.length > 512 * 1024);
		await truncate(path, MAX_IMAGE_BYTES + 1);
		await assert.rejects(loadArtifactImage(path, dir), /16 MiB/);
		const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1);
		png.copy(oversized);
		assert.throws(() => validateImageSource(`data:image/png;base64,${oversized.toString("base64")}`), /16 MiB/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("image formats are detected from bytes rather than file extensions", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-image-formats-"));
	try {
		for (const [mime, bytes] of [
			["image/png", png],
			["image/jpeg", Buffer.from([255, 216, 255, 224])],
			["image/gif", Buffer.from("GIF89a")],
			["image/webp", Buffer.from("RIFF1234WEBP")],
		] as const) {
			await writeFile(join(dir, "image.bin"), bytes);
			const embedded = await loadArtifactImage("image.bin", dir);
			assert.equal(embedded, `data:${mime};base64,${bytes.toString("base64")}`);
			validateImageSource(embedded);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
