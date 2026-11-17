/** User feedback shares MissionStore's transaction, disk replica and durability boundary. */
import type { UserFeedback, UserFeedbackWork } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import type { KnowledgeDb } from "./project-knowledge-store.ts";

type FeedbackDb = Pick<KnowledgeDb, "all" | "one" | "run" | "transaction">;

export const USER_FEEDBACK_SCHEMA = `
CREATE TABLE IF NOT EXISTS user_feedback (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE,
 operation_id TEXT NOT NULL UNIQUE,
 record TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS user_feedback_investigation_operation
 ON user_feedback(json_extract(record,'$.investigation.operation.operationId'));
CREATE UNIQUE INDEX IF NOT EXISTS user_feedback_investigation_session
 ON user_feedback(json_extract(record,'$.investigation.operation.targetId'));
CREATE TABLE IF NOT EXISTS user_feedback_work (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 feedback_id TEXT NOT NULL,
 operation_id TEXT NOT NULL UNIQUE,
 record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS user_feedback_work_feedback ON user_feedback_work(feedback_id, sequence);
`;

/** work: saved steps per feedback item. Every triage, fix, link and mark counts; none is evicted. */
export const USER_FEEDBACK_LIMITS = { textBytes: 8192, page: 20, work: 32 } as const;

type Saved = UserFeedback & { sequence: number };

/** Saved feedback and the user's steps on it, append only. Only the user's remove step deletes an item. */
export class UserFeedbackStore {
	private readonly db: FeedbackDb;
	constructor(db: FeedbackDb) {
		this.db = db;
	}

	byOperation(operationId: string): UserFeedback | undefined {
		const row = this.db.one("SELECT record FROM user_feedback WHERE operation_id=?", operationId);
		return row ? JSON.parse(String(row.record)) : undefined;
	}

	get(id: string): Saved | undefined {
		const row = this.db.one("SELECT sequence, record FROM user_feedback WHERE id=?", id);
		return row ? { ...(JSON.parse(String(row.record)) as UserFeedback), sequence: Number(row.sequence) } : undefined;
	}

	/** Newest first, strictly older than `before`. */
	page(before: number, limit: number): { items: Saved[]; more: boolean; before: number | null } {
		const rows = this.db.all(
			"SELECT sequence, record FROM user_feedback WHERE sequence<? ORDER BY sequence DESC LIMIT ?",
			before,
			limit + 1,
		);
		const items = rows
			.slice(0, limit)
			.map((row) => ({ ...(JSON.parse(String(row.record)) as UserFeedback), sequence: Number(row.sequence) }));
		const more = rows.length > limit;
		return { items, more, before: more ? items.at(-1)!.sequence : null };
	}

	/** The newest saved feedback, for a triage agent's duplicate check. */
	recent(limit: number): Saved[] {
		return this.page(Number.MAX_SAFE_INTEGER, limit).items;
	}

	/** One item's steps, oldest first. */
	work(feedbackId: string): UserFeedbackWork[] {
		return this.db
			.all("SELECT record FROM user_feedback_work WHERE feedback_id=? ORDER BY sequence", feedbackId)
			.map((row) => JSON.parse(String(row.record)) as UserFeedbackWork);
	}

	workByOperation(operationId: string): UserFeedbackWork | undefined {
		const row = this.db.one("SELECT record FROM user_feedback_work WHERE operation_id=?", operationId);
		return row ? JSON.parse(String(row.record)) : undefined;
	}

	/** Exact saved native triage/fix admission, not agent-authored provenance. */
	metricsScope(operationId: string, sessionId: string): { origin: UserFeedback["origin"] } | undefined {
		const row = this.db.one(
			"SELECT f.record AS feedback, w.record AS work FROM user_feedback_work w JOIN user_feedback f ON f.id=w.feedback_id WHERE w.operation_id=?",
			operationId,
		);
		if (!row) return undefined;
		const work = JSON.parse(String(row.work)) as UserFeedbackWork;
		if ((work.kind !== "triage" && work.kind !== "fix") || work.sessionId !== sessionId) return undefined;
		return { origin: (JSON.parse(String(row.feedback)) as UserFeedback).origin };
	}

	/** Saves one step. `check` runs inside the transaction with the item's current steps. */
	addWork(feedbackId: string, work: UserFeedbackWork, check: (current: UserFeedbackWork[]) => void): UserFeedbackWork {
		return this.db.transaction(() => {
			if (!this.db.one("SELECT 1 FROM user_feedback WHERE id=?", feedbackId))
				throw new Conflict("This feedback no longer exists");
			if (this.db.one("SELECT 1 FROM user_feedback_work WHERE operation_id=?", work.operationId))
				throw new Conflict("This step already exists. Look up its exact receipt; do not resend.");
			const current = this.work(feedbackId);
			if (current.length >= USER_FEEDBACK_LIMITS.work)
				throw new Conflict(`This feedback already has ${USER_FEEDBACK_LIMITS.work} steps`);
			check(current);
			this.db.run(
				"INSERT INTO user_feedback_work(feedback_id,operation_id,record) VALUES(?,?,?)",
				feedbackId,
				work.operationId,
				JSON.stringify(work),
			);
			return work;
		});
	}

	add(feedback: UserFeedback): UserFeedback {
		return this.db.transaction(() => {
			if (this.db.one("SELECT 1 FROM user_feedback WHERE id=? OR operation_id=?", feedback.id, feedback.operationId))
				throw new Conflict("Feedback already exists. Look up its exact receipt; do not resend.");
			const claim = feedback.investigation?.operation;
			if (
				claim &&
				this.db.one(
					"SELECT 1 FROM user_feedback WHERE json_extract(record,'$.investigation.operation.operationId')=? OR json_extract(record,'$.investigation.operation.targetId')=?",
					claim.operationId,
					claim.targetId,
				)
			)
				throw new Conflict("This investigation operation or chat is already claimed by another feedback item");
			this.db.run(
				"INSERT INTO user_feedback(id,operation_id,record) VALUES(?,?,?)",
				feedback.id,
				feedback.operationId,
				JSON.stringify(feedback),
			);
			return feedback;
		});
	}

	/** Deletes one item and its steps together. Their chats and missions are not touched. */
	remove(id: string): void {
		this.db.transaction(() => {
			if (!this.db.one("SELECT 1 FROM user_feedback WHERE id=?", id))
				throw new Conflict("This feedback no longer exists");
			this.db.run("DELETE FROM user_feedback_work WHERE feedback_id=?", id);
			this.db.run("DELETE FROM user_feedback WHERE id=?", id);
		});
	}
}
