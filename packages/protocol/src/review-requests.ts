import type { NativeReviewComparison } from "./native-review.ts";
import type { ReviewDispositionTarget } from "./workflow-confirmations.ts";

/** Optional attention only. No required-approval authority or gate waiver. */
export type ReviewRequestState = "pending" | "snoozed" | "withdrawn" | "retired" | "replaced";
export interface ReviewRequestSuggestion {
	operationId: string;
	target: ReviewDispositionTarget;
	title: string;
	reason: string;
	replacesRequestId: string | null;
	replacesExpectedRevision: number | null;
}
export interface ReviewRequestTransition {
	operationId: string;
	requestId: string;
	expectedRevision: number;
	reason: string;
}
export interface ReviewRequestRow {
	requestId: string;
	sequence: number;
	state: ReviewRequestState;
	actionability: "waiting" | "ready" | "unknown";
	projectId: string;
	sessionId: string;
	title: string;
	comparison: NativeReviewComparison;
}
/** Source access failed at this read point. No source details or review readiness are disclosed. */
export interface UnavailableReviewRequestRow {
	requestId: string;
	sequence: number;
	state: ReviewRequestState;
	unavailable: true;
}
export interface ReviewRequestPage {
	requests: (ReviewRequestRow | UnavailableReviewRequestRow)[];
	next: number | null;
}
