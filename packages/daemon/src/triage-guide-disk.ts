import type { DatabaseSync } from "node:sqlite";
import type { TrackedKind, TriageCorrection, TriageGuide } from "@pilot/protocol";

/** Synchronous methods run only inside the tracked-items worker. */
export class TriageGuideDisk {
	private db: DatabaseSync;
	constructor(db: DatabaseSync) {
		this.db = db;
		db.exec(
			`CREATE TABLE IF NOT EXISTS triage_attempts(project_id TEXT,kind TEXT,day TEXT,used INTEGER,last_at INTEGER,PRIMARY KEY(project_id,kind));`,
		);
		db.exec(`CREATE TABLE IF NOT EXISTS triage_corrections (
		 seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL);
		 CREATE INDEX IF NOT EXISTS triage_corrections_scope ON triage_corrections(project_id, kind, seq DESC);
		 CREATE TABLE IF NOT EXISTS triage_guides (
		 project_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, updated_at INTEGER NOT NULL,
		 through_seq INTEGER NOT NULL, PRIMARY KEY(project_id,kind));`);
		// Move all surviving legacy examples, preserving order. The caller's migration transaction makes this atomic.
		if (db.prepare("SELECT name FROM sqlite_master WHERE name='slack_corrections'").get()) {
			db.exec(`INSERT INTO triage_corrections(project_id,kind,value)
			 SELECT project_id,'slack',value FROM slack_corrections ORDER BY seq;
			 DROP TABLE slack_corrections;`);
		}
	}
	append(projectId: string, kind: TrackedKind, value: TriageCorrection): void {
		this.db
			.prepare("INSERT INTO triage_corrections(project_id,kind,value) VALUES (?,?,?)")
			.run(projectId, kind, JSON.stringify(value));
		this.db
			.prepare(`DELETE FROM triage_corrections WHERE project_id=? AND seq NOT IN
		 (SELECT seq FROM triage_corrections WHERE project_id=? ORDER BY seq DESC LIMIT 500)`)
			.run(projectId, projectId);
	}
	reserve(projectId: string, kind: TrackedKind, now: number): number {
		const day = new Date(now).toISOString().slice(0, 10);
		const previous = this.db
			.prepare("SELECT * FROM triage_attempts WHERE project_id=? AND kind=?")
			.get(projectId, kind);
		if (previous && now < Number(previous.last_at) + 300_000) return Number(previous.last_at) + 300_000;
		if (previous?.day === day && Number(previous.used) >= 48) return Date.parse(`${day}T00:00:00Z`) + 86_400_000;
		this.db
			.prepare(
				`INSERT INTO triage_attempts VALUES (?,?,?,1,?) ON CONFLICT(project_id,kind) DO UPDATE SET day=excluded.day,used=CASE WHEN day=excluded.day THEN used+1 ELSE 1 END,last_at=excluded.last_at`,
			)
			.run(projectId, kind, day, now);
		return 0;
	}
	corrections(projectId: string, kind: TrackedKind): TriageCorrection[] {
		return this.db
			.prepare("SELECT value FROM triage_corrections WHERE project_id=? AND kind=? ORDER BY seq DESC LIMIT 500")
			.all(projectId, kind)
			.map((row) => JSON.parse(String(row.value)));
	}
	context(projectId: string, kind: TrackedKind) {
		return {
			guide: this.guide(projectId, kind),
			corrections: this.db
				.prepare("SELECT value FROM triage_corrections WHERE project_id=? AND kind=? ORDER BY seq DESC LIMIT 5")
				.all(projectId, kind)
				.map((row) => JSON.parse(String(row.value)) as TriageCorrection),
		};
	}
	guide(projectId: string, kind: TrackedKind): TriageGuide {
		const row = this.db.prepare("SELECT * FROM triage_guides WHERE project_id=? AND kind=?").get(projectId, kind);
		return {
			kind,
			text: String(row?.text ?? ""),
			updatedAt: Number(row?.updated_at ?? 0),
			throughSeq: Number(row?.through_seq ?? 0),
		};
	}
	input(projectId: string, kind: TrackedKind) {
		const guide = this.guide(projectId, kind);
		const rows = this.db
			.prepare(
				"SELECT seq,value FROM triage_corrections WHERE project_id=? AND kind=? AND seq>? ORDER BY seq LIMIT 64",
			)
			.all(projectId, kind, guide.throughSeq);
		return {
			guide,
			corrections: rows.map((row) => JSON.parse(String(row.value)) as TriageCorrection),
			throughSeq: Number(rows.at(-1)?.seq ?? guide.throughSeq),
		};
	}
	save(
		projectId: string,
		kind: TrackedKind,
		text: string,
		throughSeq: number,
		expectedSeq: number,
		now: number,
	): void {
		if (this.guide(projectId, kind).throughSeq !== expectedSeq) return;
		this.db
			.prepare(`INSERT INTO triage_guides VALUES (?,?,?,?,?) ON CONFLICT(project_id,kind)
		 DO UPDATE SET text=excluded.text, updated_at=excluded.updated_at, through_seq=excluded.through_seq`)
			.run(projectId, kind, text, now, throughSeq);
	}
}
