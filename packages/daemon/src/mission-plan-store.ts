import type { SQLInputValue } from "node:sqlite";
import type { DurableOperation, MissionPlan } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { canonicalJSON } from "./operation-journal.ts";

export const MISSION_PLAN_SCHEMA = `
CREATE TABLE IF NOT EXISTS mission_plans (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, operation_id TEXT NOT NULL UNIQUE,
 operation TEXT NOT NULL, state TEXT NOT NULL,
 UNIQUE(mission_id, revision)
);
`;
interface Port {
	one(sql: string, ...params: SQLInputValue[]): Record<string, SQLInputValue> | undefined;
	run(sql: string, ...params: SQLInputValue[]): void;
	transaction<T>(work: () => T): T;
}
/** Append-only native mission planning state. Shares the existing SQLite transaction and replica. */
export class MissionPlanStore {
	private readonly port: Port;
	constructor(port: Port) {
		this.port = port;
	}
	/** Amendments require a separately reviewed task-update adapter, never duplicate creation. */
	hasPublication(id: string): boolean {
		return !!this.port.one(
			"SELECT 1 FROM mission_plans WHERE mission_id=? AND json_extract(state,'$.publication') IS NOT NULL LIMIT 1",
			id,
		);
	}
	get(id: string, revision?: number): MissionPlan | undefined {
		const row =
			revision === undefined
				? this.port.one("SELECT state FROM mission_plans WHERE mission_id=? ORDER BY revision DESC LIMIT 1", id)
				: this.port.one("SELECT state FROM mission_plans WHERE mission_id=? AND revision=?", id, revision);
		return row ? JSON.parse(String(row.state)) : undefined;
	}
	lookup(op: DurableOperation): MissionPlan | undefined {
		const row = this.port.one("SELECT operation,state FROM mission_plans WHERE operation_id=?", op.operationId);
		if (!row) return undefined;
		if (row.operation !== canonicalJSON(op)) throw new Conflict("Conflicting planning operation");
		return JSON.parse(String(row.state));
	}
	write(op: DurableOperation, revision: number, mutate: (state: MissionPlan | undefined) => MissionPlan): MissionPlan {
		return this.port.transaction(() => {
			const prior = this.lookup(op);
			if (prior) return prior;
			const current = this.get(op.targetId);
			if ((current?.revision ?? 0) !== revision) throw new Conflict("Planning revision changed");
			const state = mutate(current);
			state.revision = revision + 1;
			if (Buffer.byteLength(JSON.stringify(state)) > 48 * 1024) throw new Conflict("Planning state exceeds 48 KiB");
			this.port.run(
				"INSERT INTO mission_plans(mission_id,revision,operation_id,operation,state) VALUES(?,?,?,?,?)",
				op.targetId,
				state.revision,
				op.operationId,
				canonicalJSON(op),
				JSON.stringify(state),
			);
			return state;
		});
	}
}
