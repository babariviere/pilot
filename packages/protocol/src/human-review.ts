import type { ReviewDispositionTarget } from "./workflow-confirmations.ts";

/** Original retained bytes and source lines, never a live-file location. */
export interface HumanReviewLineRange {
	side: "before" | "after";
	path: string;
	blobSha256: string;
	startLine: number;
	endLine: number;
	excerptSha256: string;
	beforeContextSha256: string;
	afterContextSha256: string;
}
export type HumanReviewAnchor =
	| { kind: "summary"; snapshotId: string }
	| { kind: "file"; snapshotId: string; side: "before" | "after"; path: string; blobSha256: string | null }
	| { kind: "lines"; snapshotId: string; ranges: HumanReviewLineRange[] };
export interface HumanReviewAnnotation {
	id: string;
	body: string;
	anchor: HumanReviewAnchor;
	/** Explicit edit. The original record, text and anchor are never changed. */
	supersedes: string | null;
}
export interface HumanReviewFeedback {
	draft: { id: string; revision: number } | null;
	annotations: HumanReviewAnnotation[];
	findings: { recordId: string; findingId: string; disposition: "concern" | "not_issue" | "missed"; reason: string }[];
	resolveAnnotationIds: string[];
	supersedes: { recordId: string; reason: string } | null;
}
export interface HumanReviewContent {
	targets: ReviewDispositionTarget[];
	disposition: "comment" | "request_changes" | "approve";
	body: string;
	feedback?: HumanReviewFeedback;
}
export interface HumanReviewDraft {
	id: string;
	revision: number;
	content: HumanReviewContent;
	updatedAt: number;
	/** A draft is private and never dispatched. Submission has its own native operation. */
	authorOrigin: "native-user-draft";
}
