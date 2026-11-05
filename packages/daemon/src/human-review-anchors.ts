import { createHash } from "node:crypto";
import type { HumanReviewAnchor, HumanReviewFeedback, HumanReviewLineRange } from "@pilot/protocol";
import { exact, identifier, repositoryIdPattern } from "./jj-ownership-contract.ts";
import { type ReviewSourceRef, reviewPath } from "./review-snapshot-contract.ts";

const localId = (v: unknown) => identifier(v, /^[A-Za-z0-9_-]{1,128}$/);
const text = (v: unknown, max = 8192) => {
	if (typeof v !== "string" || !v.trim() || Buffer.byteLength(v) > max) throw new Error("Invalid review text");
};
const list = (v: unknown, max: number): unknown[] => {
	if (!Array.isArray(v) || v.length > max) throw new Error("Review list limit exceeded");
	return v;
};
export function validateFeedback(value: unknown): asserts value is HumanReviewFeedback {
	exact(value, ["draft", "annotations", "findings", "resolveAnnotationIds", "supersedes"]);
	if (Buffer.byteLength(JSON.stringify(value)) > 24 * 1024) throw new Error("Feedback exceeds 24 KiB");
	if (value.draft !== null) {
		exact(value.draft, ["id", "revision"]);
		localId(value.draft.id);
		if (!Number.isSafeInteger(value.draft.revision) || Number(value.draft.revision) < 1)
			throw new Error("Invalid draft revision");
	}
	const ids = new Set<string>();
	for (const a of list(value.annotations, 100)) {
		exact(a, ["id", "body", "anchor", "supersedes"]);
		localId(a.id);
		if (ids.has(String(a.id))) throw new Error("Duplicate annotation");
		ids.add(String(a.id));
		text(a.body);
		if (a.supersedes !== null) localId(a.supersedes);
		validateAnchor(a.anchor);
	}
	for (const f of list(value.findings, 100)) {
		exact(f, ["recordId", "findingId", "disposition", "reason"]);
		localId(f.recordId);
		localId(f.findingId);
		if (!["concern", "not_issue", "missed"].includes(String(f.disposition)))
			throw new Error("Invalid finding opinion");
		text(f.reason);
	}
	const resolved = list(value.resolveAnnotationIds, 100);
	for (const id of resolved) localId(id);
	if (new Set(resolved).size !== resolved.length) throw new Error("Duplicate thread resolution");
	if (value.supersedes !== null) {
		exact(value.supersedes, ["recordId", "reason"]);
		localId(value.supersedes.recordId);
		text(value.supersedes.reason);
	}
}
export function validateAnchor(value: unknown): asserts value is HumanReviewAnchor {
	if (!value || typeof value !== "object") throw new Error("Invalid retained anchor");
	const kind = (value as HumanReviewAnchor).kind;
	exact(
		value,
		kind === "summary"
			? ["kind", "snapshotId"]
			: kind === "file"
				? ["kind", "snapshotId", "side", "path", "blobSha256"]
				: ["kind", "snapshotId", "ranges"],
	);
	identifier(value.snapshotId, repositoryIdPattern);
	if (kind === "summary") return;
	if (kind === "file") {
		reviewPath(value.path);
		if (!["before", "after"].includes(String(value.side))) throw new Error("Invalid anchor side");
		if (value.blobSha256 !== null) identifier(value.blobSha256, repositoryIdPattern);
		return;
	}
	if (kind !== "lines") throw new Error("Invalid anchor kind");
	const ranges = list(value.ranges, 2);
	if (!ranges.length) throw new Error("Empty anchor range");
	for (const r of ranges) {
		exact(r, [
			"side",
			"path",
			"blobSha256",
			"startLine",
			"endLine",
			"excerptSha256",
			"beforeContextSha256",
			"afterContextSha256",
		]);
		reviewPath(r.path);
		if (!["before", "after"].includes(String(r.side))) throw new Error("Invalid anchor side");
		for (const h of [r.blobSha256, r.excerptSha256, r.beforeContextSha256, r.afterContextSha256])
			identifier(h, repositoryIdPattern);
		if (
			!Number.isSafeInteger(r.startLine) ||
			!Number.isSafeInteger(r.endLine) ||
			Number(r.startLine) < 1 ||
			Number(r.endLine) < Number(r.startLine)
		)
			throw new Error("Invalid source range");
	}
	if (ranges.length === 2 && (ranges[0] as HumanReviewLineRange).side === (ranges[1] as HumanReviewLineRange).side)
		throw new Error("Cross-side range needs distinct sides");
}

