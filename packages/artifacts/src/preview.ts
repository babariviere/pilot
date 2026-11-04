/** Compatibility boundary for old callers. No browser or native-code preview host remains. */
import type { ArtifactWrite } from "@pilot/protocol";
import { assertArtifactWriteKind } from "./render.ts";

export async function previewArtifact(
	write: ArtifactWrite,
	options: { width?: number; height?: number; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<never> {
	assertArtifactWriteKind(write.kind);
	options.signal?.throwIfAborted();
	throw new Error("Artifact preview is unavailable. Publish images or native visuals without preview");
}
