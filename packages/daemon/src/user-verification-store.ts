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
`;
interface Port {
	one(sql: string, ...params: SQLInputValue[]): Record<string, SQLInputValue> | undefined;
	run(sql: string, ...params: SQLInputValue[]): void;
	transaction<T>(work: () => T): T;
}

/** App-owned rows in canonical missions.sqlite. No task, approval or integration writes. */
export class UserVerificationStore {
	private readonly port: Port;
	constructor(port: Port) {
		this.port = port;
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
