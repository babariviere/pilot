import type {
	DurableOperation,
	InterviewAgreementBinding,
	InterviewQuestion,
	InterviewSubmission,
	InterviewWrite,
	MissionInterview,
	MissionPlan,
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
import type { MissionDbPort } from "./mission-database.ts";

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
interface Port extends MissionDbPort {
	/** Only creates a fresh planningVersion 1 mission. No existing ID is accepted. */
	create(input: { projectId: string; title: string }, ownerSessionId: string): string;
	ownerFence(missionId: string, ownerSessionId: string): MissionInterview["ownerFence"];
	mapBrief(missionId: string, markdown: string): number;
	currentBriefRevision(missionId: string): number;
	/** Published native plans can only open inert Revisit rounds, never creation again. */
	hasPublication(missionId: string): boolean;
	publishedAgreement(
		missionId: string,
		brief: { revision: number; markdown: string },
		submissionDigest: string,
	): { revision: number; digest: string } | undefined;
	submitted(state: MissionInterview, op: DurableOperation): void;
}

/** Append-only snapshots share missions.sqlite's transaction/replica. No wake or worker side effects. */
export class MissionInterviewStore {
	private readonly port: Port;
	private readonly listeners = new Set<(missionId: string) => void>();
	constructor(port: Port) {
		this.port = port;
	}
	/** Invalidates passive reads only. Consumers must read the durable state again. */
	onChange(notice: (missionId: string) => void): () => void {
		this.listeners.add(notice);
		return () => this.listeners.delete(notice);
	}
	create(
		op: DurableOperation,
		input: { projectId: string; title: string },
		ownerSessionId: string,
		questions: InterviewQuestion[],
	): MissionInterview {
		validateQuestions(questions);
		return this.createSnapshot(op, input, ownerSessionId, questions);
	}
	/** Creation-only bootstrap, not a human round. Empty state cannot be submitted. */
	enroll(op: DurableOperation, input: { projectId: string; title: string }, ownerSessionId: string): MissionInterview {
		return this.createSnapshot(op, input, ownerSessionId, []);
	}
	private createSnapshot(
		op: DurableOperation,
		input: { projectId: string; title: string },
		ownerSessionId: string,
		questions: InterviewQuestion[],
	): MissionInterview {
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
	/**
	 * One submitted round of this mission by its submission ID, and its round number as the map counts it (1 plus the
	 * rounds submitted before it). Reads two indexed rows, not the whole history.
	 */
	submitted(missionId: string, operationId: string): { round: number; submission: InterviewSubmission } | undefined {
		const row = this.port.one(
			"SELECT state FROM mission_interviews WHERE mission_id=? AND operation_id=? AND json_extract(state,'$.submission.operationId')=operation_id",
			missionId,
			operationId,
		);
		if (!row) return undefined;
		const submission = (JSON.parse(String(row.state)) as MissionInterview).submission!;
		const before = this.port.one(
			"SELECT COUNT(*) AS n FROM mission_interviews WHERE mission_id=? AND operation_id=json_extract(state,'$.submission.operationId') AND json_extract(state,'$.submission.fence.questionSetRevision')<?",
			missionId,
			submission.fence.questionSetRevision,
		);
		return { round: 1 + Number(before?.n ?? 0), submission };
	}
	/** Original submitted snapshots in append order, not later drafts carrying old answers.
	 * Context is the immutable plan snapshot that opened that question set, never today's plan.
	 * Callers must check current owner/project access and durability before exposing these records. */
	history(missionId: string): { interview: MissionInterview; plan: MissionPlan | null }[] {
		return this.port
			.all(
				`SELECT submitted.state, (
				SELECT p.state FROM mission_interviews opened
				JOIN mission_plans p ON p.operation_id=opened.operation_id AND p.mission_id=opened.mission_id
				WHERE opened.mission_id=submitted.mission_id AND opened.sequence<submitted.sequence
				AND json_extract(opened.state,'$.fence.questionSetRevision')=json_extract(submitted.state,'$.fence.questionSetRevision')
				ORDER BY opened.sequence LIMIT 1
			) AS plan FROM mission_interviews submitted
			WHERE submitted.mission_id=? AND submitted.operation_id=json_extract(submitted.state,'$.submission.operationId')
			ORDER BY submitted.sequence`,
				missionId,
			)
			.map((row) => ({
				interview: JSON.parse(String(row.state)),
				plan: row.plan ? JSON.parse(String(row.plan)) : null,
			}));
	}
	/** New enrolled worker rounds must ask new clarification questions, not repeat submitted ones. */
	assertNewQuestions(missionId: string, questions: InterviewQuestion[]): void {
		validateQuestions(questions);
		if (
			this.port.one(
				`SELECT 1 FROM mission_interviews m, json_each(m.state,'$.submission.questions') old, json_each(?) fresh
			WHERE m.mission_id=? AND (json_extract(old.value,'$.id')=json_extract(fresh.value,'$.id') OR json_extract(old.value,'$.prompt')=json_extract(fresh.value,'$.prompt')) LIMIT 1`,
				JSON.stringify(questions),
				missionId,
			)
		)
			throw new Conflict(
				"Later interviews need new clarification questions; earlier answers remain reference context",
			);
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
		let changed = false;
		const written = this.port.transaction(() => {
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
				if (request.kind !== undefined && request.kind !== "revisit") throw new Conflict("Unknown interview kind");
				if (request.kind === "revisit" || state.kind === "revisit" || this.port.hasPublication(op.targetId)) {
					this.assertNewQuestions(op.targetId, request.questions);
					state.kind = "revisit";
				}
				state.questions = structuredClone(request.questions);
				// Keep old meanings and custom drafts. Changed questions need explicit reconfirmation.
				// Answers to questions no longer asked are dropped: the submitted snapshot keeps them.
				const asked = new Set(request.questions.map((q) => q.id));
				state.answers = state.answers.filter((a) => asked.has(a.questionId));
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
				const briefRevision =
					state.kind === "revisit"
						? this.port.currentBriefRevision(op.targetId)
						: this.port.mapBrief(op.targetId, markdown);
				const snapshot = {
					...(state.kind === "revisit" ? { kind: "revisit" as const } : {}),
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
			if (request.purpose === "interview-submit") this.port.submitted(state, op);
			changed = true;
			return state;
		});
		if (changed) for (const notice of this.listeners) notice(op.targetId);
		return written;
	}
	/** Approval must cover the current complete snapshot, never just a matching old brief. */
	binding(missionId: string, brief: { revision: number; markdown: string }): InterviewAgreementBinding | undefined {
		const state = this.latest(missionId);
		if (!state) return undefined;
		if (state.kind === "revisit") throw new Conflict("Revisit answers are not an agreement or build approval");
		const s = state.submission;
		const planning = s ? this.port.publishedAgreement(missionId, brief, s.digest) : undefined;
		if (
			!s ||
			(!planning && (brief.revision !== s.briefRevision || brief.markdown !== s.agreementMarkdown)) ||
			canonicalJSON(state.ownerFence) !== canonicalJSON(this.port.ownerFence(missionId, state.fence.ownerSessionId))
		)
			throw new Conflict("Current complete interview agreement required");
		return { enrollmentId: state.fence.enrollmentId, submission: s, ...(planning ? { planning } : {}) };
	}
	durable(): Promise<void> {
		return this.port.durable();
	}
}
