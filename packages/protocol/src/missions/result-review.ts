import type { VerificationSubject } from "../operations/verification-subject.ts";

/** Private result discussion. A line anchor always names original saved bytes. */
export type ResultAnchor =
	| { kind: "general" }
	| { kind: "section"; section: "changes" | "checks" | "risks" | "remaining" }
	| {
			kind: "lines";
			snapshotId: string;
			side: "before" | "after";
			path: string;
			start: number;
			end: number;
			blobSha256: string;
			excerpt: string;
	  };
export interface ResultReviewEdit {
	operationId: string;
	deliveryId: string;
	expectedRevision: number;
	kind: "comment" | "note" | "later" | "select";
	body: string;
	anchor: ResultAnchor;
}
export interface ResultReviewEntry extends ResultReviewEdit {
	subject: VerificationSubject;
	revision: number;
	ownerSessionId: string | null;
	at: number;
}
/** Exact terminal refusal of a well-formed save. It never changes review content or its revision. */
export interface ResultReviewRejection extends ResultReviewEdit {
	subject: VerificationSubject;
	state: "rejected";
	reason: string;
}
export type ResultReviewReceipt = ResultReviewEntry | ResultReviewRejection;
export interface ResultDiff {
	snapshotId: string;
	base: string;
	head: string;
	status: string;
	omissions: string[];
	files: {
		path: string;
		status: string;
		before: { path: string; sha256: string; text: string } | null;
		after: { path: string; sha256: string; text: string } | null;
		reason: string;
	}[];
}
export interface ResultReviewPage {
	subject: VerificationSubject;
	deliveryId: string;
	revision: number;
	entries: ResultReviewEntry[];
	/** Only explicitly linked retained comparisons, never an inferred latest workspace. */
	snapshots: string[];
	nextBefore?: number | null;
	personalNote?: string;
}
