import type { SQLInputValue } from "node:sqlite";
import type {
	DurableOperation,
	InterviewAgreementBinding,
	InterviewQuestion,
	InterviewWrite,
	MissionInterview,
} from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import {
	agreementMarkdown,
	completeAnswers,
	interviewDigest,
	validateAnswers,
	validateQuestions,
} from "./mission-interview-contract.ts";
import { canonicalJSON } from "./operation-journal.ts";

export const MISSION_INTERVIEW_SCHEMA = `
CREATE TABLE IF NOT EXISTS mission_interviews (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL,
 operation_id TEXT UNIQUE, operation TEXT, state TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mission_interview_latest ON mission_interviews(mission_id, sequence);
CREATE UNIQUE INDEX IF NOT EXISTS mission_interview_enrollment ON mission_interviews(json_extract(state,'$.fence.enrollmentId')) WHERE json_extract(state,'$.revision')=1;
CREATE TABLE IF NOT EXISTS mission_flow_entries (
 domain_key TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, operation TEXT NOT NULL
);
`;
interface Port {
	one(sql: string, ...params: SQLInputValue[]): Record<string, SQLInputValue> | undefined;
	run(sql: string, ...params: SQLInputValue[]): void;
	transaction<T>(work: () => T): T;
	durable(): Promise<void>;
	/** Only creates a fresh planningVersion 1 mission. No existing ID is accepted. */
	create(input: { projectId: string; title: string }, ownerSessionId: string): string;
	ownerFence(missionId: string, ownerSessionId: string): MissionInterview["ownerFence"];
	mapBrief(missionId: string, markdown: string): number;
}

/** Append-only snapshots share missions.sqlite's transaction/replica. No wake or worker side effects. */
export class MissionInterviewStore {
	private readonly port: Port;
	constructor(port: Port) {
		this.port = port;
	}
	create(
		op: DurableOperation,
		input: { projectId: string; title: string },
		ownerSessionId: string,
		questions: InterviewQuestion[],
	): MissionInterview {
		validateQuestions(questions);
		return this.port.transaction(() => {
			const existing = this.lookup(op);
			if (existing) return existing;
			if (
				this.port.one(
					"SELECT 1 FROM mission_interviews WHERE json_extract(state,'$.fence.enrollmentId')=? LIMIT 1",
					op.targetId,
				)
			)
				throw new Conflict("Interview creation identity already used");
			const missionId = this.port.create(input, ownerSessionId);
			const state: MissionInterview = {
				version: 1,
				fence: { missionId, ownerSessionId, enrollmentId: op.targetId, questionSetRevision: 1, answerRevision: 0 },
				revision: 1,
				ownerFence: this.port.ownerFence(missionId, ownerSessionId),
				questions: structuredClone(questions),
				answers: [],
				submission: null,
			};
			this.insert(state, op);
			return state;
		});
	}
	/** Durable domain-level reservation also prevents a fresh envelope duplicating an uncertain start. */
	reserveEffect(key: string, op: DurableOperation, check: () => void): void {
		this.port.transaction(() => {
			check();
			const prior = this.port.one("SELECT operation FROM mission_flow_entries WHERE domain_key=?", key);
			if (prior) throw new Conflict("Flow already entered; look up its exact operation");
			this.port.run(
				"INSERT INTO mission_flow_entries(domain_key,operation_id,operation) VALUES(?,?,?)",
				key,
				op.operationId,
				canonicalJSON(op),
			);
		});
	}
	latest(missionId: string): MissionInterview | undefined {
		const row = this.port.one(
			"SELECT state FROM mission_interviews WHERE mission_id=? ORDER BY sequence DESC LIMIT 1",
			missionId,
		);
		return row ? JSON.parse(String(row.state)) : undefined;
	}
	lookup(op: DurableOperation): MissionInterview | undefined {
		const row = this.port.one("SELECT operation,state FROM mission_interviews WHERE operation_id=?", op.operationId);
		if (!row) return undefined;
		if (row.operation !== canonicalJSON(op)) throw new Conflict("Conflicting interview operation");
		return JSON.parse(String(row.state));
	}
	private insert(state: MissionInterview, op?: DurableOperation): void {
		this.port.run(
			"INSERT INTO mission_interviews(mission_id,operation_id,operation,state) VALUES(?,?,?,?)",
			state.fence.missionId,
			op?.operationId ?? null,
			op ? canonicalJSON(op) : null,
			JSON.stringify(state),
		);
	}
	write(op: DurableOperation, request: InterviewWrite, check: () => void): MissionInterview {
		return this.port.transaction(() => {
			const existing = this.lookup(op);
			if (existing) return existing;
			check();
			const state = this.latest(op.targetId);
			if (
				!state ||
				canonicalJSON(request.expected) !== canonicalJSON({ fence: state.fence, revision: state.revision })
			)
				throw new Conflict("Interview changed; reload saved answers");
			if (request.purpose === "interview-questions") {
				validateQuestions(request.questions);
				state.questions = structuredClone(request.questions);
				// Keep old meanings and custom drafts. Changed questions need explicit reconfirmation.
				state.fence.questionSetRevision++;
				state.fence.answerRevision++;
				state.submission = null;
			} else if (request.purpose === "interview-save") {
				validateAnswers(request.answers, state.questions);
				state.answers = structuredClone(request.answers);
				state.fence.answerRevision++;
				state.submission = null;
			} else {
				if (state.submission) throw new Conflict("Already submitted; reconcile the exact operation");
				const markdown = agreementMarkdown(state);
				const briefRevision = this.port.mapBrief(op.targetId, markdown);
				const snapshot = {
					operationId: op.operationId,
					fence: structuredClone(state.fence),
					questions: structuredClone(state.questions),
					answers: structuredClone(completeAnswers(state)),
					agreementMarkdown: markdown,
					briefRevision,
				};
				state.submission = { ...snapshot, digest: interviewDigest(snapshot) };
			}
			state.revision++;
			this.insert(state, op);
			return state;
		});
	}
	/** Approval must cover the current complete snapshot, never just a matching old brief. */
	binding(missionId: string, brief: { revision: number; markdown: string }): InterviewAgreementBinding | undefined {
		const state = this.latest(missionId);
		if (!state) return undefined;
		const s = state.submission;
		if (
			!s ||
			brief.revision !== s.briefRevision ||
			brief.markdown !== s.agreementMarkdown ||
			canonicalJSON(state.ownerFence) !== canonicalJSON(this.port.ownerFence(missionId, state.fence.ownerSessionId))
		)
			throw new Conflict("Current complete interview agreement required");
		return { enrollmentId: state.fence.enrollmentId, submission: s };
	}
	durable(): Promise<void> {
		return this.port.durable();
	}
}
