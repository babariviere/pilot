/** Bounded read projection. The caller is the Local app, not an authenticated session. */
import { TextDecoder } from "node:util";
import { compareRetainedCalls, type RetainedCallQuery } from "@pilot/kernel/retained-calls";
import type { NativeReviewCaptureStatus, NativeReviewSnapshot, ReviewDispositionTarget } from "@pilot/protocol";
import type { JjOwnershipStore } from "./jj-ownership.ts";
import { bindingRecord, identifier, type JjOwnershipBinding, repositoryIdPattern } from "./jj-ownership-contract.ts";
import { deliveryDigest } from "./mission-delivery-evidence.ts";
import { canonicalJSON, payloadHash } from "./operation-journal.ts";
import { type ReviewSourceRef, reviewPath } from "./review-snapshot-contract.ts";
import type { ReviewSnapshotStore } from "./review-snapshots.ts";

/** No enrollment is performed by reads, including legacy/direct workspace browsing. */
export class NoRetainedBinding extends Error {}

export class NativeReviewReader {
	private readonly snapshots: Pick<ReviewSnapshotStore, "get" | "list" | "diff" | "read"> &
		Partial<Pick<ReviewSnapshotStore, "identity" | "validateRange" | "projectRange" | "verifyDiff" | "comparison">>;
	private readonly ledger: Pick<JjOwnershipStore, "get"> &
		Partial<Pick<JjOwnershipStore, "deliveryStatus" | "list" | "binding" | "head">>;
	private readonly admit: () => Promise<JjOwnershipBinding>;
	private readonly syncScope?: () => string;
	constructor(
		snapshots: Pick<ReviewSnapshotStore, "get" | "list" | "diff" | "read"> &
			Partial<
				Pick<ReviewSnapshotStore, "identity" | "validateRange" | "projectRange" | "verifyDiff" | "comparison">
			>,
		ledger: Pick<JjOwnershipStore, "get"> &
			Partial<Pick<JjOwnershipStore, "deliveryStatus" | "list" | "binding" | "head">>,
		admit: () => Promise<JjOwnershipBinding>,
		syncScope?: () => string,
	) {
		this.snapshots = snapshots;
		this.ledger = ledger;
		this.admit = admit;
		this.syncScope = syncScope;
	}
	private async scope() {
		const b = await this.admit();
		bindingRecord(b);
		return b;
	}
	private async check(binding: JjOwnershipBinding) {
		if (deliveryDigest(binding) !== deliveryDigest(await this.scope()))
			throw new Error("Retained scope changed during read");
	}
	async list(after: number): Promise<
		| (Awaited<ReturnType<ReviewSnapshotStore["list"]>> & {
				capture?: NativeReviewCaptureStatus;
		  })
		| { comparisons: never[]; next: null; unavailable: string }
	> {
		let binding: JjOwnershipBinding;
		try {
			binding = await this.scope();
		} catch (error) {
			if (!(error instanceof NoRetainedBinding)) throw error;
			return {
				comparisons: [],
				next: null,
				unavailable:
					"Not captured. No retained managed ownership binding for this worker. Reading does not enroll, capture or migrate existing work.",
			};
		}
		const page = await this.snapshots.list(binding, after);
		const capture = await this.ledger.deliveryStatus?.(binding);
		// Frozen provenance alone cannot override a current collision/unknown creator.
		for (const c of page.comparisons) await this.owner(binding, c.request.repositoryId, c.request.changeId);
		await this.check(binding);
		return { comparisons: page.comparisons, next: page.next, ...(capture ? { capture } : {}) };
	}
	private async owner(binding: JjOwnershipBinding, repositoryId: string, changeId: string) {
		if (repositoryId !== binding.repositoryId) throw new Error("Cross-repository comparison");
		const owned = await this.ledger.get(repositoryId, changeId);
		if (owned.ownership.status !== "owned" || deliveryDigest(owned.ownership.binding) !== deliveryDigest(binding))
			throw new Error("Unknown or changed retained custody");
	}
	/** Passive ledger census only, never observe(), capture, enrollment or a filesystem inventory. */
	async contributions() {
		const binding = await this.scope(),
			ledger = this.ledger;
		if (!ledger.list || !ledger.binding || !ledger.head) throw new Error("Passive ownership reader unavailable");
		const checkpoint = await ledger.binding(binding.repositoryId, binding.workspace);
		const operationId = await ledger.head(binding.path);
		if (!checkpoint || deliveryDigest(checkpoint.binding) !== deliveryDigest(binding))
			throw new Error("Ownership checkpoint unavailable");
		const changes = [];
		let after = "",
			complete = false;
		for (let page = 0; page < 10; page++) {
			const rows = await ledger.list(binding.repositoryId, binding.workspace, after, 100);
			if (rows.length > 100) throw new Error("Invalid ownership page");
			for (const row of rows) {
				if (row.repositoryId !== binding.repositoryId || row.changeId <= after)
					throw new Error("Invalid ownership cursor");
				after = row.changeId;
				changes.push(row);
			}
			if (rows.length < 100) {
				complete = true;
				break;
			}
		}
		await this.check(binding);
		const current = await ledger.binding(binding.repositoryId, binding.workspace);
		const currentOperation = await ledger.head(binding.path);
		await this.check(binding);
		if (deliveryDigest(checkpoint) !== deliveryDigest(current ?? null) || operationId !== currentOperation)
			throw new Error("Ownership/source changed during census");
		return {
			operationId,
			changes,
			status:
				complete && checkpoint.coverage === "complete" && !checkpoint.problem && checkpoint.cursor === operationId
					? ("observed" as const)
					: ("unknown" as const),
			reason: !complete
				? "Ownership pagination limit"
				: checkpoint.cursor !== operationId
					? "Ledger has not observed the current operation"
					: (checkpoint.problem ??
						(checkpoint.coverage !== "complete"
							? "Unobserved ownership interval"
							: "Passive ledger at exact operation, not a dirty/unmanaged filesystem inventory")),
		};
	}
	private async snapshot(snapshotId: string) {
		identifier(snapshotId, repositoryIdPattern);
		const binding = await this.scope();
		const snapshot = await this.snapshots.get(snapshotId);
		if (snapshot.snapshotId !== snapshotId) throw new Error("Wrong retained comparison");
		// Store.get validates the complete bounded manifest and hash in its worker.
		// Do not repeat inventory validation/hashing on the daemon event loop.
		const m = snapshot.manifest,
			o = m.provenance.ledger.ownership;
		if (o.status !== "owned" || deliveryDigest(o.binding) !== deliveryDigest(binding))
			throw new Error("Cross-scope comparison");
		await this.owner(binding, m.request.repositoryId, m.request.changeId);
		await this.check(binding);
		return { binding, snapshot };
	}
	async get(snapshotId: string): Promise<NativeReviewSnapshot> {
		const { snapshot } = await this.snapshot(snapshotId),
			m = snapshot.manifest;
		const o = m.provenance.ledger.ownership;
		if (o.status !== "owned") throw new Error("Unknown custody");
		return {
			snapshotId,
			request: m.request,
			status: m.status,
			workerId: o.binding.sessionId,
			capturedAt: m.provenance.capturedAt,
			enrollmentTaskIds: o.binding.version === 1 ? o.binding.taskIds : [],
			...(o.binding.version === 2 ? { enrollmentProjectId: o.binding.projectId } : {}),
			creation: o.creation,
			omissions: m.omissions,
			before: m.before,
			after: m.after,
			changes: m.changes,
			diff: m.diff,
		};
	}
	/** Exact indexed comparison, with the same custody checks as source reads. */
	async comparison(snapshotId: string) {
		if (!this.snapshots.comparison) throw new Error("Exact comparison reader unavailable");
		const { binding } = await this.snapshot(snapshotId);
		const comparison = await this.snapshots.comparison(snapshotId);
		await this.owner(binding, comparison.request.repositoryId, comparison.request.changeId);
		await this.check(binding);
		return comparison;
	}
	/** Retained package plus a synchronous last-step fence for a missions.sqlite commit. */
	async qualify(target: ReviewDispositionTarget) {
		const ledger = this.ledger as Partial<Pick<JjOwnershipStore, "readFence">>;
		if (!ledger.readFence || !this.syncScope) throw new Error("Atomic retained feedback admission unavailable");
		const custody = ledger.readFence(target.repositoryId),
			scope = this.syncScope();
		const snapshot = await this.get(target.snapshotId);
		if (!snapshot.diff) throw new Error("Exact retained comparison patch unavailable");
		const expected = {
			projectId: target.projectId,
			sessionId: snapshot.workerId,
			snapshotId: snapshot.snapshotId,
			repositoryId: snapshot.request.repositoryId,
			changeId: snapshot.request.changeId,
			baseCommitId: snapshot.request.base.commitId,
			headCommitId: snapshot.request.head.commitId,
			layer: snapshot.request.scope.kind,
			diffSha256: snapshot.diff.sha256,
			comparisonDigest: payloadHash(
				canonicalJSON({ snapshotId: snapshot.snapshotId, request: snapshot.request, diff: snapshot.diff }),
			),
		};
		if (canonicalJSON(target) !== canonicalJSON(expected)) throw new Error("Wrong exact retained comparison");
		if (this.snapshots.verifyDiff) await this.snapshots.verifyDiff(target.snapshotId);
		else await this.snapshots.diff(target.snapshotId);
		const ownership = await this.ledger.get(target.repositoryId, target.changeId);
		const revalidate = () => {
			custody();
			if (this.syncScope!() !== scope) throw new Error("Current retained project/access changed");
		};
		revalidate();
		return {
			snapshot,
			fence: payloadHash(canonicalJSON({ scope, target, ownership })),
			revalidate,
			read: (ref: ReviewSourceRef) => this.readExact(target.snapshotId, ref),
			...(this.snapshots.validateRange
				? {
						validateRange: async (range: import("@pilot/protocol").HumanReviewLineRange) => {
							revalidate();
							await this.snapshots.validateRange!(target.snapshotId, range);
							revalidate();
						},
					}
				: {}),
			...(this.snapshots.projectRange
				? {
						projectRange: async (
							range: import("@pilot/protocol").HumanReviewLineRange,
							next: ReviewSourceRef,
						) => {
							revalidate();
							const result = await this.snapshots.projectRange!(target.snapshotId, range, next);
							revalidate();
							return result;
						},
					}
				: {}),
		};
	}
	async diff(snapshotId: string) {
		const { binding, snapshot } = await this.snapshot(snapshotId);
		if (!snapshot.manifest.diff) throw new Error("Retained patch unavailable");
		const bytes = await this.snapshots.diff(snapshotId);
		await this.owner(binding, snapshot.manifest.request.repositoryId, snapshot.manifest.request.changeId);
		await this.check(binding);
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	}
	/** Original retained bytes for hashing and source-inferred analysis. */
	async readExact(snapshotId: string, ref: ReviewSourceRef) {
		const { binding, snapshot } = await this.snapshot(snapshotId);
		if (ref.snapshotId !== snapshotId || !["before", "after"].includes(ref.side))
			throw new Error("Cross-comparison source");
		reviewPath(ref.path);
		identifier(ref.sha256, repositoryIdPattern);
		const entry = snapshot.manifest[ref.side].find((e) => e.path === ref.path);
		if (entry?.state !== "text" || entry.sha256 !== ref.sha256)
			throw new Error("Retained text is unavailable, binary or unsupported");
		const bytes = await this.snapshots.read(snapshotId, ref);
		await this.owner(binding, snapshot.manifest.request.repositoryId, snapshot.manifest.request.changeId);
		await this.check(binding);
		return bytes;
	}
	async source(snapshotId: string, ref: ReviewSourceRef) {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await this.readExact(snapshotId, ref));
	}
	/** Host-selected retained pair. No agent tool, capture or acceptance authority. */
	async compareCalls(snapshotId: string, query: RetainedCallQuery = {}, signal?: AbortSignal) {
		signal?.throwIfAborted();
		const { binding, snapshot } = await this.snapshot(snapshotId);
		signal?.throwIfAborted();
		if (!this.snapshots.identity) throw new Error("Retained analysis store identity unavailable");
		const storeId = await this.snapshots.identity();
		signal?.throwIfAborted();
		return compareRetainedCalls(
			{
				input: {
					storeId,
					snapshotId,
					request: snapshot.manifest.request,
					status: snapshot.manifest.status,
					before: snapshot.manifest.before,
					after: snapshot.manifest.after,
				},
				authorize: async () => {
					await this.owner(binding, snapshot.manifest.request.repositoryId, snapshot.manifest.request.changeId);
					await this.check(binding);
				},
				// Immutable manifest qualified once above. The runner rechecks scope/custody around
				// each raw read; the store independently validates the exact ref, manifest and bytes.
				read: (ref) => this.snapshots.read(snapshotId, ref),
			},
			query,
			signal,
		);
	}
}
