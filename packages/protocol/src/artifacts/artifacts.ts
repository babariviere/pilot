export type ArtifactKind = "image" | "nsh";

/** GET /api/artifacts/:id resolves an unpinned artifact link to its owning session and latest metadata. */
export interface ArtifactSummary {
	id: string;
	sessionId: string;
	projectId?: string;
	title: string;
	kind: ArtifactKind;
	revision: number;
	createdAt: number;
	updatedAt: number;
}

/** Source is editable code or an embedded image data URL; html is the prepared, sandboxed preview. */
export interface ArtifactRevision extends ArtifactSummary {
	source: string;
	html: string;
	/** Captured single-file NSH source. This metadata grants no execution capability. */
	nsh?: ArtifactNsh;
}

export interface ArtifactNsh {
	api: 1;
	/** Write-time compiler provenance, not a current runtime requirement. */
	runtime: string;
	entry: string;
	sourceSha256: string;
	sourceBytes: number;
	/** Historical metadata only. Preview availability belongs to the app. */
	rendering?: "unsupported";
}

export interface ArtifactWrite {
	title: string;
	kind: ArtifactKind;
	source: string;
	/** Host-captured basename for NSH provenance. Source bytes remain in source. */
	entry?: string;
}

/** Saved in a tool result, pinning the chat preview to its original revision. */
export interface ArtifactReference {
	id: string;
	sessionId: string;
	title: string;
	revision: number;
}

/**
 * Optional `data.image` of a `pilot.artifact` transcript entry, beside `data.artifact`. Upright pixel size (EXIF
 * orientation applied) read from the committed revision's PNG, JPEG or GIF header at publication. Clients may use it
 * only to reserve layout before reading the revision; the revision itself stays authoritative. Older entries omit it.
 */
export interface ArtifactImageSize {
	mimeType: "image/png" | "image/jpeg" | "image/gif";
	width: number;
	height: number;
}
