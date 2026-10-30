/** Internal, host-authorized comparisons. Never accept host paths or infer exact task ownership. */
import {
	bindingRecord,
	changeIdPattern,
	commitIdPattern,
	creationRecord,
	exact,
	identifier,
	type JjOwnedChange,
	operationIdPattern,
	repositoryIdPattern,
	revisionRecord,
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

/** Validate retained records before exposing them through the read transport. */
export function snapshotManifest(value: unknown): asserts value is ReviewSnapshotManifest {
	exact(value, [
		"version",
		"request",
		"provenance",
		"status",
		"omissions",
		"before",
		"after",
		"changes",
		"trees",
		"diff",
	]);
	if (value.version !== 1 || !["complete", "partial", "unavailable"].includes(String(value.status)))
		throw new Error("Unsupported review manifest");
	const request = captureRequest(value.request);
	exact(value.provenance, ["capturedAt", "ledger", "taskAttribution"]);
	const p = value.provenance;
	if (!Number.isSafeInteger(p.capturedAt) || Number(p.capturedAt) < 0 || p.taskAttribution !== "unknown")
		throw new Error("Invalid retained provenance");
	exact(p.ledger, ["repositoryId", "changeId", "discovery", "ownership", "current"]);
	const l = p.ledger;
	if (
		l.repositoryId !== request.repositoryId ||
		l.changeId !== request.changeId ||
		!["complete", "unknown"].includes(String(l.discovery))
	)
		throw new Error("Cross-subject manifest");
	exact(l.ownership, ["status", "binding", "creation", "taskAttribution"]);
	const o = l.ownership;
	if (o.status !== "owned" || o.taskAttribution !== "unknown") throw new Error("Unknown retained custody");
	bindingRecord(o.binding);
	creationRecord(o.creation);
	if (o.binding.repositoryId !== request.repositoryId || o.creation.changeId !== request.changeId)
		throw new Error("Cross-repository provenance");
	const c = l.current as JjOwnedChange["current"];
	exact(c, [
		"status",
		"revisions",
		...(c?.operationId === undefined ? [] : ["operationId"]),
		...(c?.observedAt === undefined ? [] : ["observedAt"]),
	]);
	if (
		!["observed", "divergent", "absent", "unknown"].includes(c.status) ||
		!Array.isArray(c.revisions) ||
		c.revisions.length > 4096
	)
		throw new Error("Invalid provenance observation");
	if (c.operationId !== undefined) identifier(c.operationId, operationIdPattern);
	if (c.observedAt !== undefined && (!Number.isSafeInteger(c.observedAt) || c.observedAt < 0))
		throw new Error("Invalid observation time");
	for (const r of c.revisions) {
		revisionRecord(r);
		if (r.changeId !== request.changeId) throw new Error("Cross-subject revision");
	}
	if (
		!Array.isArray(value.omissions) ||
		value.omissions.length > 100 ||
		value.omissions.some((s) => typeof s !== "string" || s.length > 2000)
	)
		throw new Error("Invalid omissions");
	for (const side of ["before", "after"] as const) {
		const entries = value[side];
		if (!Array.isArray(entries) || entries.length > REVIEW_SNAPSHOT_LIMITS.paths)
			throw new Error("Invalid retained inventory");
		const paths = new Set<string>();
		for (const e of entries) {
			exact(e, ["path", "mode", "gitOid", "state", "sha256", "bytes", ...("reason" in e ? ["reason"] : [])]);
			reviewPath(e.path);
			identifier(e.mode, /^(100644|100755|120000|160000)$/);
			identifier(e.gitOid, commitIdPattern);
			if (paths.has(e.path)) throw new Error("Duplicate retained path");
			paths.add(e.path);
			if (!["text", "binary", "unavailable"].includes(String(e.state)))
				throw new Error("Invalid retained source state");
			if (e.bytes !== null && (!Number.isSafeInteger(e.bytes) || Number(e.bytes) < 0))
				throw new Error("Invalid retained size");
			if (e.state === "unavailable") {
				if (
					e.sha256 !== null ||
					!["blob-limit", "total-limit", "object-unavailable", "symlink", "submodule"].includes(String(e.reason))
				)
					throw new Error("Invalid source omission");
			} else {
				identifier(e.sha256, repositoryIdPattern);
				if (
					e.bytes === null ||
					Number(e.bytes) > REVIEW_SNAPSHOT_LIMITS.blobBytes ||
					"reason" in e ||
					!String(e.mode).startsWith("100")
				)
					throw new Error("Invalid retained source");
			}
		}
	}
	if (!Array.isArray(value.changes) || value.changes.length > REVIEW_SNAPSHOT_LIMITS.paths * 2)
		throw new Error("Invalid change inventory");
	const m = value as unknown as ReviewSnapshotManifest;
	const pairs = new Set<string>();
	for (const change of m.changes) {
		exact(change, ["status", "beforePath", "afterPath", "beforeMode", "afterMode", "beforeOid", "afterOid"]);
		identifier(change.status, /^(?:[ADMT]|R(?:100|[0-9]{1,2}))$/);
		if (
			(change.status === "A") !== (change.beforePath === null) ||
			(change.status === "D") !== (change.afterPath === null)
		)
			throw new Error("Invalid comparison side presence");
		const pair = JSON.stringify([change.beforePath, change.afterPath]);
		if (pairs.has(pair)) throw new Error("Duplicate changed path pair");
		pairs.add(pair);
		for (const side of ["before", "after"] as const) {
			const path = change[`${side}Path`];
			identifier(change[`${side}Mode`], /^(000000|100644|100755|120000|160000)$/);
			identifier(change[`${side}Oid`], commitIdPattern);
			if (path === null) {
				if (change[`${side}Mode`] !== "000000" || change[`${side}Oid`] !== "0".repeat(40))
					throw new Error("Invalid absent side");
			} else {
				reviewPath(path);
				const entry = m[side].find((e) => e.path === path);
				// A partial inventory can omit a path, but cannot contradict a retained entry.
				if (
					(!entry && m.status === "complete") ||
					(entry && (entry.mode !== change[`${side}Mode`] || entry.gitOid !== change[`${side}Oid`]))
				)
					throw new Error("Manifest change identity mismatch");
			}
		}
	}
	if (m.trees !== null) {
		exact(m.trees, ["before", "after"]);
		identifier(m.trees.before, commitIdPattern);
		identifier(m.trees.after, commitIdPattern);
	}
	if (m.diff !== null) {
		exact(m.diff, ["sha256", "bytes"]);
		identifier(m.diff.sha256, repositoryIdPattern);
		if (!Number.isSafeInteger(m.diff.bytes) || m.diff.bytes < 0 || m.diff.bytes > REVIEW_SNAPSHOT_LIMITS.diffBytes)
			throw new Error("Invalid patch size");
	}
	if (
		m.status === "complete" &&
		(!m.trees || !m.diff || m.omissions.length || [...m.before, ...m.after].some((e) => e.state === "unavailable"))
	)
		throw new Error("Incomplete required review content");
	if (
		request.source === "working-copy" &&
		(m.status !== "unavailable" || m.diff || m.trees || m.before.length || m.after.length || m.changes.length)
	)
		throw new Error("Unsaved content was not coherently retained");
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
