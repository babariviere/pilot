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
/**
 * Largest saved map. It protects disk use: every save stores a full copy, so a mission's history is
 * about revisions × this size. Chosen from the Pilot Day mission (71 saves, 27 settled questions at
 * ~1.2 KB each, 46 KB in total): room for about 150 settled questions. The planner reads a compact
 * map (settled questions as one line each), so this size does not reach the model.
 */
export const PLAN_STATE_LIMIT = 192 * 1024;
interface Port {
	one(sql: string, ...params: SQLInputValue[]): Record<string, SQLInputValue> | undefined;
	run(sql: string, ...params: SQLInputValue[]): void;
	transaction<T>(work: () => T): T;
}
/** Append-only native mission planning state. Shares the existing SQLite transaction and replica. */
export class MissionPlanStore {
	private readonly port: Port;
	/** The last planning save Pilot refused, per mission, until one is accepted. Memory only: Unstick reads it. */
	private readonly refusals = new Map<string, { kind: string; reason: string; at: number }>();
	constructor(port: Port) {
		this.port = port;
	}
	refused(missionId: string, refusal: { kind: string; reason: string } | null): void {
		if (refusal) this.refusals.set(missionId, { ...refusal, at: Date.now() });
		else this.refusals.delete(missionId);
	}
	refusal(missionId: string): { kind: string; reason: string; at: number } | undefined {
		return this.refusals.get(missionId);
	}
	/** Amendments require a separately reviewed task-update adapter, never duplicate creation. */
	hasPublication(id: string): boolean {
		return !!this.port.one(
			"SELECT 1 FROM mission_plans WHERE mission_id=? AND json_extract(state,'$.publication') IS NOT NULL LIMIT 1",
			id,
		);
	}
	/** Whether a saved plan revision bound this interview round to a plan-ask topic or a plan review. */
	boundRound(id: string, questionSetRevision: number): boolean {
		return !!this.port.one(
			"SELECT 1 FROM mission_plans WHERE mission_id=? AND (json_extract(state,'$.round.questionSetRevision')=? OR json_extract(state,'$.review.questionSetRevision')=?) LIMIT 1",
			id,
			questionSetRevision,
			questionSetRevision,
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
			const bytes = Buffer.byteLength(JSON.stringify(state));
			if (bytes > PLAN_STATE_LIMIT) {
				const settled = Buffer.byteLength(JSON.stringify(state.questions.filter((q) => q.resolution)));
				throw new Conflict(
					`Planning state exceeds ${PLAN_STATE_LIMIT / 1024} KiB: this save is ${Math.ceil(bytes / 1024)} KiB, and settled questions use ${Math.ceil(settled / 1024)} KiB that stay. Shorten or merge open questions, fog or sources.`,
				);
			}
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
