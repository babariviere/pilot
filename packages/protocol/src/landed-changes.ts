import type { HumanReviewRecord } from "./human-review.ts";
import type { NativeReviewCaptureStatus, NativeReviewComparison, NativeReviewSnapshot } from "./native-review.ts";
import type { ReviewRequestState } from "./review-requests.ts";
import type { ReviewDispositionTarget } from "./workflow-confirmations.ts";

/** Historical host observation, not a push receipt, approval, or current branch guarantee. */
export type ChangeLandingResult =
	| { status: "unknown" | "stale"; reason: string }
	| {
			status: "observed" | "not-contained";
			observedAt: number;
			repository: string;
			defaultRef: string;
			targetCommitId: string;
			integratedCommitId: string;
			producer:
				| { kind: "default-branch-containment" }
				| { kind: "pull-request"; url: string; headCommitId: string; baseCommitId: string };
	  };
export interface ChangeLandingRecord {
	observationId: string;
	sequence: number;
	target: ReviewDispositionTarget;
	recordedAt: number;
	result: ChangeLandingResult;
}
export interface ChangeAttention {
	requestId: string;
	revision: number;
	state: ReviewRequestState;
	operationId: string;
	updatedAt: number;
}
export type ChangeReportedCommits =
	| { status: "unavailable"; reason: string }
	| {
			status: "reported";
			claims: { taskId: string; commit: string; recordedAt: number }[];
	  };
export interface LandedChangeRow {
	comparison: NativeReviewComparison;
	target: ReviewDispositionTarget;
	/** Latest attempt. Null means unobserved, not never landed. */
	landing: ChangeLandingRecord | null;
	/** Last positive historical observation survives later unavailable/negative attempts. */
	observedLanding: ChangeLandingRecord | null;
}
export interface LandedChangesPage {
	version: 1;
	/** Only enrolled, retained comparisons. Never a complete landed-work inventory. */
	scope: "retained-comparisons-only";
	status: "available" | "unavailable";
	reason?: string;
	capture?: NativeReviewCaptureStatus;
	changes: (LandedChangeRow | { snapshotId: string; sequence: number; unavailable: true })[];
	next: number | null;
}
export interface LandedChangeHistory {
	version: 1;
	comparison: NativeReviewComparison;
	snapshot: NativeReviewSnapshot;
	target: ReviewDispositionTarget;
	reported: ChangeReportedCommits;
	landing: { records: ChangeLandingRecord[]; next: number | null };
	reviews: { records: { sequence: number; record: HumanReviewRecord }[]; next: number | null };
	attention: { records: ChangeAttention[]; complete: boolean };
	/** Historical review records never authorize approval on reopen. */
	approval: "not-evaluated";
	acceptance: "not-evaluated";
}
