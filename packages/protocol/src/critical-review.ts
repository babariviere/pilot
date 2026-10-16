/** Critical code reviews. Unrelated to /api/reviews (chat-result read marks).
 * Host-owned records only; no production start/approve endpoint is enabled yet.
 */
export type CriticalReviewEffort = "low" | "medium" | "high" | "session";
export type CriticalReviewState =
	| "queued"
	| "capturing"
	| "classifying"
	| "reviewing"
	| "complete"
	| "incomplete"
	| "cancelled"
	| "interrupted";
export interface ReviewRecordBase {
	schemaVersion: 1;
	id: string;
	projectId: string;
	hostId: string;
	/** Opaque source identities for linked erasure, never live paths. */
	sourceIds: string[];
	createdAt: number;
}
export interface CriticalReviewTarget extends ReviewRecordBase {
	kind: "target";
	snapshot:
		| {
				kind: "session";
				sessionId: string;
				attemptId: string;
				lineageId: string;
				boundary: number;
				treeDigest: string;
		  }
		| { kind: "pull_request"; repositoryId: string; number: number; head: string; base: string; mergeBase: string };
}
export interface ReviewCitation {
	manifestId: string;
	blobId: string;
	start: number;
	end: number;
}
export interface ReviewEvidenceEntry {
	blobId: string;
	sha256: string;
	bytes: number;
	/** Sanitized display label, not a filesystem capability. */
	label: string;
	sourceId: string;
	category: "source" | "transcript" | "discussion" | "guidance";
}
export interface ReviewOmission {
	/** Opaque selection ID. Secret filenames and values are not retained. */
	selectionId: string;
	reason: "unselected" | "secret" | "binary" | "unsafe" | "missing" | "quota" | "redacted";
}
export interface CriticalReviewEvidence extends ReviewRecordBase {
	kind: "evidence";
	sealed: true;
	sha256: string;
	entries: ReviewEvidenceEntry[];
	omissions: ReviewOmission[];
	complete: boolean;
}
export interface CriticalReviewContext extends ReviewRecordBase {
	kind: "context";
	policyVersion: string;
	challenge: "balanced" | "regressions" | "approach" | "evidence" | "failure_modes" | "project_fit" | "security";
	sources: {
		citation: ReviewCitation;
		basis: "requirement" | "preference" | "convention" | "proposal";
		approvalId?: string;
	}[];
	missing: string[];
	conflicts: string[];
}
export interface CriticalReviewRun extends ReviewRecordBase {
	kind: "run";
	targetId: string;
	evidenceId: string;
	contextId: string;
	/** New records retain history. A recheck never retargets an old run. */
	previousRunId?: string;
	state: CriticalReviewState;
	effort: CriticalReviewEffort;
	modelId: string;
	policyVersion: string;
	limits: string[];
}
export interface ReviewAllowance {
	/** Integer micro-US dollars. Tokens include thinking and repeated/cached input. */
	moneyMicros: number;
	inputTokens: number;
	generatedTokens: number;
	durationMs: number;
}
export interface CriticalReviewApproval extends ReviewRecordBase {
	kind: "approval";
	ownerId: string;
	runId: string;
	targetId: string;
	evidenceId: string;
	/** Only the trusted host action may create this, never message text. */
	action: "app_allowance";
	providerId: string;
	modelId: string;
	billing: "api" | "subscription";
	allowance: ReviewAllowance;
	expiresAt: number;
}
export interface CriticalReviewReservation extends ReviewRecordBase {
	kind: "reservation";
	runId: string;
	approvalId: string;
	callId: string;
	rateId: string;
	phase: "classifier" | "analysis" | "final" | "follow_up";
	reserved: ReviewAllowance;
}
export interface CriticalReviewFinding extends ReviewRecordBase {
	kind: "finding";
	runId: string;
	severity: "critical" | "high" | "medium" | "low";
	confidence: "high" | "medium";
	title: string;
	trigger: string;
	expected: string;
	actual: string;
	consequence: string;
	evidence: ReviewCitation[];
	counterevidence: ReviewCitation[];
	basis: string;
	verification: "new" | "remaining" | "resolved" | "changed" | "not_reverified";
}
export interface CriticalReviewDisposition extends ReviewRecordBase {
	kind: "disposition";
	findingId: string;
	ownerId: string;
	value: "accepted" | "dismissed" | "questioned" | "reopened";
}
export interface CriticalReviewRecords {
	target: CriticalReviewTarget;
	evidence: CriticalReviewEvidence;
	context: CriticalReviewContext;
	run: CriticalReviewRun;
	finding: CriticalReviewFinding;
	approval: CriticalReviewApproval;
	reservation: CriticalReviewReservation;
	disposition: CriticalReviewDisposition;
}
export type CriticalReviewRecord = CriticalReviewRecords[keyof CriticalReviewRecords];
