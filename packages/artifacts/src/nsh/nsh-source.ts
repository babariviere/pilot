/** Exact, single-file capture. The source runtime never gets these directory handles. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { ArtifactNsh } from "@pilot/protocol";
import { callArtifactHost, NSH_RUNTIME } from "./nsh-host.ts";

export const NSH_SOURCE_BYTES = 512 * 1024;
const ENTRY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.tsx$/;

/** What the publish-time preview run showed (artifact_check.rs). Texts are cut short; counts are complete. */
export interface NshRendered {
	shows: string[];
	texts: number;
	noRoom: string[];
	noRoomCount: number;
	/** Variant switches (Choices options, tabs) pressed once each, and those the time or press limit left. */
	pressed: number;
	unpressed: number;
}

function rendered(value: unknown): NshRendered {
	const r = value as NshRendered | undefined;
	const strings = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === "string");
	if (
		!r ||
		!strings(r.shows) ||
		!strings(r.noRoom) ||
		!Number.isSafeInteger(r.texts) ||
		!Number.isSafeInteger(r.noRoomCount) ||
		!Number.isSafeInteger(r.pressed) ||
		!Number.isSafeInteger(r.unpressed)
	)
		throw new Error("Invalid artifact capture response");
	return {
		shows: r.shows,
		texts: r.texts,
		noRoom: r.noRoom,
		noRoomCount: r.noRoomCount,
		pressed: r.pressed,
		unpressed: r.unpressed,
	};
}

/** Host-selected session directory only, never a tool-supplied root. Does not clear existing files. */
export async function ensureArtifactScratch(sessionDirectory: string, executable?: string): Promise<string> {
	await callArtifactHost({ action: "ensure", sessionDirectory }, undefined, executable);
	return join(sessionDirectory, "scratch", "artifacts");
}

function scratchEntry(sessionDirectory: string, sourcePath: string): { root: string; entry: string } {
	const root = join(sessionDirectory, "scratch", "artifacts");
	const entry = isAbsolute(sourcePath) ? relative(root, sourcePath) : sourcePath;
	if (!ENTRY.test(entry)) throw new Error("NSH sourcePath must name one file in session scratch/artifacts");
	return { root, entry };
}

/** Ask has no write tool, so the artifact tool writes one exact .tsx into the host-created scratch folder.
 * Nothing else is writable: one basename, no links followed, an existing plain file or a new one. */
export async function writeNshScratchSource(
	sessionDirectory: string,
	sourcePath: string,
	source: string,
	signal?: AbortSignal,
): Promise<string> {
	signal?.throwIfAborted();
	const { root, entry } = scratchEntry(sessionDirectory, sourcePath);
	nshSource(source, entry);
	if ((await realpath(root)) !== join(await realpath(sessionDirectory), "scratch", "artifacts"))
		throw new Error("Session scratch/artifacts must be a plain folder");
	signal?.throwIfAborted();
	const file = await open(join(root, entry), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
	try {
		const info = await file.stat();
		if (!info.isFile() || info.nlink !== 1) throw new Error("NSH sourcePath must be a plain file");
		await file.truncate(0);
		await file.write(source, 0, "utf8");
	} finally {
		await file.close();
	}
	return entry;
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

/** Capture, compile and run the preview once headless, as Day would. No relative imports/assets are read; every
 * path component is no-follow. A preview that fails to start or render rejects with its error. */
export async function captureNshSource(
	sessionDirectory: string,
	sourcePath: string,
	signal?: AbortSignal,
	executable?: string,
) {
	signal?.throwIfAborted();
	const { entry } = scratchEntry(sessionDirectory, sourcePath);
	const value = await callArtifactHost({ action: "capture", sessionDirectory, entry }, signal, executable);
	if (!value || typeof value !== "object" || !("source" in value) || typeof value.source !== "string")
		throw new Error("Invalid artifact capture response");
	signal?.throwIfAborted();
	return {
		source: value.source,
		entry,
		nsh: nshSource(value.source, entry),
		rendered: rendered("rendered" in value ? value.rendered : undefined),
	};
}
