/** Bounded read projection. The caller is the Local app, not an authenticated session. */
import { TextDecoder } from "node:util";
import type { NativeReviewCaptureStatus, NativeReviewSnapshot } from "@pilot/protocol";
import type { JjOwnershipStore } from "./jj-ownership.ts";
import { bindingRecord, identifier, type JjOwnershipBinding, repositoryIdPattern } from "./jj-ownership-contract.ts";
import { deliveryDigest } from "./mission-delivery-evidence.ts";
import { type ReviewSourceRef, reviewPath } from "./review-snapshot-contract.ts";
import type { ReviewSnapshotStore } from "./review-snapshots.ts";

/** No enrollment is performed by reads, including legacy/direct workspace browsing. */
export class NoRetainedBinding extends Error {}

export class NativeReviewReader {
	private readonly snapshots: Pick<ReviewSnapshotStore, "get" | "list" | "diff" | "read">;
	private readonly ledger: Pick<JjOwnershipStore, "get"> & Partial<Pick<JjOwnershipStore, "deliveryStatus">>;
	private readonly admit: () => Promise<JjOwnershipBinding>;
	constructor(
		snapshots: Pick<ReviewSnapshotStore, "get" | "list" | "diff" | "read">,
		ledger: Pick<JjOwnershipStore, "get"> & Partial<Pick<JjOwnershipStore, "deliveryStatus">>,
		admit: () => Promise<JjOwnershipBinding>,
	) {
		this.snapshots = snapshots;
		this.ledger = ledger;
		this.admit = admit;
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
					"No retained managed ownership binding for this worker. Reading does not enroll, capture or migrate existing work.",
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
			enrollmentTaskIds: o.binding.taskIds,
			creation: o.creation,
			omissions: m.omissions,
			before: m.before,
			after: m.after,
			changes: m.changes,
			diff: m.diff,
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
	async source(snapshotId: string, ref: ReviewSourceRef) {
		const { binding, snapshot } = await this.snapshot(snapshotId);
		if (ref.snapshotId !== snapshotId || !["before", "after"].includes(ref.side))
			throw new Error("Cross-comparison source");
		reviewPath(ref.path);
		identifier(ref.sha256, repositoryIdPattern);
		const entry = snapshot.manifest[ref.side].find((e) => e.path === ref.path);
		if (!entry || entry.state !== "text" || entry.sha256 !== ref.sha256)
			throw new Error("Retained text is unavailable, binary or unsupported");
		const bytes = await this.snapshots.read(snapshotId, ref);
		await this.owner(binding, snapshot.manifest.request.repositoryId, snapshot.manifest.request.changeId);
		await this.check(binding);
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	}
}
