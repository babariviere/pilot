/** Shares the control-memory worker's connection and transaction boundary with its audit log. */
import type { DatabaseSync } from "node:sqlite";
import type { ControlAuthorization, ControlAuthorizationsResponse } from "@pilot/protocol";
import {
	type ControlAuthorizationCreate,
	type ControlAuthorizationUse,
	checkAuthorization,
} from "./control-authorizations.ts";

export class ControlAuthorizationsDisk {
	private readonly db: DatabaseSync;
	constructor(db: DatabaseSync) {
		this.db = db;
		db.exec(`
		 CREATE TABLE IF NOT EXISTS authorizations (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
		 CREATE TABLE IF NOT EXISTS authorization_revocations (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
		 CREATE TABLE IF NOT EXISTS authorization_uses (operation TEXT PRIMARY KEY, authorization TEXT NOT NULL, follow_ups INTEGER NOT NULL, budget REAL NOT NULL);
		 CREATE INDEX IF NOT EXISTS authorization_uses_id ON authorization_uses(authorization);
		`);
		for (const table of ["authorizations", "authorization_revocations", "authorization_uses"])
			db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'append only'); END;
			 CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'append only'); END;`);
	}
	get(id: string): ControlAuthorization | undefined {
		const row = this.db
			.prepare(`SELECT a.payload, r.at AS revoked_at,
		 (SELECT coalesce(sum(follow_ups),0) FROM authorization_uses WHERE authorization=a.id) AS follow_ups,
		 (SELECT coalesce(sum(budget),0) FROM authorization_uses WHERE authorization=a.id) AS budget
		 FROM authorizations a LEFT JOIN authorization_revocations r ON r.id=a.id WHERE a.id=?`)
			.get(id);
		if (!row) return undefined;
		return {
			...JSON.parse(String(row.payload)),
			...(row.revoked_at === null ? {} : { revokedAt: Number(row.revoked_at) }),
			usage: { followUps: Number(row.follow_ups), budgetUsd: Number(row.budget) },
		};
	}
	create(record: ControlAuthorizationCreate): ControlAuthorization {
		const prior = this.get(record.id);
		if (prior) return prior;
		if (Buffer.byteLength(JSON.stringify(record)) > 32_000) throw new Error("Authorization exceeds 32 KB");
		this.db.prepare("INSERT INTO authorizations VALUES (?,?)").run(record.id, JSON.stringify(record));
		return this.get(record.id)!;
	}
	revoke(id: string, at = Date.now()): boolean {
		if (!this.get(id)) return false;
		return (
			Number(this.db.prepare("INSERT OR IGNORE INTO authorization_revocations VALUES (?,?)").run(id, at).changes) > 0
		);
	}
	page(after = "", limit = 40): ControlAuthorizationsResponse {
		if (typeof after !== "string" || after.length > 128 || !Number.isInteger(limit) || limit < 1 || limit > 100)
			throw new Error("Invalid authorization page");
		const rows = this.db
			.prepare("SELECT id FROM authorizations WHERE id>? ORDER BY id LIMIT ?")
			.all(after, limit + 1);
		const authorizations = rows.slice(0, limit).map((row) => this.get(String(row.id))!);
		return { authorizations, ...(rows.length > limit ? { next: authorizations.at(-1)!.id } : {}) };
	}
	/** Called inside the same BEGIN IMMEDIATE as the audit's requested row. No refunds on uncertain actions. */
	reserve(operation: string, use: ControlAuthorizationUse): void {
		if (this.db.prepare("SELECT 1 FROM authorization_uses WHERE operation=?").get(operation))
			throw new Error("Authorization operation already reserved");
		const record = this.get(use.authorizationId);
		if (!record) throw new Error("Unknown authorization");
		if (
			use.initialStart &&
			this.db
				.prepare("SELECT 1 FROM authorization_uses WHERE authorization=? AND (follow_ups>0 OR budget>0) LIMIT 1")
				.get(record.id)
		)
			use = { ...use, followUps: 1 };
		checkAuthorization(record, use);
		this.db
			.prepare("INSERT INTO authorization_uses VALUES (?,?,?,?)")
			.run(operation, record.id, use.followUps, use.budgetUsd);
	}
}
