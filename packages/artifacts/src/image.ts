/** Image publications embed their bytes, never a filesystem or network capability. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";

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
