/** Prepare image and NSH revisions. */
import type { ArtifactKind, ArtifactNsh, ArtifactWrite } from "@pilot/protocol";
import { MAX_IMAGE_SOURCE_BYTES, validateImageSource } from "../images/image.ts";
import { NSH_SOURCE_BYTES, nshSource } from "./nsh-source.ts";

export function isArtifactKind(kind: unknown): kind is ArtifactKind {
	return kind === "image" || kind === "nsh";
}

export function assertArtifactWriteKind(kind: unknown): asserts kind is ArtifactKind {
	if (!isArtifactKind(kind)) throw new Error("Supported artifact kinds: image, nsh");
}

type PreparedArtifact = { html: string; nsh?: ArtifactNsh };

export function validateArtifact(input: ArtifactWrite): ArtifactWrite {
	return validateWrite(input).write;
}

function validateWrite(input: ArtifactWrite): { write: ArtifactWrite; nsh?: ArtifactNsh } {
	if (!input || typeof input !== "object") throw new Error("Expected an artifact document");
	const write = { ...input };
	if (typeof write.title !== "string" || !write.title.trim() || write.title.length > 160)
		throw new Error("Artifact title must contain 1-160 characters");
	assertArtifactWriteKind(write.kind);
	const maxBytes = write.kind === "image" ? MAX_IMAGE_SOURCE_BYTES : NSH_SOURCE_BYTES;
	if (typeof write.source !== "string" || !write.source.trim() || Buffer.byteLength(write.source) > maxBytes)
		throw new Error(
			write.kind === "image" ? "Artifact image exceeds 16 MiB or is empty" : "NSH source must contain 1-512 KiB",
		);
	if (write.kind === "image") validateImageSource(write.source);
	const nsh = write.kind === "nsh" ? nshSource(write.source, write.entry ?? "") : undefined;
	if (write.kind !== "nsh" && write.entry !== undefined) throw new Error("Only NSH artifacts take entry");
	const { kind, source, entry } = write;
	return { write: { title: write.title.trim(), kind, source, ...(entry !== undefined ? { entry } : {}) }, nsh };
}

const IMAGE_CSP =
	"default-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'";

export async function prepareArtifact(
	input: ArtifactWrite,
	options: { signal?: AbortSignal } = {},
): Promise<PreparedArtifact> {
	return (await prepareArtifactWrite(input, options)).prepared;
}

/** One publication path; the store uses the same normalized write that preparation checked. */
export async function prepareArtifactWrite(
	input: ArtifactWrite,
	options: { signal?: AbortSignal } = {},
): Promise<{ write: ArtifactWrite; prepared: PreparedArtifact }> {
	const { write, nsh } = validateWrite(input);
	options.signal?.throwIfAborted();
	// Saving source is independent of compilation/execution. Never synthesize HTML from authored TSX.
	if (nsh) return { write, prepared: { html: "", nsh } };
	const body = `<style>body{margin:0;padding:0;min-height:100vh;display:grid;place-items:center}img{display:block;width:auto;height:auto;max-width:100vw;max-height:100vh;object-fit:contain}</style><img alt="Artifact image" src="${write.source}">`;
	// Retain the prepared-document read contract for existing clients, never raw source markup.
	const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${IMAGE_CSP}"><meta http-equiv="x-dns-prefetch-control" content="off"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${body}</body></html>`;
	if (Buffer.byteLength(html) > 25 * 1024 * 1024) throw new Error("Prepared artifact exceeds 25 MiB");
	return { write, prepared: { html } };
}
