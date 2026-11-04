/** Internal host API, not an agent tool or a review/acceptance record. */
import type { NativeReviewSnapshot } from "@pilot/protocol";
import type { CallEdge } from "./call-path-contract.ts";
import type { SourceHit } from "./exploration-contract.ts";

export type RetainedSide = "before" | "after";
export interface RetainedCallInput {
	/** Host-selected opaque canonical store identity, never a caller path. */
	storeId: string;
	snapshotId: string;
	request: NativeReviewSnapshot["request"];
	status: "complete" | "partial" | "unavailable";
	before: NativeReviewSnapshot["before"];
	after: NativeReviewSnapshot["after"];
}
export interface RetainedCallRef {
	snapshotId: string;
	side: RetainedSide;
	path: string;
	sha256: string;
}
export interface RetainedSpan extends RetainedCallRef {
	/** Zero-based UTF-16 offsets, one-based line/column, exclusive end. */
	utf16: SourceHit["span"];
	/** Zero-based offsets in the original UTF-8 blob, exclusive end. */
	utf8: { start: number; end: number };
	sha256OfSpan: string;
}
export interface RetainedCallable {
	name: string;
	kind: string;
	declaration: RetainedSpan;
	header: RetainedSpan[];
	body: RetainedSpan | null;
	frameId?: string;
	reason?: string;
}
export interface RetainedCallSite {
	site: RetainedSpan;
	resolution: CallEdge["resolution"];
	provenance: string;
	cycle: boolean;
	target?: { path: string; name: string; kind: string; declaration: RetainedSpan };
	unpairedTarget?: { name: string; kind: string; nameTruncated: boolean; location: RetainedSpan };
	/** A same-path/name/kind target correspondence, not a runtime identity. */
	targetKey?: string;
}
export interface RetainedCallableDelta {
	key: string;
	status: "matched" | "added" | "removed" | "unknown";
	reason?: string;
	before: RetainedCallable[];
	after: RetainedCallable[];
	bodyChanged: boolean | null;
	headerChanged: boolean | null;
	outgoingRelationshipChanged: boolean | null;
	/** Caller-wide coverage loss, not an invented cross-edit site match. */
	lostResolution: boolean;
	edges: { before: RetainedCallSite[]; after: RetainedCallSite[] };
	edgesOmitted?: boolean;
}
export interface RetainedCallCoverage {
	parsed: number;
	unsupported: number;
	omitted: number;
	unresolvedCalls: number;
	ambiguousCalls: number;
	unpairedFrames: number;
	contextCalls: number;
}
export interface RetainedCallResult {
	version: 1;
	mode: "source-inferred-not-runtime";
	engine: string;
	scanPath: string;
	pair: Pick<RetainedCallInput, "storeId" | "snapshotId" | "request">;
	revision: string;
	coverage: Record<RetainedSide, RetainedCallCoverage>;
	budget: { entries: number; bytes: number; records: number; edges: number };
	partial: boolean;
	partialReasons: string[];
	exhaustive: false;
	results: RetainedCallableDelta[];
	page: { offset: number; retained: number; nextOffset: number | null };
}
export interface RetainedCallQuery {
	/** Whole retained inventory scan scope, not a post-analysis filter. */
	path?: string;
	limit?: number;
	offset?: number;
	expectedRevision?: string;
}
export interface RetainedCallProvider {
	input: RetainedCallInput;
	/** Recheck current read permission/custody, never frozen creator provenance alone. */
	authorize(): Promise<void>;
	read(ref: RetainedCallRef, signal: AbortSignal): Promise<Uint8Array>;
}
