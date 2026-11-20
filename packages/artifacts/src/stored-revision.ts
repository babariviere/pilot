/** Passive host reads. Original numbered JSON bytes are not decoded source or a rendered document. */
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { ArtifactRevision, ArtifactSummary } from "@pilot/protocol";
import { nshSource } from "./nsh-source.ts";
import { isArtifactKind } from "./render.ts";

export const STORED_REVISION_LIMITS = Object.freeze({ containerBytes: 1024 * 1024, pointerBytes: 4096 });
export interface StoredArtifactRevision {
	bytes: Uint8Array;
	artifact: ArtifactRevision;
}
export class ArtifactNotFound extends Error {}

/** Only active metadata is exposed. Old files may contain retired fields. */
export function artifactSummary(value: ArtifactSummary): ArtifactSummary {
	const { id, sessionId, projectId, title, kind, revision, createdAt, updatedAt } = value;
	return {
		id,
		sessionId,
		...(projectId === undefined ? {} : { projectId }),
		title,
		kind,
		revision,
		createdAt,
		updatedAt,
	};
}

export class StoredArtifactTooLarge extends Error {
	constructor() {
		super("Unsupported stored artifact size");
	}
}

/** Bound reads before allocation, decoding or JSON hydration. Never follow a final symlink. */
export async function readStoredFile(path: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
	signal?.throwIfAborted();
	const before = await lstat(path);
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const info = await file.stat();
		if (!info.isFile() || before.isSymbolicLink() || before.dev !== info.dev || before.ino !== info.ino)
			throw new Error("Unsafe stored artifact file");
		if (info.size > maxBytes) throw new StoredArtifactTooLarge();
		const bytes = Buffer.alloc(info.size + 1);
		let length = 0;
		while (length < bytes.length) {
			signal?.throwIfAborted();
			const read = await file.read(bytes, length, bytes.length - length, length);
			if (!read.bytesRead) break;
			length += read.bytesRead;
		}
		const after = await file.stat();
		const current = await lstat(path);
		if (
			length !== info.size ||
			after.mtimeMs !== info.mtimeMs ||
			after.ctimeMs !== info.ctimeMs ||
			current.dev !== info.dev ||
			current.ino !== info.ino
		)
			throw new Error("Stored artifact changed during read");
		signal?.throwIfAborted();
		return bytes.subarray(0, length);
	} finally {
		await file.close();
	}
}

/** Derivation only. The returned fields are NOT original submission bytes. The container stays exact. */
export function parseStoredArtifactRevision(
	bytes: Uint8Array,
	expected: { id: string; revision: number; sessionId: string; projectId?: string },
): StoredArtifactRevision {
	if (bytes.byteLength > STORED_REVISION_LIMITS.containerBytes) throw new StoredArtifactTooLarge();
	let artifact: ArtifactRevision;
	try {
		artifact = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as ArtifactRevision;
	} catch {
		// JSON.parse diagnostics can contain a fragment of the stored source. Never disclose it in errors.
		throw new SyntaxError("Invalid stored artifact JSON or UTF-8");
	}
	if (
		!artifact ||
		artifact.id !== expected.id ||
		artifact.revision !== expected.revision ||
		artifact.sessionId !== expected.sessionId ||
		artifact.projectId !== expected.projectId
	)
		throw new Error("Stored artifact identity or revision mismatch");
	if (!isArtifactKind(artifact.kind)) throw new ArtifactNotFound("Unknown artifact revision");
	if (
		typeof artifact.source !== "string" ||
		typeof artifact.html !== "string" ||
		typeof artifact.title !== "string" ||
		artifact.title.length > 160 ||
		!Number.isSafeInteger(artifact.createdAt) ||
		!Number.isSafeInteger(artifact.updatedAt)
	)
		throw new Error("Unsupported stored artifact representation");
	if (artifact.kind === "nsh") {
		const actual = nshSource(artifact.source, artifact.nsh?.entry ?? "");
		if (
			artifact.nsh?.api !== 1 ||
			typeof artifact.nsh.runtime !== "string" ||
			!artifact.nsh.runtime ||
			artifact.nsh.runtime.length > 256 ||
			artifact.nsh.sourceSha256 !== actual.sourceSha256 ||
			artifact.nsh.sourceBytes !== actual.sourceBytes ||
			artifact.html !== ""
		)
			throw new Error("Unsupported stored NSH representation");
	}
	return {
		bytes,
		artifact: {
			...artifactSummary(artifact),
			source: artifact.source,
			html: artifact.html,
			...(artifact.kind === "nsh" ? { nsh: artifact.nsh } : {}),
		},
	};
}
