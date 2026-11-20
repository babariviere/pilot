import { signal } from "nsh";
import type {
	ResultAnchor,
	ResultDiff,
	ResultReviewEdit,
	ResultReviewEntry,
	ResultReviewPage,
	ResultReviewReceipt,
} from "../../../../packages/protocol/src/missions/result-review.ts";
import { call, windowId } from "../../sources/bridge";
import type { DeliveredWork } from "../delivery/deliveryContract";
import { deliveryKey } from "../delivery/deliveryFeed";

export type { ResultAnchor, ResultDiff, ResultReviewEdit, ResultReviewEntry, ResultReviewPage };
export interface ReviewReply {
	state: "saved" | "rejected" | "unknown";
	operationId: string;
	receipt: ResultReviewReceipt | null;
}
export interface ResultReviewSource {
	read(work: DeliveredWork, beforeRevision?: number): Promise<{ data: ResultReviewPage; pending: string[] }>;
	diff(work: DeliveredWork, snapshotId: string): Promise<ResultDiff>;
	save(work: DeliveredWork, edit: Omit<ResultReviewEdit, "operationId">): Promise<ReviewReply>;
	check(operationId: string): Promise<ReviewReply>;
}
/** App-owned adapter. No URLs or filesystem paths cross from the preview VM. */
export function connectedResultReview(): ResultReviewSource | undefined {
	const window = windowId();
	if (!window) return undefined;
	const invoke = async <T>(name: string, args: unknown): Promise<T> => {
		const reply = await call<T>(window, name, args);
		if (!reply.ok) throw Error(reply.refusal);
		return reply.snapshot;
	};
	const request = <T>(
		work: DeliveredWork,
		kind: string,
		snapshotId: string | null = null,
		edit: ResultReviewEdit | null = null,
		beforeRevision: number | null = null,
	) =>
		invoke<T>("day.resultReview", {
			subject: work.subject,
			deliveryId: work.deliveryId,
			kind,
			snapshotId,
			edit,
			beforeRevision,
		});
	return {
		read: (work, before) => request(work, "read", null, null, before ?? null),
		diff: async (work, snapshotId) => (await request<{ data: ResultDiff }>(work, "diff", snapshotId)).data,
		save: async (work, edit) => {
			let id: string;
			try {
				id = (await invoke<{ operationId: string }>("day.resultReview.id", {})).operationId;
			} catch {
				throw Object.assign(Error("Could not prepare save"), { notSent: true });
			}
			try {
				return await request(work, "save", null, { ...edit, operationId: id });
			} catch {
				throw Object.assign(Error("Save not confirmed"), { operationId: id });
			}
		},
		check: (operationId) => invoke("day.resultReview.check", { operationId }),
	};
}
export interface ReviewDraft {
	body: string;
	kind: "comment" | "note";
	anchor: ResultAnchor;
}
/** Unsent words stay keyed to the exact result version, not to a recycled diff row. */
export const reviewDrafts = signal<Record<string, ReviewDraft>>({});
export const reviewKey = (work: DeliveredWork) => `${deliveryKey(work.subject)}#${work.deliveryId}`;
export function keepReviewDraft(key: string, draft: ReviewDraft) {
	reviewDrafts.update((all) => ({ ...all, [key]: draft }));
}
export function forgetReviewDraft(key: string) {
	reviewDrafts.update((all) => {
		const next = { ...all };
		delete next[key];
		return next;
	});
}
export function captureReviewDrafts(): string[] {
	return Object.entries(reviewDrafts())
		.filter(([, draft]) => draft.body !== "")
		.map(([key, draft]) => `review:${key}\n${JSON.stringify(draft)}`);
}
export function restoreReviewDrafts(entries: readonly string[]) {
	const restored: Record<string, ReviewDraft> = {};
	for (const entry of entries) {
		if (!entry.startsWith("review:")) continue;
		const at = entry.indexOf("\n");
		try {
			const draft = JSON.parse(entry.slice(at + 1)) as ReviewDraft;
			if (typeof draft.body === "string" && (draft.kind === "note" || draft.kind === "comment") && draft.anchor)
				restored[entry.slice(7, at)] = draft;
		} catch {
			/* Unreadable drafts never become sends. */
		}
	}
	reviewDrafts.set(restored);
}
export function anchorLabel(anchor: ResultAnchor): string {
	return anchor.kind === "general"
		? "General comment"
		: anchor.kind === "section"
			? `Section: ${anchor.section}`
			: `${anchor.path} · ${anchor.side === "before" ? "old" : "new"} lines ${anchor.start}–${anchor.end}`;
}
/** The service supplies excerpt bytes; location identity is the immutable blob and range. */
export function sameReviewAnchor(left: ResultAnchor, right: ResultAnchor): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind === "general") return true;
	if (left.kind === "section") return right.kind === "section" && left.section === right.section;
	return (
		right.kind === "lines" &&
		left.snapshotId === right.snapshotId &&
		left.side === right.side &&
		left.path === right.path &&
		left.start === right.start &&
		left.end === right.end &&
		left.blobSha256 === right.blobSha256
	);
}
/** Send-back context includes comments and original bytes, never personal notes. */
export function revisionContext(entries: ResultReviewEntry[]): string {
	return entries
		.filter((e) => e.kind === "comment")
		.map((e) => {
			const a = e.anchor;
			return `${anchorLabel(a)}\nResult ${e.deliveryId}\nSaved comment ${e.operationId}\n${a.kind === "lines" ? `Comparison ${a.snapshotId}\n${a.excerpt}\n` : ""}${e.body}`;
		})
		.join("\n\n");
}
