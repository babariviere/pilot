/** Backend-only native feedback producer. No request inference, gate or extractor activation. */
import type {
	DurableOperation,
	HumanReviewContent,
	HumanReviewDraft,
	NativeReviewSnapshot,
	ReviewDispositionPayload,
	ReviewDispositionTarget,
} from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { checkLineRange, projectRange, type RangeProjection, validateFeedback } from "./human-review-anchors.ts";
import { type HumanReviewStore, reviewContent } from "./human-review-store.ts";
import { identifier } from "./jj-ownership-contract.ts";
import { canonicalJSON, payloadHash } from "./operation-journal.ts";
import type { ReviewSourceRef } from "./review-snapshot-contract.ts";
import { dispositionPayload, type QualifiedReviewDispositionSource } from "./workflow-confirmations.ts";

export interface QualifiedFeedbackComparison {
	snapshot: NativeReviewSnapshot;
	fence: string;
	/** Synchronous current project/access/custody check, called inside the write transaction. */
	revalidate(): void;
	read(ref: ReviewSourceRef): Promise<Uint8Array>;
	validateRange?(range: import("@pilot/protocol").HumanReviewLineRange): Promise<void>;
	projectRange?(
		range: import("@pilot/protocol").HumanReviewLineRange,
		next: ReviewSourceRef,
	): Promise<RangeProjection>;
}
export interface QualifiedFeedbackPrerequisites {
	state: "passed" | "unavailable" | "blocked";
	/** Exact required check configuration/results and fresh independent review identities. */
	identity: string;
	/** Refuse if any input changed, expired or was revoked, including during journal I/O. */
	revalidate(): void;
}
interface Dependencies {
	store: HumanReviewStore;
	qualify(target: ReviewDispositionTarget): Promise<QualifiedFeedbackComparison>;
	/** Absent in production until real required-check and fresh-review producers are qualified. */
	prerequisites?(targets: ReviewDispositionTarget[]): Promise<QualifiedFeedbackPrerequisites>;
	/** #70's authoritative per-target requirement revision. Capture/feedback never supplies it. */
	requirement?(target: ReviewDispositionTarget): {
		identity: string;
		state: "required" | "requested" | "not_requested" | "withdrawn" | "unknown";
	};
}
const digest = (v: unknown) => payloadHash(canonicalJSON(v));
export function dispositionTarget(projectId: string, snapshot: NativeReviewSnapshot): ReviewDispositionTarget {
	if (!snapshot.diff) throw new Conflict("Exact retained comparison patch unavailable");
	return {
		projectId,
		sessionId: snapshot.workerId,
		snapshotId: snapshot.snapshotId,
		repositoryId: snapshot.request.repositoryId,
		changeId: snapshot.request.changeId,
		baseCommitId: snapshot.request.base.commitId,
		headCommitId: snapshot.request.head.commitId,
		layer: snapshot.request.scope.kind,
		diffSha256: snapshot.diff.sha256,
		comparisonDigest: digest({ snapshotId: snapshot.snapshotId, request: snapshot.request, diff: snapshot.diff }),
	};
}
export class HumanReviews implements QualifiedReviewDispositionSource {
	private readonly deps: Dependencies;
	constructor(deps: Dependencies) {
		this.deps = deps;
	}
	private validate(request: ReviewDispositionPayload) {
		return dispositionPayload(request);
	}
	private async comparisons(targets: ReviewDispositionTarget[]) {
		targets = dispositionPayload({
			purpose: "review-disposition",
			targets,
			disposition: "comment",
			body: "Read exact feedback",
			expectedPriorRecordId: null,
			packageDigest: "0".repeat(64),
		}).targets;
		const selected: QualifiedFeedbackComparison[] = [];
		// Sequential reads respect the shared retained-store queue limit.
		for (const target of targets) {
			const c = await this.deps.qualify(structuredClone(target));
			if (canonicalJSON(dispositionTarget(target.projectId, c.snapshot)) !== canonicalJSON(target))
				throw new Conflict("Exact comparison changed");
			selected.push(c);
		}
		const revalidate = () => {
			for (const c of selected) c.revalidate();
		};
		revalidate();
		return { selected, revalidate };
	}
	private async anchors(request: HumanReviewContent, selected: QualifiedFeedbackComparison[]) {
		if (!request.feedback) return;
		validateFeedback(request.feedback);
		let readBytes = 0;
		for (const annotation of request.feedback.annotations) {
			const anchor = annotation.anchor;
			const comparison = selected.find((c) => c.snapshot.snapshotId === anchor.snapshotId);
			if (!comparison) throw new Conflict("Annotation is outside the selected comparisons");
			if (anchor.kind === "summary") continue;
			const ranges = anchor.kind === "file" ? [anchor] : anchor.ranges;
			for (const range of ranges) {
				const entry = comparison.snapshot[range.side].find((e) => e.path === range.path);
				if (!entry || entry.sha256 !== range.blobSha256) throw new Conflict("Anchor path/blob not retained");
				if (anchor.kind === "file") continue;
				if (entry.state !== "text" || !entry.sha256 || entry.bytes === null)
					throw new Conflict("Line anchor needs exact retained text");
				readBytes += entry.bytes;
				if (readBytes > 16 * 1024 * 1024) throw new Conflict("Annotation source read budget exceeded");
				if (comparison.validateRange) {
					await comparison.validateRange(range as import("@pilot/protocol").HumanReviewLineRange);
					continue;
				}
				const bytes = await comparison.read({
					snapshotId: anchor.snapshotId,
					side: range.side,
					path: range.path,
					sha256: entry.sha256,
				});
				checkLineRange(bytes, range as import("@pilot/protocol").HumanReviewLineRange);
			}
		}
	}
	private async package(request: ReviewDispositionPayload) {
		const value = this.validate(request);
		const comparisons = await this.comparisons(value.targets);
		await this.anchors(value, comparisons.selected);
		const prerequisites: QualifiedFeedbackPrerequisites =
			value.disposition === "approve" && this.deps.prerequisites
				? await this.deps.prerequisites(structuredClone(value.targets))
				: { state: "unavailable", identity: "unavailable", revalidate() {} };
		const targetFences = () =>
			value.targets.map((target) => {
				const requirement = this.deps.requirement?.(structuredClone(target)) ?? {
					identity: "unavailable",
					state: "unknown" as const,
				};
				return { prior: this.deps.store.targetState(target), requirement: { ...requirement } };
			});
		const fences = targetFences();
		const resolved = new Set(value.feedback?.resolveAnnotationIds ?? []);
		const unblocked =
			(value.feedback?.annotations ?? []).every((a) => resolved.has(a.id)) &&
			fences.every(
				({ prior, requirement }) =>
					prior.complete &&
					requirement.state !== "unknown" &&
					requirement.state !== "withdrawn" &&
					prior.blockingReviewIds.every((id) => id === value.feedback?.supersedes?.recordId) &&
					prior.unresolvedThreadIds.every((id) => resolved.has(id)),
			);
		const ready =
			unblocked &&
			prerequisites.state === "passed" &&
			comparisons.selected.every((c) => c.snapshot.status === "complete" && c.snapshot.diff !== null);
		const prior = this.deps.store.latest(value.targets)?.id ?? null;
		const prepared = { ...value, expectedPriorRecordId: prior };
		const packageDigest = digest({
			version: 1,
			purpose: value.purpose,
			content: reviewContent(value),
			prior,
			custody: comparisons.selected.map((c) => c.fence),
			targetFences: fences,
			prerequisites:
				value.disposition === "approve"
					? { identity: prerequisites.identity, state: prerequisites.state, ready }
					: null,
		});
		const revalidate = () => {
			comparisons.revalidate();
			if (canonicalJSON(fences) !== canonicalJSON(targetFences()))
				throw new Conflict("Per-target prior or requirement changed");
			if (value.disposition === "approve") prerequisites.revalidate();
		};
		revalidate();
		return { payload: { ...prepared, packageDigest }, ready, revalidate };
	}
	async prepare(request: ReviewDispositionPayload): Promise<ReviewDispositionPayload> {
		const built = await this.package(structuredClone(request));
		await this.deps.store.durable();
		built.revalidate();
		if ((this.deps.store.latest(request.targets)?.id ?? null) !== built.payload.expectedPriorRecordId)
			throw new Conflict("Review changed during preparation");
		return built.payload;
	}
	async prerequisites(request: ReviewDispositionPayload): Promise<"passed" | "unavailable" | "blocked"> {
		const built = await this.package(request);
		if (canonicalJSON(built.payload) !== canonicalJSON(request)) return "blocked";
		return built.ready ? "passed" : "unavailable";
	}
	async record(op: DurableOperation, request: ReviewDispositionPayload): Promise<{ recordId: string }> {
		if (
			op.kind !== "review-disposition" ||
			op.targetId !== request.packageDigest ||
			op.payloadHash !== payloadHash(op.payload) ||
			canonicalJSON(JSON.parse(op.payload)) !== canonicalJSON(request)
		)
			throw new Conflict("Exact native review operation mismatch");
		const existing = await this.lookup(op);
		if (existing) return existing;
		const built = await this.package(structuredClone(request));
		if (canonicalJSON(built.payload) !== canonicalJSON(request))
			throw new Conflict("Immutable review package changed");
		if (request.disposition === "approve" && !built.ready)
			throw new Conflict("Required checks and fresh agent review are unavailable");
		const record = this.deps.store.append(op, request, built.revalidate);
		await this.deps.store.durable();
		return { recordId: record.id };
	}
	/** Reconciliation never prepares, checks readiness, infers acceptance, or records a missing effect. */
	async lookup(op: DurableOperation): Promise<{ recordId: string } | undefined> {
		const request = this.validate(JSON.parse(op.payload));
		if (
			op.kind !== request.purpose ||
			op.targetId !== request.packageDigest ||
			payloadHash(op.payload) !== op.payloadHash
		)
			throw new Conflict("Wrong review operation");
		const access = await this.comparisons(request.targets);
		const record = this.deps.store.lookup(op);
		await this.deps.store.durable();
		access.revalidate();
		return record ? { recordId: record.id } : undefined;
	}
	async saveDraft(id: string, expectedRevision: number, input: HumanReviewContent): Promise<HumanReviewDraft> {
		identifier(id, /^[A-Za-z0-9_-]{1,128}$/);
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Conflict("Invalid draft revision");
		const value = dispositionPayload(
			{ ...input, purpose: "review-disposition", expectedPriorRecordId: null, packageDigest: "0".repeat(64) },
			true,
		);
		if (value.feedback?.draft !== null && value.feedback?.draft !== undefined)
			throw new Conflict("Draft cannot submit another draft");
		const prior = this.deps.store.draft(id);
		const oldAccess = prior ? await this.comparisons(prior.content.targets) : undefined;
		const access = await this.comparisons(value.targets);
		await this.anchors(value, access.selected);
		const draft = this.deps.store.saveDraft(id, expectedRevision, value, () => {
			oldAccess?.revalidate();
			access.revalidate();
		});
		await this.deps.store.durable();
		return draft;
	}
	async draft(id: string) {
		identifier(id, /^[A-Za-z0-9_-]{1,128}$/);
		const draft = this.deps.store.draft(id);
		if (!draft) return undefined;
		const access = await this.comparisons(draft.content.targets);
		await this.deps.store.durable();
		access.revalidate();
		return draft;
	}
	async history(target: ReviewDispositionTarget, after = 0) {
		if (!Number.isSafeInteger(after) || after < 0) throw new Conflict("Invalid feedback cursor");
		const access = await this.comparisons([target]);
		const rows = this.deps.store.history(target, after);
		const scopes = [];
		for (const row of rows) scopes.push(await this.comparisons(row.record.confirmed.targets));
		await this.deps.store.durable();
		access.revalidate();
		for (const scope of scopes) scope.revalidate();
		return rows;
	}
	/** Read-time projection only. Never edits anchors, resolves a thread or carries approval forward. */
	async projectAnnotation(id: string, target: ReviewDispositionTarget) {
		identifier(id, /^[A-Za-z0-9_-]{1,128}$/);
		const record = this.deps.store.annotationRecord(id);
		if (!record) throw new Conflict("Original annotation unavailable");
		const access = await this.comparisons(record.confirmed.targets);
		const next = await this.comparisons([target]);
		const original = record.confirmed.feedback!.annotations.find((a) => a.id === id)!;
		const anchor = original.anchor;
		const oldIndex = record.confirmed.targets.findIndex((t) => t.snapshotId === anchor.snapshotId);
		const from = record.confirmed.targets[oldIndex],
			old = access.selected[oldIndex],
			current = next.selected[0];
		if (
			from.projectId !== target.projectId ||
			from.repositoryId !== target.repositoryId ||
			from.changeId !== target.changeId
		)
			throw new Conflict("Cross-subject anchor projection");
		let state: "same" | "moved" | "outdated" | "ambiguous" = "outdated";
		let projected: import("@pilot/protocol").HumanReviewAnchor | undefined;
		const pathOn = (side: "before" | "after", path: string) => {
			if (current.snapshot[side].some((e) => e.path === path)) return path;
			if (side !== "after") return undefined;
			const renames = current.snapshot.changes.filter(
				(c) => /^R\d+$/.test(c.status) && c.beforePath === path && c.afterPath,
			);
			return renames.length === 1 ? renames[0].afterPath! : undefined;
		};
		if (anchor.kind === "summary") {
			if (anchor.snapshotId === target.snapshotId) {
				state = "same";
				projected = structuredClone(anchor);
			}
		} else if (anchor.kind === "file") {
			const path = pathOn(anchor.side, anchor.path),
				entry = current.snapshot[anchor.side].find((e) => e.path === path);
			if (path && entry) {
				state = "same";
				projected = { ...anchor, snapshotId: target.snapshotId, path, blobSha256: entry.sha256 };
			}
		} else {
			const ranges: import("@pilot/protocol").HumanReviewLineRange[] = [];
			state = "same";
			for (const range of anchor.ranges) {
				const path = pathOn(range.side, range.path),
					entry = current.snapshot[range.side].find((e) => e.path === path);
				if (!path || entry?.state !== "text" || !entry.sha256) {
					state = "outdated";
					break;
				}
				if (anchor.ranges.length > 1 && entry.sha256 !== range.blobSha256) {
					state = "outdated";
					break;
				}
				const nextRef = { snapshotId: target.snapshotId, side: range.side, path, sha256: entry.sha256 };
				const p = old.projectRange
					? await old.projectRange(range, nextRef)
					: projectRange(
							range,
							await old.read({
								snapshotId: anchor.snapshotId,
								side: range.side,
								path: range.path,
								sha256: range.blobSha256,
							}),
							await current.read(nextRef),
							path,
						);
				if (p.state === "outdated" || p.state === "ambiguous") {
					state = p.state;
					break;
				}
				if (p.state === "moved") state = "moved";
				ranges.push(p.range);
			}
			if (state === "same" || state === "moved") projected = { ...anchor, snapshotId: target.snapshotId, ranges };
		}
		await this.deps.store.durable();
		access.revalidate();
		next.revalidate();
		return { version: "reanchor-v1" as const, state, original, ...(projected ? { projected } : {}) };
	}
	/** Future extraction reads original feedback, with fresh access checks even after retirement. */
	async extraction(after = 0) {
		if (!Number.isSafeInteger(after) || after < 0) throw new Conflict("Invalid extraction cursor");
		const rows = this.deps.store.outbox(after),
			result = [],
			scopes = [];
		for (const row of rows) {
			const record = this.deps.store.get(row.reviewId);
			if (!record) throw new Conflict("Original feedback unavailable");
			scopes.push(await this.comparisons(record.confirmed.targets));
			result.push({ ...row, record });
		}
		await this.deps.store.durable();
		for (const scope of scopes) scope.revalidate();
		return result;
	}
}
