import type { SQLInputValue } from "node:sqlite";
import type { PlanningRound, PlanningWorkerBinding } from "@pilot/kernel";
import type { DurableOperation, MissionInterview } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { canonicalJSON, payloadHash } from "./operation-journal.ts";
import { trace } from "./trace.ts";

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
	phase: "setup" | "active" | "holding" | "held" | "continuing" | "revisiting" | "discussing";
	hold: PlanningRound | null;
	/** `round`: the held round's fingerprint basis (see authority(binding, true)); older records lack it. */
	pendingHold: { operationId: string; authority: string; round?: string; roundParts?: Record<string, string> } | null;
	/**
	 * Each part of the held round's fingerprint, hashed on its own, so a round that stalls says which part changed
	 * (see roundChanges). Kept beside the hold: the kernel holds the round exactly. Older holds lack it.
	 */
	holdParts?: { operationId: string; parts: Record<string, string> };
	continuation: { operation: DurableOperation; entered: boolean } | null;
	/** Entered Start is lookup-only across restart, even when no kernel receipt can be found. */
	start?: { operation: DurableOperation; sessionId: string; taskId: string; admitted: boolean };
	/** The Linear issue or Slack request in New this mission was planned from, as the user saw it. */
	request?: { itemId: string; revision: number };
	/** Tasks Pilot started by rule after the user's Start, one per task. A crash while `starting` leaves a lookup only. */
	autoStarts?: Array<{
		operationId: string;
		sessionId: string;
		taskId: string;
		state: "starting" | "admitted" | "failed";
		reason?: string;
		at: number;
	}>;
	/** Explicit native check-up admission. An entered but unacknowledged turn is lookup-only. */
	revisit?: { operation: DurableOperation; admitted: boolean };
	/** User topic input, never a Start or permission to release a hold. */
	discussion?: { operation: DurableOperation; admitted: boolean };
	/** The waiting round a user's interview comment released, kept so recovery looks up the same input. */
	feedback?: { operationId: string; hold: PlanningRound };
	/**
	 * Read-only research chats started for ready research questions, by question ID. A question is
	 * started once; its findings go to the planner as one exact planning input.
	 */
	research?: Record<string, PlanningResearch>;
	/**
	 * Prototypes a builder asked for its own published task, by task ID. Pilot makes each in a read-only chat and
	 * sends the result to that builder. No planning map change and no user confirmation.
	 */
	taskPrototypes?: Record<string, TaskPrototype>;
	/**
	 * The user's questions about interview questions, by the operation that asked. A read-only chat
	 * answers each one; the waiting round and the planner are left alone.
	 */
	asks?: Record<string, QuestionAsk>;
	/** Unstick's repair agent: one read-only Diagnostics chat that reads the planner's chat and proposes one fix. */
	repair?: PlanningRepair;
	/**
	 * Thread messages the planning agent could not take when the user sent them, in the order sent. Each goes with
	 * the next planning input that can carry it: the user's submit or Continue, or one turn of its own once the
	 * agent is idle and no round waits (threadDelivery).
	 */
	threadQueue?: WaitingThreadMessage[];
	/** The planning input Pilot made to deliver waiting thread messages, kept until it is admitted. */
	threadDelivery?: DurableOperation;
}
/** One thread message waiting for the planning agent. */
export interface WaitingThreadMessage {
	/** The user's thread-send operation. */
	operationId: string;
	topicId: string;
	title: string;
	text: string;
	at: number;
	/** The planning input that carries it, once Pilot chose one. */
	carriedBy?: string;
	/** That input was admitted: the agent has it. Kept a while so that input's content stays the same on recovery. */
	delivered?: boolean;
	/** A thread chat's handoff (`operationId` is the handoff ID, `text` its content), not a user message. */
	handoff?: true;
}
export interface PlanningRepair {
	operationId: string;
	/** starting: chat not yet created. looking: chat works. proposed or failed: done. */
	state: "starting" | "looking" | "proposed" | "failed";
	sessionId: string | null;
	/** The planning state the agent looked at. Its fix applies only while this still matches. */
	basis: string;
	startedAt: number;
	proposal?: MissionFix;
	reason?: string;
}
/** One proposed fix. Only the user's Apply acts on it, through the usual operations. */
export interface MissionFix {
	fix: "continue" | "planner-note" | "drop-earlier-answers" | "code-repair" | "none";
	cause: string;
	/** Only with planner-note: the note Continue planning sends. */
	note?: string;
	certainty: "low" | "medium" | "high";
	/** Short labels of what the agent read. */
	evidence: string[];
}
export interface QuestionAsk {
	questionId: string;
	text: string;
	/** starting: chat not yet created. running: chat works. answered or failed: done. */
	state: "starting" | "running" | "answered" | "failed";
	sessionId: string | null;
	answer?: string;
	reason?: string;
	askedAt: number;
}
export interface PlanningResearch {
	questionDigest: string;
	/** starting: chat not yet created. running: chat works. reporting: findings saved, input not confirmed. */
	state: "starting" | "running" | "reporting" | "reported" | "failed";
	sessionId: string | null;
	/** Planning input carrying the findings, once saved. */
	operation?: DurableOperation;
	/** The research chat's final answer, limited, saved before admission so recovery sends the same text. */
	report?: string;
	reason?: string;
	/** Research chats started for this question so far (1 when absent). */
	attempts?: number;
	/** Earlier chats of this question, oldest first. Each attempt adds one, so their number is limited by attempts. */
	earlierSessionIds?: string[];
	/** The Knowledge entry Pilot saved the findings in, word for word, linked to the mission. */
	knowledge?: { id: string; revision: number; synopsis: string };
	/** "prototype": a prototype chat for a prototype question. Absent: research. */
	kind?: "prototype";
	/** When the prototype chat started. */
	startedAt?: number;
	/** The prototype the chat published, linked to the mission at this revision. */
	artifact?: { sessionId: string; artifactId: string; revision: number };
	/** The prototype of the attempt before, which the next chat starts from. */
	earlier?: { sessionId: string; artifactId: string; revision: number };
}
/** Limits of a builder's task prototype: request text and prototypes per task. No time limit. */
export const TASK_PROTOTYPE = { question: 4000, attempts: 3 } as const;
/** One prototype a builder asked for its task. */
export interface TaskPrototype {
	/** The builder's own ID for this request. The same ID again reads it; nothing starts twice. */
	requestId: string;
	builderSessionId: string;
	/** What to compare and which variants, in the builder's words. */
	question: string;
	model: string;
	thinking?: string;
	/**
	 * requested: waits for a chat slot. starting: Pilot is creating the chat. running: the chat works.
	 * reporting: the result is saved, the builder does not have it yet. reported: the builder has it. failed: ended early.
	 */
	state: "requested" | "starting" | "running" | "reporting" | "reported" | "failed";
	sessionId: string | null;
	requestedAt: number;
	/** Prototype chats made for this task so far, this one included. */
	attempts: number;
	startedAt?: number;
	/** The chat's final answer, limited. */
	report?: string;
	reason?: string;
	/** The NSH artifact the chat published, linked to the task at this revision. */
	artifact?: { sessionId: string; artifactId: string; revision: number };
	/** The prototype of the request before, which the next chat starts from. */
	earlier?: { sessionId: string; artifactId: string; revision: number };
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
	missionIds(): string[] {
		const row = this.port.one("SELECT json_group_array(mission_id) ids FROM planning_workers");
		return row ? JSON.parse(String(row.ids)) : [];
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
		let before: PlanningWorkerState["phase"] | undefined;
		const result = this.port.transaction(() => {
			const state = this.get(missionId);
			if (!state || state.revision !== revision) throw new Conflict("Planning worker changed");
			before = state.phase;
			work(state);
			state.revision++;
			this.port.run("UPDATE planning_workers SET record=? WHERE mission_id=?", canonicalJSON(state), missionId);
			return state;
		});
		this.port.changed(missionId);
		if (before !== result.phase) trace(`pilotd: planning ${missionId} phase ${before} -> ${result.phase}`);
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
