import type { SQLInputValue } from "node:sqlite";
import type { PlanningRound, PlanningWorkerBinding } from "@pilot/kernel";
import type { DurableOperation, MissionInterview } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { canonicalJSON, payloadHash } from "./operation-journal.ts";

export const PLANNING_WORKER_SCHEMA = `
CREATE TABLE IF NOT EXISTS planning_workers (mission_id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL UNIQUE, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS planning_worker_calls (operation_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, call_id TEXT NOT NULL, operation TEXT NOT NULL, UNIQUE(mission_id,call_id));
`;
export interface PlanningWorkerState {
	version: 1;
	binding: PlanningWorkerBinding;
	creation: DurableOperation;
	goal: string;
	configurationDigest: string;
	revision: number;
	phase: "setup" | "active" | "holding" | "held" | "continuing";
	hold: PlanningRound | null;
	pendingHold: { operationId: string; authority: string } | null;
	continuation: { operation: DurableOperation; entered: boolean } | null;
}
interface Port {
	one(sql: string, ...params: SQLInputValue[]): Record<string, SQLInputValue> | undefined;
	run(sql: string, ...params: SQLInputValue[]): void;
	transaction<T>(work: () => T): T;
	changed(missionId: string): void;
}
export class PlanningWorkerStore {
	private readonly port: Port;
	constructor(port: Port) {
		this.port = port;
	}
	get(missionId: string): PlanningWorkerState | undefined {
		const row = this.port.one("SELECT record FROM planning_workers WHERE mission_id=?", missionId);
		return row ? JSON.parse(String(row.record)) : undefined;
	}
	enrollment(id: string): PlanningWorkerState | undefined {
		const row = this.port.one("SELECT record FROM planning_workers WHERE enrollment_id=?", id);
		return row ? JSON.parse(String(row.record)) : undefined;
	}
	create(work: () => PlanningWorkerState): PlanningWorkerState {
		return this.port.transaction(() => {
			const state = work();
			this.port.run(
				"INSERT INTO planning_workers VALUES(?,?,?)",
				state.binding.missionId,
				state.binding.enrollmentId,
				canonicalJSON(state),
			);
			return state;
		});
	}
	change(missionId: string, revision: number, work: (state: PlanningWorkerState) => void): PlanningWorkerState {
		const result = this.port.transaction(() => {
			const state = this.get(missionId);
			if (!state || state.revision !== revision) throw new Conflict("Planning worker changed");
			work(state);
			state.revision++;
			this.port.run("UPDATE planning_workers SET record=? WHERE mission_id=?", canonicalJSON(state), missionId);
			return state;
		});
		this.port.changed(missionId);
		return result;
	}
	call(missionId: string, callId: string): DurableOperation | undefined {
		const row = this.port.one(
			"SELECT operation FROM planning_worker_calls WHERE mission_id=? AND call_id=?",
			missionId,
			callId,
		);
		return row ? JSON.parse(String(row.operation)) : undefined;
	}
	operation(missionId: string, operationId: string): DurableOperation | undefined {
		const row = this.port.one(
			"SELECT operation FROM planning_worker_calls WHERE mission_id=? AND operation_id=?",
			missionId,
			operationId,
		);
		return row ? JSON.parse(String(row.operation)) : undefined;
	}
	retain(missionId: string, callId: string, op: DurableOperation): void {
		this.port.transaction(() => {
			const old = this.call(missionId, callId);
			if (old) {
				if (canonicalJSON(old) !== canonicalJSON(op)) throw new Conflict("Planning call identity changed");
				return;
			}
			const count = this.port.one("SELECT COUNT(*) n FROM planning_worker_calls WHERE mission_id=?", missionId);
			if (Number(count?.n) >= 512) throw new Conflict("Planning call storage is full");
			this.port.run(
				"INSERT INTO planning_worker_calls VALUES(?,?,?,?)",
				op.operationId,
				missionId,
				callId,
				canonicalJSON(op),
			);
		});
	}
	/** Runs in the SAME transaction as the explicit human submission. Draft saves do nothing. */
	submitted(interview: MissionInterview, submission: DurableOperation): void {
		const state = this.get(interview.fence.missionId),
			s = interview.submission;
		if (!state || !s || state.phase !== "held" || !state.hold) return;
		if (
			state.hold.fence.questionSetRevision !== s.fence.questionSetRevision ||
			state.hold.fence.enrollmentId !== s.fence.enrollmentId ||
			state.hold.fence.ownerSessionId !== s.fence.ownerSessionId
		)
			return;
		const request = {
			purpose: "interview-continue",
			fence: s.fence,
			submissionOperationId: s.operationId,
			submissionDigest: s.digest,
		};
		const payload = canonicalJSON(request);
		const operation: DurableOperation = {
			schemaVersion: 1,
			operationId: `planning-${submission.operationId}`,
			producerId: state.binding.enrollmentId,
			sequence: state.revision + 1,
			origin: state.binding.host,
			destination: state.binding.host,
			targetId: state.binding.missionId,
			kind: request.purpose,
			payload,
			payloadHash: payloadHash(payload),
			bindingId: state.hold.contextDigest,
			bindingGeneration: 1,
		};
		this.retain(state.binding.missionId, `$continue:${submission.operationId}`, operation);
		this.change(state.binding.missionId, state.revision, (next) => {
			next.continuation = { operation, entered: false };
		});
	}
}
