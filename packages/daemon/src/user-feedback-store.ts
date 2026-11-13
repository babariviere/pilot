/** User feedback shares MissionStore's transaction, disk replica and durability boundary. */
import type { UserFeedback, UserFeedbackPage } from "@pilot/protocol";
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
`;

export const USER_FEEDBACK_LIMITS = { textBytes: 8192, page: 20 } as const;

/** Saved feedback, append only. Nothing here edits, routes or deletes it. */
export class UserFeedbackStore {
	private readonly db: FeedbackDb;
	constructor(db: FeedbackDb) {
		this.db = db;
	}

	byOperation(operationId: string): UserFeedback | undefined {
		const row = this.db.one("SELECT record FROM user_feedback WHERE operation_id=?", operationId);
		return row ? JSON.parse(String(row.record)) : undefined;
	}

	/** Newest first, strictly older than `before`. */
	page(before: number, limit: number): UserFeedbackPage {
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

	add(feedback: UserFeedback): UserFeedback {
		return this.db.transaction(() => {
			if (this.db.one("SELECT 1 FROM user_feedback WHERE id=? OR operation_id=?", feedback.id, feedback.operationId))
				throw new Conflict("Feedback already exists. Look up its exact receipt; do not resend.");
			this.db.run(
				"INSERT INTO user_feedback(id,operation_id,record) VALUES(?,?,?)",
				feedback.id,
				feedback.operationId,
				JSON.stringify(feedback),
			);
			return feedback;
		});
	}
}
