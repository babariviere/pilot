/** Passive local resource checks. Never downloads, publishes, or treats a URL as evidence. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HumanActionContent } from "@pilot/protocol";

const MAX_FILE = 64 * 1024 * 1024;
const inside = (root: string, path: string) => {
	const rel = relative(root, path);
	return rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
};
export function attentionURL(value: string): string {
	const u = new URL(value);
	if (u.protocol !== "https:" || u.username || u.password || !u.hostname || /[\u0000-\u0020\u007f]/u.test(value))
		throw new Error("Unsupported attention destination");
	return value;
}

/** Hash through a pinned descriptor; reject replacement, links and changed bytes during the read. */
export async function verifyAttentionFile(root: string, uri: string, digest: string): Promise<boolean> {
	const requested = fileURLToPath(uri),
		canonicalRoot = await realpath(root);
	if (!inside(root, requested)) return false;
	const path = resolve(canonicalRoot, relative(root, requested));
	if (!inside(canonicalRoot, path) || (await realpath(dirname(path))) !== dirname(path)) return false;
	const before = await lstat(path);
	if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE) return false;
	const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const pin = await f.stat();
		if (!pin.isFile() || pin.dev !== before.dev || pin.ino !== before.ino || pin.size > MAX_FILE) return false;
		const hash = createHash("sha256"),
			chunk = Buffer.alloc(64 * 1024);
		let size = 0;
		while (true) {
			const read = await f.read(chunk, 0, chunk.length, size);
			if (!read.bytesRead) break;
			size += read.bytesRead;
			if (size > MAX_FILE) return false;
			hash.update(chunk.subarray(0, read.bytesRead));
		}
		const after = await f.stat(),
			current = await lstat(path);
		return (
			size === pin.size &&
			after.size === pin.size &&
			after.mtimeMs === pin.mtimeMs &&
			after.ctimeMs === pin.ctimeMs &&
			current.dev === pin.dev &&
			current.ino === pin.ino &&
			(await realpath(path)) === path &&
			hash.digest("hex") === digest
		);
	} finally {
		await f.close();
	}
}

export async function verifyAttentionResources(
	root: string,
	content: HumanActionContent,
	artifact: (ref: Extract<HumanActionContent["files"][number], { kind: "artifact" }>) => Promise<boolean>,
): Promise<boolean> {
	try {
		attentionURL(content.destination.uri);
		for (const ref of content.files) {
			if (!(ref.kind === "file" ? await verifyAttentionFile(root, ref.uri, ref.sha256) : await artifact(ref)))
				return false;
		}
		return true;
	} catch {
		return false;
	}
}
