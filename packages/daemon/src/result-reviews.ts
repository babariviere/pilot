/** Private discussion and personal notes. No approval, provider, PR or agent effects. */
import type {
	DeliveredWork,
	ResultAnchor,
	ResultReviewEdit,
	ResultReviewEntry,
	ResultReviewPage,
	ResultReviewReceipt,
	VerificationSubject,
} from "@pilot/protocol";
import { lineExcerpt } from "./human-review-anchors.ts";
import type { MissionStore } from "./missions.ts";
import type { NativeReviewReader } from "./native-review.ts";
import { canonicalJSON, OperationRejected, payloadHash } from "./operation-journal.ts";
import { verificationKey } from "./user-verification.ts";

interface Dependencies {
	store: MissionStore;
	deliveries: {
		read(subject: VerificationSubject): Promise<DeliveredWork>;
		readNow(subject: VerificationSubject): DeliveredWork;
	};
	reader(target: {
		projectId: string;
		sessionId: string;
		snapshotId: string;
	}): Pick<NativeReviewReader, "get" | "diff" | "readExact"> & Partial<Pick<NativeReviewReader, "list">>;
}
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
function reject(message: string): never {
	throw new OperationRejected(message);
}

export class ResultReviews {
	private readonly deps: Dependencies;
	constructor(deps: Dependencies) {
		this.deps = deps;
	}
	private async snapshots(page: DeliveredWork) {
		const linked = page.submission?.evidence.filter((e) => e.kind === "snapshot").map((e) => e.snapshotId) ?? [];
		if (linked.length || !page.ownerSessionId) return linked;
		const commit = page.completion?.commit ?? page.workerDelivery?.commit;
		if (!commit || !/^[a-f0-9]{40}$/.test(commit)) return [];
		const reader = this.deps.reader({
			projectId: page.subject.projectId,
			sessionId: page.ownerSessionId,
			snapshotId: "inventory",
		});
		if (!reader.list) return [];
		// Five metadata pages cover 100 comparisons without scanning a workspace.
		// Only the reported commit matches, never an inferred latest tip or dirty working copy.
		let after = 0;
		const matches: string[] = [];
		for (let i = 0; i < 5; i++) {
			const list = await reader.list(after);
			for (const comparison of list.comparisons)
				if (comparison.request.head.commitId === commit && comparison.request.source === "committed")
					matches.push(comparison.snapshotId);
			if (list.next === null) break;
			after = list.next;
		}
		this.revalidate(page);
		return matches;
	}
	async read(subject: VerificationSubject, before = Number.MAX_SAFE_INTEGER): Promise<ResultReviewPage> {
		if (!Number.isSafeInteger(before) || before < 1) reject("Invalid private review history cursor");
		const page = await this.deps.deliveries.read(subject);
		if (!page.deliveryId) reject("No delivered result");
		const key = verificationKey(subject);
		let snapshots: string[] = [];
		try {
			snapshots = await this.snapshots(page);
		} catch {
			this.revalidate(page);
		}
		await this.deps.store.durable();
		this.revalidate(page);
		const rows = this.deps.store.userVerifications.reviewPage(key, before);
		const entries = rows.slice(0, 20).reverse();
		return {
			subject,
			deliveryId: page.deliveryId!,
			revision: this.deps.store.userVerifications.latestReview(key)?.revision ?? 0,
			entries,
			snapshots,
			nextBefore: rows.length > 20 ? entries[0]!.revision : null,
			personalNote: this.deps.store.userVerifications.personalReviewNote(key),
		};
	}
	async lookup(subject: VerificationSubject, operation: string) {
		if (!id(operation)) reject("Invalid operation");
		await this.deps.deliveries.read(subject);
		await this.deps.store.durable();
		this.deps.deliveries.readNow(subject);
		const key = verificationKey(subject);
		return (
			this.deps.store.userVerifications.reviewOperation(key, operation)?.entry ??
			this.deps.store.userVerifications.reviewRejection(key, operation)?.entry ??
			null
		);
	}
	private revalidate(shown: DeliveredWork) {
		const now = this.deps.deliveries.readNow(shown.subject);
		if (now.deliveryId !== shown.deliveryId || now.ownerSessionId !== shown.ownerSessionId)
			reject("Result changed; refresh first");
	}
	private async source(subject: VerificationSubject, snapshotId: string) {
		if (!id(snapshotId)) reject("Invalid comparison");
		const shown = await this.deps.deliveries.read(subject);
		const original = this.deps.store.userVerifications.originalReviewAnchor(verificationKey(subject), snapshotId);
		const owner = (await this.snapshots(shown)).includes(snapshotId)
			? shown.ownerSessionId
			: original?.ownerSessionId;
		if (!owner) reject("Comparison is not linked to this result or its saved comments");
		const reader = this.deps.reader({ projectId: subject.projectId, sessionId: owner!, snapshotId });
		const snapshot = await reader.get(snapshotId);
		if (snapshot.workerId !== owner || snapshot.snapshotId !== snapshotId) reject("Comparison owner changed");
		return { shown, reader, snapshot };
	}
	/** Exact retained diff, including source identities for line selection. Never falls back to live files. */
	async diff(subject: VerificationSubject, snapshotId: string) {
		const { shown, reader, snapshot } = await this.source(subject, snapshotId);
		let bytes = 0;
		const files: import("@pilot/protocol").ResultDiff["files"] = [];
		for (const change of snapshot.changes) {
			let reason = "";
			const side = async (which: "before" | "after", path: string | null) => {
				if (path === null) return null;
				const source = snapshot[which].find((e) => e.path === path);
				if (source?.state !== "text" || source.bytes === null || !source.sha256) {
					reason = "Saved text unavailable (binary or not kept).";
					return null;
				}
				bytes += source.bytes;
				if (bytes > 1024 * 1024 || files.length >= 40) {
					reason = "Source display capacity reached. Nothing was truncated.";
					return null;
				}
				const raw = await reader.readExact(snapshotId, { snapshotId, side: which, path, sha256: source.sha256 });
				return { path, sha256: source.sha256, text: new TextDecoder("utf-8", { fatal: true }).decode(raw) };
			};
			const before = await side("before", change.beforePath),
				after = await side("after", change.afterPath);
			files.push({
				path: change.afterPath ?? change.beforePath ?? "Unknown path",
				status:
					change.beforeMode === change.afterMode
						? change.status
						: `${change.status} · mode ${change.beforeMode || "none"} → ${change.afterMode || "none"}`,
				before: reason ? null : before,
				after: reason ? null : after,
				reason,
			});
		}
		await reader.get(snapshotId);
		this.revalidate(shown);
		return {
			snapshotId,
			base: snapshot.request.base.commitId,
			head: snapshot.request.head.commitId,
			status: snapshot.status,
			omissions: snapshot.omissions,
			files,
		};
	}
	private async anchor(subject: VerificationSubject, anchor: ResultAnchor): Promise<ResultAnchor> {
		if (!anchor || typeof anchor !== "object") reject("Invalid comment location");
		if (anchor.kind === "general" && Object.keys(anchor).length === 1) return anchor;
		if (
			anchor.kind === "section" &&
			Object.keys(anchor).length === 2 &&
			["changes", "checks", "risks", "remaining"].includes(anchor.section)
		)
			return anchor;
		if (
			anchor.kind !== "lines" ||
			Object.keys(anchor).length !== 8 ||
			!hash(anchor.blobSha256) ||
			!["before", "after"].includes(anchor.side) ||
			!Number.isSafeInteger(anchor.start) ||
			!Number.isSafeInteger(anchor.end) ||
			anchor.start < 1 ||
			anchor.end < anchor.start ||
			anchor.end - anchor.start >= 40 ||
			typeof anchor.excerpt !== "string"
		)
			reject("Invalid line selection");
		const { reader, snapshot } = await this.source(subject, anchor.snapshotId);
		const entry = snapshot[anchor.side].find(
			(e) => e.path === anchor.path && e.sha256 === anchor.blobSha256 && e.state === "text",
		);
		if (!entry) reject("Selected source is not retained");
		if (entry.bytes === null || entry.bytes > 1024 * 1024) reject("Selected source exceeds display capacity");
		const bytes = await reader.readExact(anchor.snapshotId, {
			snapshotId: anchor.snapshotId,
			side: anchor.side,
			path: anchor.path,
			sha256: anchor.blobSha256,
		});
		let excerpt: string;
		try {
			excerpt = new TextDecoder("utf-8", { fatal: true }).decode(lineExcerpt(bytes, anchor.start, anchor.end));
		} catch {
			reject("Selected original lines unavailable");
		}
		if (Buffer.byteLength(excerpt) > 16000) reject("Selection too large");
		// The service supplies the excerpt from original bytes, not client prose.
		return { ...anchor, excerpt };
	}
	async save(subject: VerificationSubject, edit: ResultReviewEdit): Promise<ResultReviewReceipt> {
		if (
			!edit ||
			Object.keys(edit).sort().join() !== "anchor,body,deliveryId,expectedRevision,kind,operationId" ||
			!id(edit.operationId) ||
			!hash(edit.deliveryId) ||
			!Number.isSafeInteger(edit.expectedRevision) ||
			edit.expectedRevision < 0 ||
			typeof edit.body !== "string" ||
			Buffer.byteLength(edit.body) > 8000 ||
			!["comment", "note", "later", "select"].includes(edit.kind) ||
			(edit.kind === "comment" && !edit.body.trim()) ||
			(["later", "select"].includes(edit.kind) && edit.body !== "") ||
			(edit.kind !== "comment" && edit.anchor?.kind !== "general")
		)
			reject("Invalid private review edit");
		const shown = await this.deps.deliveries.read(subject);
		const key = verificationKey(subject),
			requestHash = payloadHash(canonicalJSON(edit));
		const old =
			this.deps.store.userVerifications.reviewOperation(key, edit.operationId) ??
			this.deps.store.userVerifications.reviewRejection(key, edit.operationId);
		if (old) {
			if (old.hash !== requestHash) reject("Operation content changed");
			await this.deps.store.durable();
			this.deps.deliveries.readNow(subject);
			return old.entry;
		}
		try {
			if (shown.deliveryId !== edit.deliveryId) reject("Result changed; refresh first");
			const anchor = await this.anchor(subject, edit.anchor);
			const entry: ResultReviewEntry = {
				subject,
				...edit,
				anchor,
				revision: edit.expectedRevision + 1,
				ownerSessionId: shown.ownerSessionId,
				at: Date.now(),
			};
			await this.deps.store.durable();
			this.deps.store.userVerifications.saveReview(key, requestHash, entry, () => this.revalidate(shown));
			await this.deps.store.durable();
			this.revalidate(shown);
			return entry;
		} catch (error) {
			if (!(error instanceof OperationRejected)) throw error;
			// The entered handler has finished. Persist either its original effect or an exact refusal.
			const saved = this.deps.store.userVerifications.reviewOperation(key, edit.operationId);
			if (saved) {
				await this.deps.store.durable();
				this.deps.deliveries.readNow(subject);
				return saved.entry;
			}
			const refusal = { ...edit, subject, state: "rejected" as const, reason: error.message };
			this.deps.store.userVerifications.rejectReview(key, requestHash, refusal, () => {
				this.deps.deliveries.readNow(subject);
			});
			await this.deps.store.durable();
			this.deps.deliveries.readNow(subject);
			return refusal;
		}
	}
}
