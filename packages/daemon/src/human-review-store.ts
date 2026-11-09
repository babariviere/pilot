/** Global feedback in missions.sqlite. No mission/task ownership or request/gate state. */
import { randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import type {
	DurableOperation,
	HumanReviewContent,
	HumanReviewDraft,
	HumanReviewRecord,
	ReviewDispositionPayload,
} from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { canonicalJSON, payloadHash } from "./operation-journal.ts";

export const HUMAN_REVIEW_SCHEMA = `
CREATE TABLE IF NOT EXISTS human_review_drafts (
 id TEXT NOT NULL, revision INTEGER NOT NULL, record TEXT NOT NULL,
 PRIMARY KEY(id,revision)
);
CREATE TABLE IF NOT EXISTS human_reviews (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 operation_id TEXT NOT NULL UNIQUE, selection TEXT NOT NULL, operation TEXT NOT NULL, record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS human_review_selection ON human_reviews(selection,sequence);
CREATE INDEX IF NOT EXISTS human_review_submitted_draft ON human_reviews(json_extract(record,'$.confirmed.feedback.draft.id'));
CREATE TABLE IF NOT EXISTS human_review_targets (
 review_id TEXT NOT NULL, target_digest TEXT NOT NULL, PRIMARY KEY(review_id,target_digest)
);
CREATE INDEX IF NOT EXISTS human_review_target_history ON human_review_targets(target_digest,review_id);
CREATE TABLE IF NOT EXISTS human_review_annotations (
 id TEXT PRIMARY KEY, review_id TEXT NOT NULL, target_digest TEXT NOT NULL,
 successor_id TEXT, resolved_by_record_id TEXT
);
CREATE INDEX IF NOT EXISTS human_review_annotation_target ON human_review_annotations(target_digest,id);
CREATE TABLE IF NOT EXISTS human_review_supersessions (
 prior_id TEXT PRIMARY KEY, successor_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS human_review_extraction_outbox (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, review_id TEXT NOT NULL UNIQUE
);
`;
export type { HumanReviewRecord } from "@pilot/protocol";

interface Port {
	one(sql: string, ...params: SQLInputValue[]): Record<string, SQLInputValue> | undefined;
	all(sql: string, ...params: SQLInputValue[]): Record<string, SQLInputValue>[];
	run(sql: string, ...params: SQLInputValue[]): void;
	transaction<T>(work: () => T): T;
	durable(): Promise<void>;
}
const parse = <T>(row: Record<string, SQLInputValue> | undefined): T | undefined =>
	row ? JSON.parse(String(row.record)) : undefined;
export const targetKey = (target: ReviewDispositionPayload["targets"][number]) => payloadHash(canonicalJSON(target));
export const selectionKey = (targets: ReviewDispositionPayload["targets"]) =>
	payloadHash(canonicalJSON(targets.map(targetKey).sort()));
export function reviewContent(request: HumanReviewContent): HumanReviewContent {
	return structuredClone({
		targets: request.targets,
		disposition: request.disposition,
		body: request.body,
		...(request.feedback ? { feedback: request.feedback } : {}),
	});
}
export class HumanReviewStore {
	private readonly port: Port;
	constructor(port: Port) {
		this.port = port;
	}
	draft(id: string): HumanReviewDraft | undefined {
		return parse(
			this.port.one("SELECT record FROM human_review_drafts WHERE id=? ORDER BY revision DESC LIMIT 1", id),
		);
	}
	private draftSubmitted(id: string): boolean {
		return !!this.port.one(
			"SELECT 1 FROM human_reviews WHERE json_extract(record,'$.confirmed.feedback.draft.id')=? LIMIT 1",
			id,
		);
	}
	saveDraft(
		id: string,
		expectedRevision: number,
		content: HumanReviewContent,
		revalidate: () => void,
	): HumanReviewDraft {
		return this.port.transaction(() => {
			revalidate();
			const prior = this.draft(id);
			if ((prior?.revision ?? 0) !== expectedRevision || this.draftSubmitted(id))
				throw new Conflict("Draft changed or was submitted");
			const draft: HumanReviewDraft = {
				id,
				revision: expectedRevision + 1,
				content: reviewContent(content),
				updatedAt: Date.now(),
				authorOrigin: "native-user-draft",
			};
			this.port.run(
				"INSERT INTO human_review_drafts(id,revision,record) VALUES(?,?,?)",
				id,
				draft.revision,
				JSON.stringify(draft),
			);
			return draft;
		});
	}
	latest(targets: ReviewDispositionPayload["targets"]): HumanReviewRecord | undefined {
		return parse(
			this.port.one(
				"SELECT record FROM human_reviews WHERE selection=? ORDER BY sequence DESC LIMIT 1",
				selectionKey(targets),
			),
		);
	}
	get(id: string): HumanReviewRecord | undefined {
		return parse(this.port.one("SELECT record FROM human_reviews WHERE id=?", id));
	}
	annotationRecord(id: string): HumanReviewRecord | undefined {
		const row = this.port.one("SELECT review_id FROM human_review_annotations WHERE id=?", id);
		return row ? this.get(String(row.review_id)) : undefined;
	}
	/** Shared by every selection containing this exact target. Comments cannot clear blockers. */
	targetState(target: ReviewDispositionPayload["targets"][number]) {
		const key = targetKey(target);
		const latest = this.port.one(
			"SELECT r.id,r.sequence FROM human_reviews r JOIN human_review_targets t ON t.review_id=r.id WHERE t.target_digest=? ORDER BY r.sequence DESC LIMIT 1",
			key,
		);
		const blockers = this.port.all(
			"SELECT r.id FROM human_reviews r JOIN human_review_targets t ON t.review_id=r.id LEFT JOIN human_review_supersessions s ON s.prior_id=r.id WHERE t.target_digest=? AND json_extract(r.record,'$.confirmed.disposition')='request_changes' AND s.prior_id IS NULL ORDER BY r.sequence LIMIT 101",
			key,
		);
		const threads = this.port.all(
			"SELECT id FROM human_review_annotations WHERE target_digest=? AND successor_id IS NULL AND resolved_by_record_id IS NULL ORDER BY id LIMIT 101",
			key,
		);
		return {
			target: key,
			latestRecordId: latest ? String(latest.id) : null,
			sequence: latest ? Number(latest.sequence) : 0,
			blockingReviewIds: blockers.map((r) => String(r.id)),
			unresolvedThreadIds: threads.map((r) => String(r.id)),
			complete: blockers.length <= 100 && threads.length <= 100,
		};
	}
	lookup(op: DurableOperation): HumanReviewRecord | undefined {
		const row = this.port.one("SELECT operation,record FROM human_reviews WHERE operation_id=?", op.operationId);
		if (!row) return undefined;
		if (row.operation !== canonicalJSON(op)) throw new Conflict("Conflicting exact review operation");
		return JSON.parse(String(row.record));
	}
	/** Only the qualified native disposition source calls this after ingress admission. */
	append(op: DurableOperation, request: ReviewDispositionPayload, revalidate: () => void): HumanReviewRecord {
		return this.port.transaction(() => {
			revalidate();
			const existing = this.lookup(op);
			if (existing) return existing;
			if ((this.latest(request.targets)?.id ?? null) !== request.expectedPriorRecordId)
				throw new Conflict("Review prior record changed");
			const feedback = request.feedback;
			if (feedback?.draft) {
				const draft = this.draft(feedback.draft.id);
				const content = reviewContent(request);
				// A draft cannot refer to itself. Submission adds its exact id/revision to the confirmed package.
				if (content.feedback) content.feedback.draft = null;
				if (
					!draft ||
					draft.revision !== feedback.draft.revision ||
					this.draftSubmitted(draft.id) ||
					canonicalJSON(draft.content) !== canonicalJSON(content)
				)
					throw new Conflict("Submitted draft changed");
			}
			const covered = new Set(request.targets.map(targetKey));
			const priorRecord = (id: string) => {
				const record = this.get(id);
				if (
					record?.author.origin !== "native-user" ||
					record.confirmed.targets.some((t) => !covered.has(targetKey(t)))
				)
					throw new Conflict("Feedback history is outside the exact selected comparisons");
				return record;
			};
			if (feedback?.supersedes) {
				priorRecord(feedback.supersedes.recordId);
				if (
					this.port.one("SELECT 1 FROM human_review_supersessions WHERE prior_id=?", feedback.supersedes.recordId)
				)
					throw new Conflict("Review already explicitly superseded");
			}
			const annotation = (id: string) => {
				const row = this.port.one(
					"SELECT review_id,target_digest,successor_id,resolved_by_record_id FROM human_review_annotations WHERE id=?",
					id,
				);
				if (!row || row.successor_id !== null || row.resolved_by_record_id !== null)
					throw new Conflict("Annotation missing, resolved or already superseded");
				const record = this.get(String(row.review_id));
				const original = record?.confirmed.feedback?.annotations.find((a) => a.id === id);
				const target = record?.confirmed.targets.find((t) => t.snapshotId === original?.anchor.snapshotId);
				if (
					record?.author.origin !== "native-user" ||
					!target ||
					targetKey(target) !== row.target_digest ||
					!covered.has(targetKey(target))
				)
					throw new Conflict("Annotation is outside the exact selected comparison");
			};
			const edited = new Set<string>();
			for (const a of feedback?.annotations ?? []) {
				if (this.port.one("SELECT 1 FROM human_review_annotations WHERE id=?", a.id))
					throw new Conflict("Annotation identity already exists");
				if (a.supersedes) {
					if (edited.has(a.supersedes)) throw new Conflict("Duplicate annotation edit");
					edited.add(a.supersedes);
					annotation(a.supersedes);
				}
			}
			for (const id of feedback?.resolveAnnotationIds ?? []) {
				if (edited.has(id)) throw new Conflict("Cannot edit and resolve the same annotation");
				if (!feedback?.annotations.some((a) => a.id === id)) annotation(id);
			}
			const record: HumanReviewRecord = {
				id: randomUUID(),
				operationId: op.operationId,
				createdAt: Date.now(),
				confirmed: structuredClone(request),
				author: { origin: "native-user", assurance: "practical-native-action", producerId: op.producerId },
			};
			this.port.run(
				"INSERT INTO human_reviews(id,operation_id,selection,operation,record) VALUES(?,?,?,?,?)",
				record.id,
				op.operationId,
				selectionKey(request.targets),
				canonicalJSON(op),
				JSON.stringify(record),
			);
			for (const target of request.targets)
				this.port.run(
					"INSERT INTO human_review_targets(review_id,target_digest) VALUES(?,?)",
					record.id,
					targetKey(target),
				);
			for (const a of feedback?.annotations ?? []) {
				const target = request.targets.find((t) => t.snapshotId === a.anchor.snapshotId);
				if (!target) throw new Conflict("Annotation is outside the exact selected comparison");
				this.port.run(
					"INSERT INTO human_review_annotations(id,review_id,target_digest) VALUES(?,?,?)",
					a.id,
					record.id,
					targetKey(target),
				);
				if (a.supersedes)
					this.port.run("UPDATE human_review_annotations SET successor_id=? WHERE id=?", a.id, a.supersedes);
			}
			for (const id of feedback?.resolveAnnotationIds ?? [])
				this.port.run("UPDATE human_review_annotations SET resolved_by_record_id=? WHERE id=?", record.id, id);
			if (feedback?.supersedes)
				this.port.run(
					"INSERT INTO human_review_supersessions(prior_id,successor_id) VALUES(?,?)",
					feedback.supersedes.recordId,
					record.id,
				);
			// Same transaction as original feedback. No extractor, dispatch or provider is started here.
			this.port.run("INSERT INTO human_review_extraction_outbox(review_id) VALUES(?)", record.id);
			return record;
		});
	}
	history(target: ReviewDispositionPayload["targets"][number], after = 0) {
		return this.port
			.all(
				"SELECT r.sequence,r.record FROM human_reviews r JOIN human_review_targets t ON t.review_id=r.id WHERE t.target_digest=? AND r.sequence>? ORDER BY r.sequence LIMIT 50",
				targetKey(target),
				after,
			)
			.map((row) => ({
				sequence: Number(row.sequence),
				record: JSON.parse(String(row.record)) as HumanReviewRecord,
			}));
	}
	outbox(after = 0) {
		return this.port
			.all(
				"SELECT sequence,review_id FROM human_review_extraction_outbox WHERE sequence>? ORDER BY sequence LIMIT 50",
				after,
			)
			.map((row) => ({ sequence: Number(row.sequence), reviewId: String(row.review_id) }));
	}
	durable(): Promise<void> {
		return this.port.durable();
	}
}
