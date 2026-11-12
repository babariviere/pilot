// Inert wire types only. No Node or SDK runtime graph in the NSH sandbox.
import type { VerificationSubject } from "./deliveryContract";

export interface ArtifactSelection {
	subject: VerificationSubject;
	targetId: string;
	deliveryId: string;
	ownerSessionId: string | null;
	sourceSessionId: string;
	artifactId: string;
	revision: number;
}
export interface CapturedArtifact {
	version: 1;
	reference: ArtifactSelection;
	metadata: { title: string; kind: "html" | "react" | "image" | "swiftui" | "shader" | "visual" };
	rendering: "unsupported";
	content:
		| { state: "text"; source: string; containerSha256: string; containerBytes: number }
		| { state: "unavailable"; reason: "missing" | "oversize" | "redacted" | "unsupported" | "invalid" };
}
