import type { SQLInputValue } from "node:sqlite";
import type { DurableOperation, WorkflowConfirmationPayload } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { canonicalJSON } from "./operation-journal.ts";

/** Append-only authority history, in the existing missions.sqlite replica/durability lane. */
export const WORKFLOW_CONFIRMATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS workflow_approvals (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE,
 mission_id TEXT NOT NULL, operation TEXT NOT NULL, record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workflow_approval_latest ON workflow_approvals(mission_id, sequence);
CREATE TABLE IF NOT EXISTS reviewer_consents (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE,
 mission_id TEXT NOT NULL, operation TEXT NOT NULL, record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reviewer_consent_latest ON reviewer_consents(mission_id, sequence);
`;

export interface WorkflowConfirmationRecord {
	operationId: string;
	kind: WorkflowConfirmationPayload["purpose"];
	missionId: string;
	confirmed: WorkflowConfirmationPayload;
	createdAt: number;
}
interface Port {
	one(sql: string, ...params: SQLInputValue[]): Record<string, SQLInputValue> | undefined;
	run(sql: string, ...params: SQLInputValue[]): void;
	transaction<T>(work: () => T): T;
	durable(): Promise<void>;
}
const table = (consent: boolean) => (consent ? "reviewer_consents" : "workflow_approvals");

export class WorkflowConfirmationStore {
	private readonly port: Port;
	constructor(port: Port) {
		this.port = port;
	}
	latest(missionId: string, consent: boolean): WorkflowConfirmationRecord | undefined {
		const row = this.port.one(
			`SELECT record FROM ${table(consent)} WHERE mission_id=? ORDER BY sequence DESC LIMIT 1`,
			missionId,
		);
		return row ? JSON.parse(String(row.record)) : undefined;
	}
	/** Exact entered-effect lookup only, never a projection of matching current state. */
	lookup(op: DurableOperation): WorkflowConfirmationRecord | undefined {
		for (const name of ["workflow_approvals", "reviewer_consents"]) {
			const row = this.port.one(`SELECT operation,record FROM ${name} WHERE operation_id=?`, op.operationId);
			if (!row) continue;
			if (row.operation !== canonicalJSON(op)) throw new Conflict("Conflicting confirmation operation");
			return JSON.parse(String(row.record));
		}
		return undefined;
	}
	append(
		op: DurableOperation,
		payload: WorkflowConfirmationPayload,
		revalidate: () => void,
	): WorkflowConfirmationRecord {
		return this.port.transaction(() => {
			const existing = this.lookup(op);
			if (existing) return existing;
			revalidate();
			const consent = op.kind.startsWith("review-consent");
			if ((this.latest(op.targetId, consent)?.operationId ?? null) !== payload.expectedPriorOperationId)
				throw new Conflict("Confirmation prior record changed");
			if (op.kind.endsWith("revoke") && payload.expectedPriorOperationId === null)
				throw new Conflict("Nothing to revoke");
			const record: WorkflowConfirmationRecord = {
				operationId: op.operationId,
				kind: payload.purpose,
				missionId: op.targetId,
				confirmed: structuredClone(payload),
				createdAt: Date.now(),
			};
			this.port.run(
				`INSERT INTO ${table(consent)}(operation_id,mission_id,operation,record) VALUES(?,?,?,?)`,
				op.operationId,
				op.targetId,
				canonicalJSON(op),
				JSON.stringify(record),
			);
			return record;
		});
	}
	durable(): Promise<void> {
		return this.port.durable();
	}
}
