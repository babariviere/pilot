/** Image publications embed their bytes, never a filesystem or network capability. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import type { ArtifactImageSize } from "@pilot/protocol";

export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_IMAGE_SOURCE_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 32;

function imageMime(bytes: Buffer): string {
	if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
	if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
	if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
	if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP")
		return "image/webp";
	throw new Error("Artifact images must be PNG, JPEG, GIF or WebP");
}

export function validateImageSource(source: string): void {
	if (Buffer.byteLength(source) > MAX_IMAGE_SOURCE_BYTES) throw new Error("Artifact image exceeds 16 MiB");
	const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(source);
	if (!match) throw new Error("Artifact image source must be a base64 PNG, JPEG, GIF or WebP data URL");
	const bytes = Buffer.from(match[2]!, "base64");
	if (bytes.length > MAX_IMAGE_BYTES) throw new Error("Artifact image exceeds 16 MiB");
	if (bytes.toString("base64") !== match[2] || imageMime(bytes) !== match[1])
		throw new Error("Artifact image data does not match its declared format");
}

/**
 * Upright pixel size from a validated PNG, JPEG or GIF data URL's header, as decoders report it (EXIF orientation
 * applied, GIF logical screen). Undefined for other formats or unreadable headers. Never decodes pixels.
 */
export function imageSize(source: string): ArtifactImageSize | undefined {
	const match = /^data:(image\/(?:png|jpeg|gif));base64,/.exec(source);
	if (!match) return undefined;
	const mimeType = match[1] as ArtifactImageSize["mimeType"];
	const bytes = Buffer.from(source.slice(match[0].length), "base64");
	try {
		const size =
			mimeType === "image/png" ? pngSize(bytes) : mimeType === "image/jpeg" ? jpegSize(bytes) : gifSize(bytes);
		return size && size.width > 0 && size.height > 0 ? { mimeType, ...size } : undefined;
	} catch {
		// A truncated header reads past the buffer. Publication never depends on this hint.
		return undefined;
	}
}

type Size = { width: number; height: number };

function upright(width: number, height: number, orientation: number): Size {
	return orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height };
}

/** EXIF orientation tag from a TIFF structure, 1 when absent. */
function orientation(tiff: Buffer): number {
	const order = tiff.toString("latin1", 0, 2);
	if (order !== "II" && order !== "MM") return 1;
	const u16 = (at: number) => (order === "II" ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
	const ifd = order === "II" ? tiff.readUInt32LE(4) : tiff.readUInt32BE(4);
	const count = u16(ifd);
	for (let i = 0; i < count; i++) {
		const at = ifd + 2 + i * 12;
		if (u16(at) === 0x0112) return u16(at + 8);
	}
	return 1;
}

function pngSize(bytes: Buffer): Size | undefined {
	if (bytes.toString("latin1", 12, 16) !== "IHDR") return undefined;
	const width = bytes.readUInt32BE(16);
	const height = bytes.readUInt32BE(20);
	// Decoders apply an eXIf chunk that precedes the image data.
	for (let at = 8; at + 8 <= bytes.length; ) {
		const length = bytes.readUInt32BE(at);
		const type = bytes.toString("latin1", at + 4, at + 8);
		if (type === "IDAT" || type === "IEND") break;
		if (type === "eXIf") return upright(width, height, orientation(bytes.subarray(at + 8, at + 8 + length)));
		at += 12 + length;
	}
	return { width, height };
}

function jpegSize(bytes: Buffer): Size | undefined {
	let turn = 1;
	for (let at = 2; at + 4 <= bytes.length; ) {
		if (bytes[at] !== 0xff) return undefined;
		const marker = bytes[at + 1]!;
		if (marker === 0xff) {
			at++;
			continue;
		}
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
			at += 2;
			continue;
		}
		if (marker === 0xd9 || marker === 0xda) return undefined;
		const length = bytes.readUInt16BE(at + 2);
		const data = bytes.subarray(at + 4, at + 2 + length);
		if (marker === 0xe1 && data.toString("latin1", 0, 6) === "Exif\0\0") turn = orientation(data.subarray(6));
		// Start of frame, excluding DHT (c4), JPG (c8) and DAC (cc): precision, height, width.
		else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
			return upright(data.readUInt16BE(3), data.readUInt16BE(1), turn);
		at += 2 + length;
	}
	return undefined;
}

function gifSize(bytes: Buffer): Size {
	return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

/** The agent tool alone resolves local paths, relative to its session working directory. */
export async function loadArtifactImage(source: string, cwd: string): Promise<string> {
	if (source.startsWith("data:")) {
		validateImageSource(source);
		return source;
	}
	if (/^[a-z][a-z0-9+.-]*:/i.test(source))
		throw new Error("Artifact images require a local path or data URL, not a remote URL");
	const file = await open(resolve(cwd, source), constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const stat = await file.stat();
		if (!stat.isFile()) throw new Error("Artifact image path must be a regular file");
		if (stat.size > MAX_IMAGE_BYTES) throw new Error("Artifact image exceeds 16 MiB");
		// Bound reads even if the file grows after stat. No image content runs in Node.
		const buffer = Buffer.alloc(MAX_IMAGE_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > MAX_IMAGE_BYTES) throw new Error("Artifact image exceeds 16 MiB");
		const bytes = buffer.subarray(0, length);
		return `data:${imageMime(bytes)};base64,${bytes.toString("base64")}`;
	} finally {
		await file.close();
	}
}
