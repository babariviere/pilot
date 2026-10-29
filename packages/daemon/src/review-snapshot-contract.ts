/** Internal, host-authorized comparisons. Never accept host paths or infer exact task ownership. */
import {
	changeIdPattern,
	commitIdPattern,
	exact,
	identifier,
	type JjOwnedChange,
	operationIdPattern,
	repositoryIdPattern,
} from "./jj-ownership-contract.ts";

export const REVIEW_SNAPSHOT_LIMITS = Object.freeze({
	paths: 4096,
	blobBytes: 2 * 1024 * 1024,
	bytes: 32 * 1024 * 1024,
	diffBytes: 4 * 1024 * 1024,
	inventoryBytes: 2 * 1024 * 1024,
	durationMs: 60_000,
	storeBytes: 512 * 1024 * 1024,
	requests: 10_000,
});
export type ReviewSide = "before" | "after";
export interface ReviewRevision {
	changeId: string;
	commitId: string;
}
/** Comparison coverage, not selected text lines or a jj line-of-work alias. */
export type ReviewScope = { kind: "layer" } | { kind: "stack" };
export interface ReviewCaptureRequest {
	requestId: string;
	repositoryId: string;
	changeId: string;
	/** Exact read-only jj operation, not a request to advance/snapshot the working copy. */
	operationId: string;
	base: ReviewRevision;
	head: ReviewRevision;
	scope: ReviewScope;
	source: "committed" | "working-copy";
}
export interface ReviewSourceEntry {
	path: string;
	mode: string;
	gitOid: string;
	state: "text" | "binary" | "unavailable";
	sha256: string | null;
	bytes: number | null;
	reason?: "blob-limit" | "total-limit" | "object-unavailable" | "symlink" | "submodule";
}
export interface ReviewChange {
	status: string;
	beforePath: string | null;
	afterPath: string | null;
	beforeMode: string;
	afterMode: string;
	beforeOid: string;
	afterOid: string;
}
export interface ReviewSnapshotManifest {
	version: 1;
	request: ReviewCaptureRequest;
	/** Frozen at admission. A later collision/reassignment does not rewrite this observation. */
	provenance: { capturedAt: number; ledger: JjOwnedChange; taskAttribution: "unknown" };
	status: "complete" | "partial" | "unavailable";
	omissions: string[];
	/** Full source inventories and patch for this pair. View/annotation filters are separate. */
	before: ReviewSourceEntry[];
	after: ReviewSourceEntry[];
	changes: ReviewChange[];
	trees: { before: string; after: string } | null;
	diff: { sha256: string; bytes: number } | null;
}
export interface ReviewSnapshot {
	snapshotId: string;
	manifest: ReviewSnapshotManifest;
}
export interface ReviewSourceRef {
	snapshotId: string;
	side: ReviewSide;
	path: string;
	sha256: string;
}

export function reviewPath(path: unknown): asserts path is string {
	if (
		typeof path !== "string" ||
		Buffer.byteLength(path) > 400 ||
		/[\x00-\x1f\x7f\\:]/.test(path) ||
		path.split("/").length > 64 ||
		path.split("/").some((p) => !p || p === "." || p === ".." || [".git", ".jj"].includes(p.toLowerCase()))
	)
		throw new Error("Unsafe review source path");
}

/** Return a fixed-order copy: identity never depends on caller object-key insertion order. */
export function captureRequest(input: unknown): ReviewCaptureRequest {
	exact(input, ["requestId", "repositoryId", "changeId", "operationId", "base", "head", "scope", "source"]);
	identifier(input.requestId, /^[a-zA-Z0-9_-]{1,128}$/);
	identifier(input.repositoryId, repositoryIdPattern);
	identifier(input.changeId, changeIdPattern);
	identifier(input.operationId, operationIdPattern);
	const revision = (r: unknown): ReviewRevision => {
		exact(r, ["changeId", "commitId"]);
		identifier(r.changeId, changeIdPattern);
		identifier(r.commitId, commitIdPattern);
		return { changeId: r.changeId, commitId: r.commitId };
	};
	const base = revision(input.base),
		head = revision(input.head);
	if (head.changeId !== input.changeId) throw new Error("Review head belongs to another change");
	const scope = input.scope as ReviewScope;
	if (scope?.kind === "layer" || scope?.kind === "stack") exact(scope, ["kind"]);
	else throw new Error("Invalid review scope");
	if (input.source !== "committed" && input.source !== "working-copy") throw new Error("Invalid review source");
	return {
		requestId: input.requestId,
		repositoryId: input.repositoryId,
		changeId: input.changeId,
		operationId: input.operationId,
		base,
		head,
		scope: { kind: scope.kind },
		source: input.source,
	};
}
