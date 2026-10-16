/** Host-only retention/erase actions. No message-text authorization and no automatic eviction. */
import type { CriticalReviewRecord } from "@pilot/protocol";
import type { CriticalReviewDisk } from "./critical-review-disk.ts";

export const REVIEW_RETENTION = Object.freeze({
	rawMs: 30 * 86400_000,
	resultMs: 90 * 86400_000,
	projectBytes: 1024 ** 3,
	hostBytes: 5 * 1024 ** 3,
});
export interface ReviewUnavailable {
	kind: string;
	id: string;
	reason: "expired" | "erased";
}
export class ReviewRetentionDisk {
	private readonly disk: CriticalReviewDisk;
	constructor(disk: CriticalReviewDisk) {
		this.disk = disk;
	}
	get db() {
		return this.disk.db;
	}
	quota(projectId: string, bytes: number): void {
		if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid retained byte count");
		const rows = this.db
			.prepare(
				`SELECT project,bytes FROM review_retention UNION ALL SELECT project,bytes FROM review_staging UNION ALL SELECT project,bytes FROM review_unavailable WHERE pending=1`,
			)
			.all();
		let host = bytes,
			project = bytes;
		for (const row of rows) {
			host += Number(row.bytes);
			if (row.project === projectId) project += Number(row.bytes);
		}
		if (host > REVIEW_RETENTION.hostBytes || project > REVIEW_RETENTION.projectBytes)
			throw new Error("Review storage quota full; explicitly delete or unpin eligible objects");
	}
	stage(id: string, project: string, bytes: number): void {
		this.disk.transaction(() => {
			const existing = this.db.prepare("SELECT project,bytes FROM review_staging WHERE id=?").get(id);
			if (!existing && this.db.prepare("SELECT id FROM review_records WHERE kind='evidence' AND id=?").get(id))
				throw new Error("Evidence already sealed");
			if (existing && existing.project !== project) throw new Error("Capture owner changed");
			if (existing && bytes <= Number(existing.bytes)) throw new Error("Capture already in progress");
			if (!existing && Number(this.db.prepare("SELECT COUNT(*) AS n FROM review_staging").get()!.n) >= 16)
				throw new Error("Capture capacity reached");
			this.quota(project, bytes - Number(existing?.bytes ?? 0));
			this.db
				.prepare("INSERT INTO review_staging VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET bytes=excluded.bytes")
				.run(id, project, bytes);
		});
	}
	track(record: CriticalReviewRecord, body: string): void {
		if (
			record.sourceIds.some((source) =>
				this.db.prepare("SELECT source FROM review_erased_sources WHERE source=?").get(source),
			)
		)
			throw new Error("Source access erased");
		if (this.db.prepare("SELECT id FROM review_unavailable WHERE kind=? AND id=?").get(record.kind, record.id))
			throw new Error("Review ID unavailable; cannot resurrect erased content");
		// Every retained copy inherits source provenance, so erasure can find context/findings too.
		const references: Array<[string, string]> = [];
		if (record.kind === "run")
			references.push(["target", record.targetId], ["context", record.contextId], ["evidence", record.evidenceId]);
		if (record.kind === "context")
			for (const source of record.sources) references.push(["evidence", source.citation.manifestId]);
		if (record.kind === "finding") {
			references.push(["run", record.runId]);
			for (const cite of [...record.evidence, ...record.counterevidence])
				references.push(["evidence", cite.manifestId]);
		}
		if (record.kind === "approval" || record.kind === "reservation") references.push(["run", record.runId]);
		if (record.kind === "disposition") references.push(["finding", record.findingId]);
		for (const [kind, id] of references) {
			const parent = this.disk.get(kind, id);
			if (!parent || parent.sourceIds.some((source) => !record.sourceIds.includes(source)))
				throw new Error("Missing linked erasure provenance");
		}
		if (record.kind === "evidence") this.db.prepare("DELETE FROM review_staging WHERE id=?").run(record.id);
		const bytes =
			Buffer.byteLength(body) +
			(record.kind === "evidence" ? record.entries.reduce((sum, entry) => sum + entry.bytes, 0) : 0);
		this.quota(record.projectId, bytes);
		this.db
			.prepare("INSERT INTO review_retention VALUES(?,?,?,?,?,0,0)")
			.run(record.kind, record.id, record.projectId, bytes, record.createdAt);
	}
	available(kind: string, id: string, now: number): boolean {
		const row = this.db.prepare("SELECT * FROM review_retention WHERE kind=? AND id=?").get(kind, id);
		return (
			!!row &&
			(!!row.pinned ||
				!!row.active ||
				now < Number(row.last_use) + (kind === "evidence" ? REVIEW_RETENTION.rawMs : REVIEW_RETENTION.resultMs))
		);
	}
	action(kind: string, id: string, action: "use" | "pin" | "unpin" | "activate" | "release", now: number): void {
		if (!this.available(kind, id, now)) throw new Error("Review object unavailable");
		const column = action === "use" ? "last_use" : action === "pin" || action === "unpin" ? "pinned" : "active";
		const value = action === "use" ? now : action === "pin" || action === "activate" ? 1 : 0;
		this.db.prepare(`UPDATE review_retention SET ${column}=? WHERE kind=? AND id=?`).run(value, kind, id);
	}
	private remove(kind: string, id: string, reason: ReviewUnavailable["reason"]): void {
		const row = this.db.prepare("SELECT * FROM review_retention WHERE kind=? AND id=?").get(kind, id);
		if (!row) return;
		this.db
			.prepare("INSERT OR IGNORE INTO review_unavailable VALUES(?,?,?,?,?,1)")
			.run(kind, id, reason, row.project, row.bytes);
		this.db.prepare("DELETE FROM review_records WHERE kind=? AND id=?").run(kind, id);
		this.db.prepare("DELETE FROM review_sources WHERE kind=? AND id=?").run(kind, id);
		this.db.prepare("DELETE FROM review_retention WHERE kind=? AND id=?").run(kind, id);
	}
	erase(source: string): void {
		this.disk.transaction(() => {
			this.db.prepare("INSERT OR IGNORE INTO review_erased_sources VALUES(?)").run(source);
			const rows = this.db.prepare("SELECT kind,id FROM review_sources WHERE source=?").all(source);
			for (const row of rows) this.remove(String(row.kind), String(row.id), "erased");
		});
		this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	}
	expire(now: number): void {
		this.disk.transaction(() => {
			for (const row of this.db
				.prepare(
					"SELECT kind,id FROM review_retention WHERE pinned=0 AND active=0 AND last_use+CASE WHEN kind='evidence' THEN ? ELSE ? END<=?",
				)
				.all(REVIEW_RETENTION.rawMs, REVIEW_RETENTION.resultMs, now))
				this.remove(String(row.kind), String(row.id), "expired");
		});
		this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	}
	pending(): ReviewUnavailable[] {
		return this.db
			.prepare("SELECT kind,id,reason FROM review_unavailable WHERE pending=1 LIMIT 100")
			.all() as unknown as ReviewUnavailable[];
	}
	finish(kind: string, id: string): void {
		this.db.prepare("UPDATE review_unavailable SET pending=0,bytes=0 WHERE kind=? AND id=?").run(kind, id);
	}
}
