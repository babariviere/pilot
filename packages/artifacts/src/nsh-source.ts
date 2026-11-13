/** Exact, single-file capture. The source runtime never gets these directory handles. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, mkdir, open } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { ArtifactNsh } from "@pilot/protocol";
import { callArtifactHost } from "./nsh-host.ts";

export const NSH_SOURCE_BYTES = 512 * 1024;
export const NSH_RUNTIME = "nsh 0.5.0";
const ENTRY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.tsx$/;

function child(directory: FileHandle, name: string): string {
	if (process.platform === "linux") return `/proc/self/fd/${directory.fd}/${name}`;
	throw new Error("Artifact file capture is unsupported on this host");
}
const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

async function withDirectory<T>(sessionDirectory: string, create: boolean, call: (dir: FileHandle) => Promise<T>) {
	const session = await open(sessionDirectory, DIRECTORY);
	let scratch: FileHandle | undefined;
	let artifacts: FileHandle | undefined;
	try {
		if (create) await mkdir(child(session, "scratch"), { mode: 0o700 }).catch(existing);
		scratch = await open(child(session, "scratch"), DIRECTORY);
		if (create) await mkdir(child(scratch, "artifacts"), { mode: 0o700 }).catch(existing);
		artifacts = await open(child(scratch, "artifacts"), DIRECTORY);
		return await call(artifacts);
	} finally {
		await Promise.allSettled([artifacts?.close(), scratch?.close(), session.close()]);
	}
}
function existing(error: NodeJS.ErrnoException) {
	if (error.code !== "EEXIST") throw error;
}

/** Host-selected session directory only, never a tool-supplied root. Does not clear existing files. */
export async function ensureArtifactScratch(sessionDirectory: string, executable?: string): Promise<string> {
	if (process.platform === "darwin")
		await callArtifactHost({ action: "ensure", sessionDirectory }, undefined, executable);
	else await withDirectory(sessionDirectory, true, async () => {});
	return join(sessionDirectory, "scratch", "artifacts");
}

/** Metadata is derived from the exact round-trippable UTF-8 source, never a compile/acceptance claim. */
export function nshSource(source: string, entry: string): ArtifactNsh {
	if (!ENTRY.test(entry)) throw new Error("NSH source requires one .tsx basename");
	const bytes = Buffer.from(source, "utf8");
	if (!source.trim() || bytes.length > NSH_SOURCE_BYTES || bytes.toString("utf8") !== source)
		throw new Error("NSH source must contain 1-512 KiB of exact UTF-8 text");
	return {
		api: 1,
		runtime: NSH_RUNTIME,
		entry,
		sourceSha256: createHash("sha256").update(bytes).digest("hex"),
		sourceBytes: bytes.length,
		rendering: "unsupported",
	};
}

/** No relative imports/assets are read. File and every untrusted parent are opened without following links. */
export async function captureNshSource(
	sessionDirectory: string,
	sourcePath: string,
	signal?: AbortSignal,
	executable?: string,
) {
	signal?.throwIfAborted();
	const root = join(sessionDirectory, "scratch", "artifacts");
	const entry = isAbsolute(sourcePath) ? relative(root, sourcePath) : sourcePath;
	if (!ENTRY.test(entry)) throw new Error("NSH sourcePath must name one file in session scratch/artifacts");
	if (process.platform === "darwin") {
		const value = await callArtifactHost({ action: "capture", sessionDirectory, entry }, signal, executable);
		if (!value || typeof value !== "object" || !("source" in value) || typeof value.source !== "string")
			throw new Error("Invalid artifact capture response");
		return { source: value.source, entry, nsh: nshSource(value.source, entry) };
	}
	return withDirectory(sessionDirectory, false, async (dir) => {
		signal?.throwIfAborted();
		const file = await open(child(dir, entry), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const before = await file.stat({ bigint: true });
			if (!before.isFile() || before.nlink !== 1n) throw new Error("Unsafe NSH source file");
			if (before.size > BigInt(NSH_SOURCE_BYTES)) throw new Error("NSH source exceeds 512 KiB");
			const bytes = Buffer.alloc(Number(before.size) + 1);
			let length = 0;
			while (length < bytes.length) {
				signal?.throwIfAborted();
				const result = await file.read(bytes, length, bytes.length - length, length);
				if (!result.bytesRead) break;
				length += result.bytesRead;
			}
			const after = await file.stat({ bigint: true });
			if (BigInt(length) !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs)
				throw new Error("NSH source changed during capture");
			signal?.throwIfAborted();
			// ignoreBOM preserves an authored BOM as part of the immutable source.
			const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
			return { source, entry, nsh: nshSource(source, entry) };
		} finally {
			await file.close();
		}
	});
}
