import assert from "node:assert/strict";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { imageSize, loadArtifactImage, MAX_IMAGE_BYTES, validateImageSource } from "./image.ts";
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
	assert.match(prepared.html, /width:auto;height:auto;max-width:100vw;max-height:100vh/);
	assert.doesNotMatch(prepared.html, /width:100%;height:100vh/);
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

test("image header size is upright, as decoders report it, without decoding pixels", () => {
	const url = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString("base64")}`;
	const u16 = (n: number) => Buffer.from([n >> 8, n & 255]);
	const u32 = (n: number) => Buffer.from([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
	// One IFD entry: orientation (0x0112), SHORT, count 1.
	const tiff = (le: boolean, orientation: number) => {
		const b = Buffer.alloc(26);
		b.write(le ? "II" : "MM", 0, "latin1");
		const w16 = (n: number, at: number) => (le ? b.writeUInt16LE(n, at) : b.writeUInt16BE(n, at));
		const w32 = (n: number, at: number) => (le ? b.writeUInt32LE(n, at) : b.writeUInt32BE(n, at));
		w16(42, 2);
		w32(8, 4);
		w16(1, 8);
		w16(0x0112, 10);
		w16(3, 12);
		w32(1, 14);
		w16(orientation, 18);
		return b;
	};
	const chunk = (type: string, data: Buffer) =>
		Buffer.concat([u32(data.length), Buffer.from(type, "latin1"), data, u32(0)]);
	const pngWith = (...chunks: Buffer[]) =>
		Buffer.concat([
			png.subarray(0, 8),
			chunk("IHDR", Buffer.concat([u32(1600), u32(900), Buffer.from([8, 2, 0, 0, 0])])),
			...chunks,
			chunk("IDAT", Buffer.alloc(4)),
		]);
	const segment = (marker: number, data: Buffer) =>
		Buffer.concat([Buffer.from([255, marker]), u16(data.length + 2), data]);
	const sof = (marker: number) => segment(marker, Buffer.from([8, 0, 3, 0, 4, 3, 1, 17, 0, 2, 17, 1, 3, 17, 1]));
	const jpeg = (...segments: Buffer[]) =>
		Buffer.concat([Buffer.from([255, 216]), ...segments, Buffer.from([255, 217])]);
	const exif = (le: boolean, orientation: number) =>
		segment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff(le, orientation)]));

	assert.deepEqual(imageSize(source), { mimeType: "image/png", width: 1, height: 1 });
	assert.deepEqual(imageSize(url("image/png", pngWith())), { mimeType: "image/png", width: 1600, height: 900 });
	assert.deepEqual(imageSize(url("image/png", pngWith(chunk("eXIf", tiff(true, 6))))), {
		mimeType: "image/png",
		width: 900,
		height: 1600,
	});
	// Only eXIf before the image data is applied.
	const late = Buffer.concat([pngWith(), chunk("eXIf", tiff(true, 6))]);
	assert.deepEqual(imageSize(url("image/png", late)), { mimeType: "image/png", width: 1600, height: 900 });
	assert.deepEqual(imageSize(url("image/jpeg", jpeg(segment(0xe0, Buffer.from("JFIF\0")), sof(0xc0)))), {
		mimeType: "image/jpeg",
		width: 4,
		height: 3,
	});
	for (const [le, orientation, width, height] of [
		[false, 6, 3, 4],
		[true, 8, 3, 4],
		[false, 5, 3, 4],
		[true, 3, 4, 3],
	] as const)
		assert.deepEqual(
			imageSize(url("image/jpeg", jpeg(exif(le, orientation), segment(0xc4, Buffer.alloc(4)), sof(0xc2)))),
			{ mimeType: "image/jpeg", width, height },
		);
	const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.from([0x20, 3, 0x58, 2, 0, 0, 0])]);
	assert.deepEqual(imageSize(url("image/gif", gif)), { mimeType: "image/gif", width: 800, height: 600 });
	// No hint for other formats, missing frames, truncated or zero-size headers.
	assert.equal(imageSize(url("image/webp", Buffer.from("RIFF1234WEBPVP8 "))), undefined);
	assert.equal(imageSize(url("image/jpeg", jpeg(exif(false, 6)))), undefined);
	assert.equal(imageSize(url("image/jpeg", jpeg(exif(false, 6)).subarray(0, 12))), undefined);
	assert.equal(imageSize(url("image/png", png.subarray(0, 20))), undefined);
	assert.equal(imageSize(url("image/gif", Buffer.from("GIF89a\0\0\0\0"))), undefined);
});
