/** Publication accepts native visuals, images and the existing standalone shader contract only.
 * Historical kinds remain read DTOs; nothing here compiles or executes their source. */
import type { ArtifactLibrary, ArtifactVisual, ArtifactWrite, ArtifactWriteKind } from "@pilot/protocol";
import { MAX_IMAGE_SOURCE_BYTES, validateImageSource } from "./image.ts";
import { assertShaderCompiles, shaderDocumentBody, validateShaderSource } from "./shader.ts";
import { checkVisual, VISUAL_FALLBACK_BODY, validateVisualWrite } from "./visual/index.ts";

export function assertArtifactWriteKind(kind: unknown): asserts kind is ArtifactWriteKind {
	if (kind !== "image" && kind !== "visual" && kind !== "shader")
		throw new Error(
			"Unsupported artifact kind. Supported kinds: image, visual, shader. Legacy HTML, React and SwiftUI artifacts are read-only",
		);
}

export const MAX_SOURCE_BYTES = 512 * 1024;

export function validateArtifact(write: ArtifactWrite): ArtifactWrite & { libraries: ArtifactLibrary[] } {
	if (!write || typeof write !== "object") throw new Error("Expected an artifact document");
	if (typeof write.title !== "string" || !write.title.trim() || write.title.length > 160)
		throw new Error("Artifact title must contain 1-160 characters");
	assertArtifactWriteKind(write.kind);
	const maxBytes = write.kind === "image" ? MAX_IMAGE_SOURCE_BYTES : MAX_SOURCE_BYTES;
	if (typeof write.source !== "string" || !write.source.trim() || Buffer.byteLength(write.source) > maxBytes)
		throw new Error(
			write.kind === "image"
				? "Artifact image exceeds 16 MiB or is empty"
				: "Artifact source must contain 1-512 KiB of visual source or GLSL",
		);
	if (write.kind === "image") validateImageSource(write.source);
	if (write.kind === "shader") validateShaderSource(write.source);
	if (write.kind === "visual") validateVisualWrite(write.source, write.data);
	else if (write.data !== undefined) throw new Error("Only visual artifacts take data");
	if (write.libraries !== undefined && !Array.isArray(write.libraries))
		throw new Error("Artifact libraries must be an array");
	const libraries: ArtifactLibrary[] = [];
	if (write.libraries?.length)
		throw new Error(
			`${write.kind === "image" ? "Image" : write.kind === "visual" ? "Visual" : "Shader"} artifacts do not use libraries`,
		);
	return { ...write, title: write.title.trim(), libraries };
}

export const ARTIFACT_CSP =
	"default-src 'none'; script-src 'unsafe-inline' pilot-artifact:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; media-src data: blob:; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";

export const ARTIFACT_RUNTIME_GUARD = `for (const name of ['RTCPeerConnection','webkitRTCPeerConnection','mozRTCPeerConnection','WebTransport']) { try { Object.defineProperty(globalThis,name,{value:undefined,writable:false,configurable:false}); } catch (_) {} }`;

export async function prepareArtifact(
	input: ArtifactWrite,
	options: { signal?: AbortSignal; id?: string } = {},
): Promise<{ html: string; libraries: ArtifactLibrary[]; visual?: ArtifactVisual }> {
	const write = validateArtifact(input);
	options.signal?.throwIfAborted();
	// Keep existing shader checks; this does not enable shader rendering in Next.
	if (write.kind === "shader") await assertShaderCompiles(write.source, options.signal);
	const visual =
		write.kind === "visual"
			? await checkVisual(
					{ source: write.source, data: validateVisualWrite(write.source, write.data), id: options.id ?? "" },
					{ signal: options.signal },
				)
			: undefined;
	const body =
		write.kind === "shader"
			? shaderDocumentBody(write.source)
			: write.kind === "visual"
				? VISUAL_FALLBACK_BODY
				: `<style>body{margin:0;padding:0;min-height:100vh;display:grid;place-items:center}img{display:block;width:auto;height:auto;max-width:100vw;max-height:100vh;object-fit:contain}</style><img alt="Artifact image" src="${write.source}">`;
	// Retain the prepared-document read contract for existing clients, never raw source markup.
	const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}"><meta http-equiv="x-dns-prefetch-control" content="off"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><script>${ARTIFACT_RUNTIME_GUARD}</script></head><body>${body}</body></html>`;
	if (Buffer.byteLength(html) > 25 * 1024 * 1024) throw new Error("Prepared artifact exceeds 25 MiB");
	return visual ? { html, libraries: [], visual } : { html, libraries: [] };
}
