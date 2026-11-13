import type { SQLInputValue } from "node:sqlite";
import type { UserVerification, UserVerificationReceipt } from "@pilot/protocol";
import { OperationRejected } from "./operation-journal.ts";

export const USER_VERIFICATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS user_verifications (
 sequence INTEGER PRIMARY KEY, subject_key TEXT NOT NULL, operation_id TEXT UNIQUE NOT NULL, record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS user_verification_subject ON user_verifications(subject_key, sequence);
CREATE TABLE IF NOT EXISTS user_verification_intents (
 operation_id TEXT PRIMARY KEY, subject_key TEXT NOT NULL, record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS user_verification_pending ON user_verification_intents(subject_key);
CREATE TABLE IF NOT EXISTS delivery_discovery_baselines (
 id INTEGER PRIMARY KEY CHECK(id=1), source_sequence INTEGER NOT NULL
);
`;
/** Derived source index only. Payloads and assessments stay in their canonical tables. */
export const DELIVERY_SOURCE_SCHEMA = `
CREATE TABLE delivery_sources (
 sequence INTEGER PRIMARY KEY,
 source_key TEXT UNIQUE NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX delivery_sources_by_task ON delivery_sources(task_id, sequence);
INSERT INTO delivery_sources(source_key,task_id)
 SELECT 'completion:'||task_id,task_id FROM task_completions ORDER BY task_id;
INSERT INTO delivery_sources(source_key,task_id)
 SELECT 'non-code:'||task_id,task_id FROM task_non_code_deliveries ORDER BY task_id;
INSERT INTO delivery_sources(source_key,task_id)
 SELECT 'submission:'||record_id,task_id FROM task_delivery_evidence WHERE record_type='submission' ORDER BY sequence;
CREATE TABLE delivery_source_clock(id INTEGER PRIMARY KEY CHECK(id=1), sequence INTEGER NOT NULL);
INSERT INTO delivery_source_clock SELECT 1,COALESCE(MAX(sequence),0) FROM delivery_sources;
`;
interface Port {
	one(sql: string, ...params: SQLInputValue[]): Record<string, SQLInputValue> | undefined;
	all(sql: string, ...params: SQLInputValue[]): Record<string, SQLInputValue>[];
	run(sql: string, ...params: SQLInputValue[]): void;
	transaction<T>(work: () => T): T;
}

/** App-owned rows in canonical missions.sqlite. No task, approval or integration writes. */
export class UserVerificationStore {
	private readonly port: Port;
	constructor(port: Port) {
		this.port = port;
	}
	sourceCursor(): number {
		return Number(this.port.one("SELECT sequence FROM delivery_source_clock WHERE id=1")!.sequence);
	}
	/** Called inside the canonical delivery writer's transaction. A normal table
	 * counter is replicated, unlike SQLite's internal rowid/sequence bookkeeping.
	 */
	recordSource(key: string, taskId: string): void {
		this.port.run("UPDATE delivery_source_clock SET sequence=sequence+1 WHERE id=1");
		this.port.run("INSERT INTO delivery_sources VALUES(?,?,?)", this.sourceCursor(), key, taskId);
	}
	/** First use only. Never advanced by list, reopen, pagination or filtering. */
	discoveryBaseline(): number {
		const saved = this.port.one("SELECT source_sequence FROM delivery_discovery_baselines WHERE id=1");
		if (saved) return Number(saved.source_sequence);
		return this.port.transaction(() => {
			this.port.run("INSERT OR IGNORE INTO delivery_discovery_baselines VALUES(1,?)", this.sourceCursor());
			return Number(
				this.port.one("SELECT source_sequence FROM delivery_discovery_baselines WHERE id=1")!.source_sequence,
			);
		});
	}
	discoveryCandidates(projectId: string, after: number, through: number, limit: number) {
		return this.port
			.all(
				`SELECT t.id task_id,t.mission_id,t.title,MAX(s.sequence) source_sequence
			FROM delivery_sources s JOIN tasks t ON t.id=s.task_id JOIN missions m ON m.id=t.mission_id
			WHERE m.project_id=? AND s.sequence>? AND s.sequence<=? GROUP BY t.id
			ORDER BY source_sequence,t.id LIMIT ?`,
				projectId,
				after,
				through,
				limit,
			)
			.map((r) => ({
				taskId: String(r.task_id),
				missionId: String(r.mission_id),
				title: String(r.title),
				sequence: Number(r.source_sequence),
			}));
	}
	current(key: string): UserVerification | null {
		const r = this.port.one(
			"SELECT record FROM user_verifications WHERE subject_key=? ORDER BY sequence DESC LIMIT 1",
			key,
		);
		return r ? JSON.parse(String(r.record)) : null;
	}
	operation(id: string): UserVerificationReceipt | null {
		const r = this.port.one("SELECT record FROM user_verification_intents WHERE operation_id=?", id);
		return r ? JSON.parse(String(r.record)) : null;
	}
	pending(key: string): string | null {
		const r = this.port.one(
			"SELECT operation_id FROM user_verification_intents WHERE subject_key=? AND json_extract(record,'$.state')='pending' LIMIT 1",
			key,
		);
		return r ? String(r.operation_id) : null;
	}
	reserve(key: string, record: UserVerificationReceipt) {
		this.port.transaction(() => {
			if (this.pending(key) || (this.current(key)?.revision ?? 0) !== record.intent.expectedRevision)
				throw new OperationRejected("Verification changed or is uncertain; refresh or Check only");
			if (Number(this.port.one("SELECT COUNT(*) n FROM user_verification_intents")!.n) >= 16384)
				throw new OperationRejected("Verification receipt storage is full");
			this.port.run(
				"INSERT INTO user_verification_intents VALUES(?,?,?)",
				record.operationId,
				key,
				JSON.stringify(record),
			);
		});
	}
	settle(key: string, record: UserVerificationReceipt) {
		this.port.transaction(() => {
			const saved = this.operation(record.operationId);
			if (saved?.state !== "pending" || saved.payloadHash !== record.payloadHash)
				throw new Error("Verification reservation changed");
			this.port.run(
				"INSERT INTO user_verifications(subject_key,operation_id,record) VALUES(?,?,?)",
				key,
				record.operationId,
				JSON.stringify(record.verification),
			);
			this.port.run(
				"UPDATE user_verification_intents SET record=? WHERE operation_id=?",
				JSON.stringify({ ...record, state: "accepted" }),
				record.operationId,
			);
		});
	}
}
