/** Help is commentary, never an answer, approval, or replacement of binding guidance. */
export type AssistanceSubject =
	| { kind: "question"; sessionId: string; entryId: number }
	| { kind: "proposal" | "binding_decision"; missionId: string; id: string };

export interface AssistanceScope {
	subject: AssistanceSubject;
	projectId: string;
	/** Native question event identity or mission event high-water. Catches edit/revert. */
	eventId: number;
	contentDigest: string;
	/** Current access/membership/configuration identity, supplied by the trusted host. */
	authorityDigest: string;
}

export type ImmutableArtifactReference = {
	kind: "artifact";
	sessionId: string;
	artifactId: string;
	revision: number;
	sha256: string;
};

export type AssistanceOutput =
	| { kind: "simpler" | "context"; text: string }
	| { kind: "question"; question: string; answer: string }
	| { kind: "visual"; explanation: string; artifact: ImmutableArtifactReference };

export interface AssistanceRequest {
	requestId: string;
	scope: AssistanceScope;
	kind: AssistanceOutput["kind"];
	/** Required only for inline questions. Not a reply to the underlying ask. */
	question?: string;
}

export interface AssistanceRecord {
	request: AssistanceRequest;
	state: "entered" | "ready" | "stale" | "failed";
	output?: AssistanceOutput;
}

export type AttentionErrorCode =
	| "invalid"
	| "not_found"
	| "stale"
	| "forbidden"
	| "conflict"
	| "unavailable"
	| "unknown";
export type AttentionResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: { code: AttentionErrorCode; message: string } };

/** Files are pinned bytes, not a mutable filesystem path. The host must verify them again. */
export type HumanActionFile =
	| ImmutableArtifactReference
	| {
			kind: "file";
			uri: string;
			version: string;
			sha256: string;
	  };

export interface HumanActionContent {
	projectId: string;
	sessionId: string;
	missionId: string | null;
	action: string;
	reason: string;
	files: HumanActionFile[];
	destination: { uri: string; targetId: string; version: string };
	completionRequirements: string[];
}

/** Distinct from ask_user, workflow confirmation and external publication status. */
export interface HumanActionRecord {
	id: string;
	revision: number;
	digest: string;
	content: HumanActionContent;
	state: "pending" | "deferred" | "completed" | "cancelled";
	progress: string;
	completion: { operationId: string; report: string; source: "user_report" } | null;
}

export type HumanActionIdentity = Pick<HumanActionRecord, "id" | "revision" | "digest">;
/** Evidence for a dependency consumer, not permission to run or proof of external publication. */
export interface HumanActionCompletion {
	request: HumanActionIdentity;
	completed: HumanActionIdentity;
	operationId: string;
	source: "user_report";
}
export type HumanActionCommand =
	| { kind: "create"; operationId: string; id: string; content: HumanActionContent }
	| { kind: "replace"; operationId: string; expected: HumanActionIdentity; content: HumanActionContent }
	| {
			kind: "progress" | "defer" | "resume" | "cancel";
			operationId: string;
			expected: HumanActionIdentity;
			progress: string;
	  }
	| { kind: "complete"; operationId: string; expected: HumanActionIdentity; report: string };

/** Schedule checks are observations only. Public version lag never proves no upload. */
export interface HumanActionObservation {
	request: HumanActionIdentity;
	state: "submitted" | "review_pending" | "published" | "not_observed" | "unknown";
	source: string;
	observedAt: number;
}
