import type { HumanReviewFeedback } from "./human-review.ts";
import type { MissionBrief, MissionDecision } from "./index.ts";
import type { InterviewAgreementBinding } from "./mission-interview.ts";

export type WorkflowOperationKind =
	| "workflow-approve"
	| "workflow-revoke"
	| "review-consent"
	| "review-consent-revoke"
	| "review-disposition";

/** Host-configured, non-secret disclosure. No automatic provider/model/account fallback. */
export interface ReviewerConsentDisclosure {
	configurationRevision: string;
	provider: string;
	model: string;
	account: string;
	terms: string;
	dataScope: "exact-local-research-plan-revisions";
	retention: "raw-30-days-records-90-days-active-pins-excepted";
	expiresAt: number;
	missionLimitMicros: 20000000;
	logicalTaskLimitMicros: 4000000;
	cumulativeAcrossRechecks: true;
	refillOnReplacement: false;
	paidFallback: false;
}

/** GET prepares only. Confirmation must send this complete immutable package. */
export interface WorkflowConfirmationPackage {
	version: 1;
	purpose: Exclude<WorkflowOperationKind, "review-disposition">;
	missionId: string;
	projectId: string;
	coordinatorSessionId: string;
	brief: MissionBrief;
	decisions: MissionDecision[];
	/** Conservative monotonic event fence, including owner/coordinator A->B->A. */
	eventId: number;
	contextFence: {
		briefRevision: number;
		decisionEventId: number;
		artifactEventId: number;
		memberEventId: number;
		coordinatorEventId: number;
	};
	configurationDigest: string;
	/** Present only for creation-enrolled full-list interviews. No legacy adoption. */
	agreement?: InterviewAgreementBinding;
	policy: {
		scrutiny: "Balanced";
		requiredChecks: "must-pass";
		review: { T1: "targeted-independent"; T2: "full-independent"; T3: "specialist-and-human" };
		excludedPowers: ["review-spend", "human-review", "integrate", "cleanup", "subdelegate"];
		expiry: "mission-end-or-revocation";
	};
	/** Fixed implementation scope. Saving does not activate admission/delivery gates. */
	delegation: {
		coordinatorSessionId: string;
		actions: ["plan", "classify", "assign", "assess", "accept-outcome"];
		expansion: "fresh-user-confirmation";
		protectedDecisions: "user-only";
		force: false;
	};
	workflowApprovalOperationId: string | null;
	disclosure: ReviewerConsentDisclosure | null;
	digest: string;
}
export interface WorkflowConfirmationPayload {
	purpose: WorkflowConfirmationPackage["purpose"];
	package: WorkflowConfirmationPackage;
	expectedPriorOperationId: string | null;
}
export interface PreparedWorkflowConfirmation {
	package: WorkflowConfirmationPackage;
	expectedPriorOperationId: string | null;
}

/** Exact selected comparison, never a whole-chat or future-revision approval. */
export interface ReviewDispositionTarget {
	projectId: string;
	sessionId: string;
	snapshotId: string;
	repositoryId: string;
	changeId: string;
	baseCommitId: string;
	headCommitId: string;
	layer: "layer" | "stack";
	diffSha256: string;
	comparisonDigest: string;
}
export interface ReviewDispositionPayload {
	purpose: "review-disposition";
	targets: ReviewDispositionTarget[];
	disposition: "comment" | "request_changes" | "approve";
	body: string;
	expectedPriorRecordId: string | null;
	/** Exact user feedback, included in the immutable confirmation package. */
	feedback?: HumanReviewFeedback;
	/** Host producer's monotonic request/configuration/authority fence. */
	packageDigest: string;
}