/** Newline bytes belong to their line. CR and BOM bytes are never normalized. */
function lines(bytes: Uint8Array) {
	if (bytes.length > 2 * 1024 * 1024) throw new Error("Retained anchor blob limit exceeded");
	const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let count = b.length && b[b.length - 1] !== 10 ? 1 : 0;
	for (const byte of b) if (byte === 10) count++;
	const offsets = new Uint32Array(count + 1);
	let n = 1;
	for (let i = 0; i < b.length; i++) if (b[i] === 10) offsets[n++] = i + 1;
	offsets[count] = b.length;
	return { b, offsets, count };
}
const bytesHash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const sliceHash = (ls: ReturnType<typeof lines>, start: number, end: number) =>
	bytesHash(ls.b.subarray(ls.offsets[start], ls.offsets[Math.min(ls.count, end)]));
export function lineRange(
	bytes: Uint8Array,
	ref: Omit<ReviewSourceRef, "snapshotId">,
	startLine: number,
	endLine: number,
): HumanReviewLineRange {
	const ls = lines(bytes);
	if (
		!Number.isSafeInteger(startLine) ||
		!Number.isSafeInteger(endLine) ||
		startLine < 1 ||
		endLine < startLine ||
		endLine > ls.count ||
		bytesHash(bytes) !== ref.sha256
	)
		throw new Error("Anchor range or blob mismatch");
	return {
		side: ref.side,
		path: ref.path,
		blobSha256: ref.sha256,
		startLine,
		endLine,
		excerptSha256: sliceHash(ls, startLine - 1, endLine),
		beforeContextSha256: sliceHash(ls, Math.max(0, startLine - 3), startLine - 1),
		afterContextSha256: sliceHash(ls, endLine, endLine + 2),
	};
}
export function checkLineRange(bytes: Uint8Array, range: HumanReviewLineRange): void {
	const actual = lineRange(
		bytes,
		{ side: range.side, path: range.path, sha256: range.blobSha256 },
		range.startLine,
		range.endLine,
	);
	if (Object.entries(actual).some(([key, value]) => range[key as keyof HumanReviewLineRange] !== value))
		throw new Error("Retained excerpt/context mismatch");
}
export type RangeProjection =
	| { state: "same" | "moved"; range: HumanReviewLineRange }
	| { state: "outdated" }
	| { state: "ambiguous" };
export function projectRange(
	original: HumanReviewLineRange,
	oldBytes: Uint8Array,
	newBytes: Uint8Array,
	path = original.path,
): RangeProjection {
	checkLineRange(oldBytes, original);
	const sha256 = bytesHash(newBytes);
	if (sha256 === original.blobSha256) return { state: "same", range: { ...original, path } };
	const old = lines(oldBytes),
		next = lines(newBytes),
		count = original.endLine - original.startLine + 1;
	const excerpt = old.b.subarray(old.offsets[original.startLine - 1], old.offsets[original.endLine]);
	const candidates: number[] = [];
	// Only complete source-line matches. No whitespace, fuzzy or cross-file search.
	let from = 0;
	let occurrences = 0;
	while (from < next.b.length) {
		const offset = next.b.indexOf(excerpt, from);
		if (offset < 0) break;
		if (++occurrences > 1) return { state: "ambiguous" };
		from = offset + 1;
		let lo = 0,
			hi = next.count;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (next.offsets[mid] < offset) lo = mid + 1;
			else hi = mid;
		}
		if (
			next.offsets[lo] === offset &&
			lo + count <= next.count &&
			next.offsets[lo + count] === offset + excerpt.length
		)
			candidates.push(lo);
	}
	if (candidates.length !== 1) return { state: "outdated" };
	const i = candidates[0];
	if (
		sliceHash(next, Math.max(0, i - 2), i) !== original.beforeContextSha256 ||
		sliceHash(next, i + count, i + count + 2) !== original.afterContextSha256
	)
		return { state: "outdated" };
	return { state: "moved", range: lineRange(newBytes, { side: original.side, path, sha256 }, i + 1, i + count) };
}
