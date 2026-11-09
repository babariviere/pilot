import type { SQLInputValue } from "node:sqlite";
import type { AssistanceRecord, AssistanceRequest, HumanActionCommand, HumanActionRecord } from "@pilot/protocol";
import { canonicalJSON, payloadHash } from "./operation-journal.ts";

export const attentionDigest = (value: unknown): string => payloadHash(canonicalJSON(value));
export const ATTENTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS decision_assistance (
 request_id TEXT PRIMARY KEY, request TEXT NOT NULL, record TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS human_actions (
 id TEXT PRIMARY KEY, record TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS human_action_operations (
 operation_id TEXT PRIMARY KEY, command TEXT NOT NULL, record TEXT NOT NULL
);
`;

interface Port {
	one(sql: string, ...params: SQLInputValue[]): Record<string, SQLInputValue> | undefined;
	run(sql: string, ...params: SQLInputValue[]): void;
	transaction<T>(work: () => T): T;
	durable(): Promise<void>;
}

/** Only accessed by AttentionService, which checks authority and validates inputs. No work dispatch. */
export class AttentionStore {
	private readonly port: Port;
	constructor(port: Port) {
		this.port = port;
	}
	durable(): Promise<void> {
		return this.port.durable();
	}
	/** Refuse growth, never evict uncertain requests or exact completion receipts. */
	capacity(): boolean {
		return (
			Number(
				this.port.one(
					"SELECT (SELECT COUNT(*) FROM decision_assistance) + (SELECT COUNT(*) FROM human_action_operations) n",
				)!.n,
			) < 4096
		);
	}
	assistance(id: string): AssistanceRecord | undefined {
		const row = this.port.one("SELECT record FROM decision_assistance WHERE request_id=?", id);
		return row ? JSON.parse(String(row.record)) : undefined;
	}
	enter(request: AssistanceRequest): void {
		this.port.transaction(() => {
			if (this.assistance(request.requestId)) throw new Error("Assistance identity already entered");
			this.port.run(
				"INSERT INTO decision_assistance VALUES(?,?,?)",
				request.requestId,
				canonicalJSON(request),
				JSON.stringify({ request, state: "entered" } satisfies AssistanceRecord),
			);
		});
	}
	settle(record: AssistanceRecord): void {
		this.port.transaction(() => {
			const prior = this.assistance(record.request.requestId);
			if (prior?.state !== "entered" || canonicalJSON(prior.request) !== canonicalJSON(record.request))
				throw new Error("Assistance identity changed");
			this.port.run(
				"UPDATE decision_assistance SET record=? WHERE request_id=?",
				JSON.stringify(record),
				record.request.requestId,
			);
		});
	}
	humanAction(id: string): HumanActionRecord | undefined {
		const row = this.port.one("SELECT record FROM human_actions WHERE id=?", id);
		return row ? JSON.parse(String(row.record)) : undefined;
	}
	operation(id: string): { command: HumanActionCommand; record: HumanActionRecord } | undefined {
		const row = this.port.one("SELECT command,record FROM human_action_operations WHERE operation_id=?", id);
		return row ? { command: JSON.parse(String(row.command)), record: JSON.parse(String(row.record)) } : undefined;
	}
	/** A synchronous transaction makes validation, expected-prior CAS and exact receipt indivisible. */
	write(command: HumanActionCommand, build: () => HumanActionRecord): HumanActionRecord {
		return this.port.transaction(() => {
			if (this.operation(command.operationId)) throw new Error("Operation already recorded");
			const record = build();
			this.port.run(
				"INSERT INTO human_action_operations VALUES(?,?,?)",
				command.operationId,
				canonicalJSON(command),
				JSON.stringify(record),
			);
			this.port.run(
				"INSERT INTO human_actions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record",
				record.id,
				JSON.stringify(record),
			);
			return record;
		});
	}
}
