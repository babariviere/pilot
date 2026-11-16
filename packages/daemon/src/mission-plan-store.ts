import type { SQLInputValue } from "node:sqlite";
import type { DurableOperation, MissionPlan, MissionTask, PlanSlice } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { canonicalJSON, payloadHash } from "./operation-journal.ts";

/**
 * The body of the task a published slice becomes. Publication writes it and Start compares against it, so both
 * use this one function. Chosen prototypes are listed only when the slice names some: older tasks keep their body.
 */
export function sliceTaskBody(plan: MissionPlan, slice: PlanSlice, briefRevision: number): string {
	const body = `${slice.outcome}\n\nSpec revision: ${briefRevision}\nStories: ${slice.storyIds.join(", ")}\nOwnership: ${slice.owners.join(", ")}\n\nAcceptance:\n${slice.acceptance.map((s) => `- ${s}`).join("\n")}`;
	const chosen = (slice.prototypes ?? []).map((id) => {
		const q = plan.questions.find((q) => q.id === id)!;
		const a = q.prototypeResult!.artifact;
		return `- ${JSON.stringify(q.title)}: artifact ${a.artifactId} revision ${a.revision}; the user's answers: interview ${q.resolution!.id}`;
	});
	return chosen.length
		? `${body}\n\nChosen prototypes. Build what the user chose: read each with the artifact tool's get, and their answers with mission answers.\n${chosen.join("\n")}`
		: body;
}

/** What Start compares for a task a confirmed revision published: any later change outside a revision shows. */
export function publishedDefinition(
	task: Pick<MissionTask, "title" | "body" | "dependsOn" | "assignment" | "decisionIds">,
): string {
	return payloadHash(
		canonicalJSON({
			title: task.title,
			body: task.body ?? "",
			dependsOn: task.dependsOn ?? [],
			assignment: task.assignment ?? null,
			decisionIds: task.decisionIds ?? [],
		}),
	);
}

export const MISSION_PLAN_SCHEMA = `
CREATE TABLE IF NOT EXISTS mission_plans (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, operation_id TEXT NOT NULL UNIQUE,
 operation TEXT NOT NULL, state TEXT NOT NULL,
UNIQUE(mission_id, revision)
);
-- The last planning save Pilot refused, per mission, until one is accepted. Unstick and the planner's
-- Continue read it, so it is kept across restarts.
CREATE TABLE IF NOT EXISTS mission_plan_refusals (
 mission_id TEXT PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL
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
	constructor(port: Port) {
		this.port = port;
	}
	/** Saves or clears the last refused planning save of a mission. */
	refused(missionId: string, refusal: { kind: string; reason: string } | null): void {
		if (refusal)
			this.port.run(
				"INSERT INTO mission_plan_refusals(mission_id,kind,reason,at) VALUES(?,?,?,?) ON CONFLICT(mission_id) DO UPDATE SET kind=excluded.kind, reason=excluded.reason, at=excluded.at",
				missionId,
				refusal.kind,
				refusal.reason,
				Date.now(),
			);
		else this.port.run("DELETE FROM mission_plan_refusals WHERE mission_id=?", missionId);
	}
	refusal(missionId: string): { kind: string; reason: string; at: number } | undefined {
		const row = this.port.one("SELECT kind,reason,at FROM mission_plan_refusals WHERE mission_id=?", missionId);
		return row ? { kind: String(row.kind), reason: String(row.reason), at: Number(row.at) } : undefined;
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
	/**
	 * Saves the plan revision a confirmed mission revision makes, under that confirmation's own key. Runs inside the
	 * confirmation's transaction, which applies once.
	 */
	amend(missionId: string, key: string, mutate: (state: MissionPlan) => MissionPlan): MissionPlan | undefined {
		return this.port.transaction(() => {
			const current = this.get(missionId);
			if (!current) return undefined;
			const state = mutate(structuredClone(current));
			state.revision = current.revision + 1;
			this.port.run(
				"INSERT INTO mission_plans(mission_id,revision,operation_id,operation,state) VALUES(?,?,?,?,?)",
				missionId,
				state.revision,
				key,
				canonicalJSON({ kind: "revision-confirm", key }),
				JSON.stringify(state),
			);
			return state;
		});
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
