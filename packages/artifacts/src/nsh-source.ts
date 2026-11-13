/** Exact, single-file capture. The source runtime never gets these directory handles. */
import { createHash } from "node:crypto";
import { isAbsolute, join, relative } from "node:path";
import type { ArtifactNsh } from "@pilot/protocol";
import { callArtifactHost } from "./nsh-host.ts";

export const NSH_SOURCE_BYTES = 512 * 1024;
export const NSH_RUNTIME = "nsh 0.5.0";
const ENTRY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.tsx$/;

/** Host-selected session directory only, never a tool-supplied root. Does not clear existing files. */
export async function ensureArtifactScratch(sessionDirectory: string, executable?: string): Promise<string> {
	await callArtifactHost({ action: "ensure", sessionDirectory }, undefined, executable);
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
	};
}

/** Compile the captured string before publication. No source is evaluated or saved by this check. */
export async function compileNshSource(source: string, entry: string, signal?: AbortSignal, executable?: string) {
	signal?.throwIfAborted();
	nshSource(source, entry);
	const value = await callArtifactHost({ action: "compile", source, entry }, signal, executable);
	if (value !== null) throw new Error("Invalid artifact compilation response");
	signal?.throwIfAborted();
}

/** Capture and compile once. No relative imports/assets are read; every path component is no-follow. */
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
	const value = await callArtifactHost({ action: "capture", sessionDirectory, entry }, signal, executable);
	if (!value || typeof value !== "object" || !("source" in value) || typeof value.source !== "string")
		throw new Error("Invalid artifact capture response");
	signal?.throwIfAborted();
	return { source: value.source, entry, nsh: nshSource(value.source, entry) };
}
