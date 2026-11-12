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
	content:
		| { state: "text"; source: string; containerSha256: string; containerBytes: number }
		| { state: "unavailable"; reason: "missing" | "oversize" | "redacted" | "unsupported" | "invalid" };
}
