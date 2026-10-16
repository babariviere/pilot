/** Synchronous implementation, used only by critical-review-worker.ts. */
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CriticalReviewRecord, CriticalReviewRecords } from "@pilot/protocol";
import { canonicalJSON } from "./operation-journal.ts";

export const reviewId = /^[A-Za-z0-9_-]{1,128}$/;
const kinds = new Set<keyof CriticalReviewRecords>([
	"target",
	"evidence",
	"context",
	"run",
	"finding",
	"approval",
	"reservation",
	"disposition",
]);
export function validateReviewRecord(record: CriticalReviewRecord): void {
	if (
		record?.schemaVersion !== 1 ||
		!kinds.has(record.kind) ||
		![record.id, record.hostId, record.projectId].every((id) => typeof id === "string" && reviewId.test(id)) ||
		!Array.isArray(record.sourceIds) ||
		record.sourceIds.length > 128 ||
		!record.sourceIds.every((id) => typeof id === "string" && reviewId.test(id)) ||
		!Number.isSafeInteger(record.createdAt) ||
		record.createdAt < 0
	)
		throw new Error("Invalid critical review record/version");
	if (Buffer.byteLength(JSON.stringify(record)) > 4 * 1024 * 1024) throw new Error("Review record exceeds limit");
	if (record.kind === "target" && !["session", "pull_request"].includes(record.snapshot?.kind))
		throw new Error("Invalid target");
	if (
		record.kind === "evidence" &&
		(record.sealed !== true ||
			!/^[a-f0-9]{64}$/.test(record.sha256) ||
			!Array.isArray(record.entries) ||
			record.entries.length > 20_000)
	)
		throw new Error("Invalid evidence");
	if (record.kind === "context" && (!record.policyVersion || !Array.isArray(record.sources)))
		throw new Error("Invalid context");
	if (
		record.kind === "run" &&
		![record.targetId, record.evidenceId, record.contextId].every((id) => reviewId.test(id))
	)
		throw new Error("Invalid run references");
	if (
		record.kind === "finding" &&
		(!["critical", "high", "medium", "low"].includes(record.severity) ||
			!["high", "medium"].includes(record.confidence) ||
			!record.evidence?.length)
	)
		throw new Error("Invalid finding");
	if (record.kind === "approval" && (record.action !== "app_allowance" || !record.ownerId || !record.allowance))
		throw new Error("Invalid approval");
	if (record.kind === "reservation" && (!record.reserved || !reviewId.test(record.callId)))
		throw new Error("Invalid reservation");
	if (record.kind === "disposition" && !["accepted", "dismissed", "questioned", "reopened"].includes(record.value))
		throw new Error("Invalid disposition");
}

export class CriticalReviewDisk {
	readonly db: DatabaseSync;
	constructor(file: string) {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		const parent = lstatSync(dirname(file));
		if (!parent.isDirectory() || parent.isSymbolicLink() || parent.mode & 0o077)
			throw new Error("Review storage must be private");
		try {
			if (lstatSync(file).isSymbolicLink()) throw new Error("Review database symlink denied");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		this.db = new DatabaseSync(file);
		chmodSync(file, 0o600);
		this.db.exec(
			"PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;",
		);
		const version = Number(this.db.prepare("PRAGMA user_version").get()!.user_version);
		if (version > 1) {
			this.db.close();
			throw new Error("Unsupported critical review database version");
		}
		this.db.exec(`BEGIN IMMEDIATE;
			CREATE TABLE IF NOT EXISTS review_records(kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));
			CREATE TABLE IF NOT EXISTS review_sources(source TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(source,kind,id));
			PRAGMA user_version=1; COMMIT;`);
	}
	transaction<T>(action: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = action();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	put(record: CriticalReviewRecord): CriticalReviewRecord {
		validateReviewRecord(record);
		return this.transaction(() => this.insert(record));
	}
	insert(record: CriticalReviewRecord): CriticalReviewRecord {
		const body = canonicalJSON(record);
		const existing = this.db
			.prepare("SELECT body FROM review_records WHERE kind=? AND id=?")
			.get(record.kind, record.id);
		if (existing) {
			if (existing.body !== body) throw new Error("Immutable review ID conflict");
			return record;
		}
		if (Number(this.db.prepare("SELECT COUNT(*) AS n FROM review_records").get()!.n) >= 10_000)
			throw new Error("Review record capacity reached");
		this.db.prepare("INSERT INTO review_records VALUES(?,?,?)").run(record.kind, record.id, body);
		for (const source of new Set(record.sourceIds))
			this.db.prepare("INSERT INTO review_sources VALUES(?,?,?)").run(source, record.kind, record.id);
		return record;
	}
	get(kind: string, id: string): CriticalReviewRecord | undefined {
		const row = this.db.prepare("SELECT body FROM review_records WHERE kind=? AND id=?").get(kind, id);
		return row ? JSON.parse(row.body as string) : undefined;
	}
	list(kind: string, after: string, limit: number): CriticalReviewRecord[] {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid review page size");
		return this.db
			.prepare("SELECT body FROM review_records WHERE kind=? AND id>? ORDER BY id LIMIT ?")
			.all(kind, after, limit)
			.map((row) => JSON.parse(row.body as string));
	}
	close(): void {
		this.db.close();
	}
}
