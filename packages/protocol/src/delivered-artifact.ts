import type { ArtifactKind } from "./index.ts";
import type { VerificationSubject } from "./user-verification.ts";

/** Exact displayed output selection. This is not a path, revision catalogue or execution intent. */
export interface DeliveredArtifactRequest {
	subject: VerificationSubject;
	targetId: string;
	deliveryId: string;
	ownerSessionId: string | null;
	sourceSessionId: string;
	artifactId: string;
	revision: number;
}

/** Text is decoded from the numbered saved container, never rendered or evaluated. */
export interface DeliveredArtifact {
	version: 1;
	reference: DeliveredArtifactRequest;
	metadata: { title: string; kind: ArtifactKind };
	rendering: "unsupported";
	content: SavedArtifactContent;
}

export type SavedArtifactContent =
	| { state: "text"; source: string; containerSha256: string; containerBytes: number }
	| { state: "unavailable"; reason: "missing" | "oversize" | "redacted" | "unsupported" | "invalid" };

/**
 * One exact saved revision of an artifact made by a chat in the project.
 * GET /api/projects/:projectId/artifacts/:sourceSessionId/:artifactId?revision=N
 */
export interface ProjectArtifactRequest {
	projectId: string;
	sourceSessionId: string;
	artifactId: string;
	revision: number;
}

/** The same inert text answer as a delivered artifact, for the project's own chats. */
export interface ProjectArtifact {
	version: 1;
	reference: ProjectArtifactRequest;
	metadata: { title: string; kind: ArtifactKind };
	rendering: "unsupported";
	content: SavedArtifactContent;
}
