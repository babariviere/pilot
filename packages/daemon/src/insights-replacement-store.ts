import type { DurableOperation, InsightsReplacementLink, InsightsReplacementProgress } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import type { InsightsDb } from "./insights-backlog.ts";
import { canonicalJSON } from "./operation-journal.ts";

// No cascade: deleting a backlog must never remove an old authority/recreation fence.
export const INSIGHTS_REPLACEMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS insights_replacements (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, old_id TEXT UNIQUE NOT NULL,
 successor_id TEXT UNIQUE NOT NULL, project_id TEXT NOT NULL, mission_id TEXT NOT NULL,
 context TEXT NOT NULL, operation_id TEXT UNIQUE NOT NULL, payload_hash TEXT NOT NULL,
 revision INTEGER NOT NULL, result TEXT
);
CREATE INDEX IF NOT EXISTS insights_replacements_scope ON insights_replacements(project_id,mission_id,seq);
`;

/** Host-only deny/ownership ledger. Neither model tools nor passive reads can write it. */
export class InsightsReplacementStore {
	private readonly db: InsightsDb;
	private readonly committing = new Set<string>();
	private retired?: Set<string>;
	constructor(db: InsightsDb) {
		this.db = db;
	}
	link(oldId: string): InsightsReplacementLink | null {
		const row = this.db.one("SELECT * FROM insights_replacements WHERE old_id=?", oldId.toLowerCase());
		return row
			? {
					oldSessionId: String(row.old_id),
					successorSessionId: String(row.successor_id),
					projectId: String(row.project_id),
					missionId: String(row.mission_id),
					context: String(row.context),
					revision: Number(row.revision),
					state: row.result === null ? "fenced" : "replaced",
				}
			: null;
	}
	async readLink(oldId: string): Promise<InsightsReplacementLink | null> {
		const link = this.link(oldId);
		await this.db.durable();
		if (canonicalJSON(link) !== canonicalJSON(this.link(oldId)))
			throw new Conflict("Replacement changed during read");
		return link;
	}
	assertNotRetired(id: string): void {
		this.retired ??= new Set(this.db.all("SELECT old_id FROM insights_replacements").map((r) => String(r.old_id)));
		if (this.retired.has(id.toLowerCase()))
			throw new Conflict("Report superseded or replacement pending; old identity is permanently fenced");
	}
	assertCreate(projectId: string, missionId: string, id: string, operationId: string): void {
		this.assertNotRetired(id);
		const row = this.db.one(
			"SELECT successor_id,operation_id FROM insights_replacements WHERE project_id=? AND mission_id=? ORDER BY seq DESC LIMIT 1",
			projectId,
			missionId,
		);
		if (row && (row.successor_id !== id || row.operation_id !== operationId))
			throw new Conflict("Use the exact retained replacement operation; another report cannot bypass it");
	}
	retainedReferences(projectId: string, missionId: string): string[] {
		return this.db
			.all(
				"SELECT old_id,successor_id FROM insights_replacements WHERE project_id=? AND mission_id=? ORDER BY seq LIMIT 16",
				projectId,
				missionId,
			)
			.flatMap((r) => [String(r.old_id), String(r.successor_id)]);
	}
	/** Completed exact-context chains only. A pending link grants no substitute identity. */
	resolves(oldId: string, successorId: string, projectId: string, missionId: string, context: string): boolean {
		let id = oldId;
		for (let depth = 0; depth <= 16; depth++) {
			if (id === successorId) return true;
			if (this.committing.has(id)) return false;
			const link = this.link(id);
			if (
				link?.state !== "replaced" ||
				link.context !== context ||
				link.projectId !== projectId ||
				link.missionId !== missionId
			)
				return false;
			id = link.successorSessionId;
		}
		return false;
	}
	private row(op: DurableOperation, oldId: string) {
		const row = this.db.one("SELECT * FROM insights_replacements WHERE old_id=?", oldId);
		if (
			row &&
			(row.operation_id !== op.operationId ||
				row.payload_hash !== op.payloadHash ||
				row.successor_id !== op.targetId)
		)
			throw new Conflict("Another immutable replacement owns this report; use its retained receipt");
		return row;
	}
	async lookup(op: DurableOperation, oldId: string) {
		const row = this.row(op, oldId);
		await this.db.durable();
		// Do not select a newer, potentially unsaved row after this barrier.
		if (canonicalJSON(row) !== canonicalJSON(this.row(op, oldId)))
			throw new Conflict("Replacement changed during lookup");
		return row
			? {
					link: this.link(oldId)!,
					result: row.result === null ? null : (JSON.parse(String(row.result)) as InsightsReplacementProgress),
				}
			: null;
	}
	assertNoUncertainReview(oldId: string): void {
		if (
			this.db.one(
				"SELECT 1 FROM insights_runs WHERE session_id=? AND state IN ('preparing','ready','sent','unknown','interrupted')",
				oldId,
			)
		)
			throw new Conflict("old_review_uncertain");
	}
	async fence(
		op: DurableOperation,
		p: { oldSessionId: string; projectId: string; missionId: string; context: string },
		guard: () => void,
	): Promise<void> {
		this.db.transaction(() => {
			guard();
			this.db.validateMission(p.missionId, p.projectId);
			if (this.row(op, p.oldSessionId)) throw new Conflict("Replacement already entered; lookup only");
			this.assertNoUncertainReview(p.oldSessionId);
			const count = this.db.one("SELECT COUNT(*) AS n FROM insights_replacements")!;
			if (Number(count.n) >= 1024) throw new Conflict("replacement_capacity");
			const prior = this.db.one(
				"SELECT successor_id,result,context FROM insights_replacements WHERE project_id=? AND mission_id=? ORDER BY seq DESC LIMIT 1",
				p.projectId,
				p.missionId,
			);
			if (prior && (prior.successor_id !== p.oldSessionId || prior.result === null || prior.context !== p.context))
				throw new Conflict("replacement_chain_changed");
			if (
				Number(
					this.db.one(
						"SELECT COUNT(*) AS n FROM insights_replacements WHERE project_id=? AND mission_id=?",
						p.projectId,
						p.missionId,
					)!.n,
				) >= 16
			)
				throw new Conflict("replacement_chain_capacity");
			this.db.run(
				"INSERT INTO insights_replacements(old_id,successor_id,project_id,mission_id,context,operation_id,payload_hash,revision,result) VALUES (?,?,?,?,?,?,?,1,NULL)",
				p.oldSessionId,
				op.targetId,
				p.projectId,
				p.missionId,
				p.context,
				op.operationId,
				op.payloadHash,
			);
		});
		this.retired?.add(p.oldSessionId);
		await this.db.durable();
		this.row(op, p.oldSessionId);
	}
	async complete(
		op: DurableOperation,
		oldId: string,
		result: InsightsReplacementProgress,
		guard: () => void,
	): Promise<void> {
		this.db.transaction(() => {
			guard();
			const row = this.row(op, oldId);
			if (row?.revision !== 1 || row.result !== null) throw new Conflict("Replacement revision changed");
			this.db.run(
				"UPDATE insights_replacements SET revision=2,result=? WHERE old_id=? AND revision=1",
				JSON.stringify(result),
				oldId,
			);
		});
		this.committing.add(oldId);
		await this.db.durable();
		this.committing.delete(oldId);
	}
}
