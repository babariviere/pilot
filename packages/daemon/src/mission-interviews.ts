/** Host-only Day seam. No production routes, legacy enrollment or dispatch adapter is installed. */
import type {
	AgreementAdmission,
	DurableOperation,
	InterviewContinuation,
	InterviewQuestion,
	InterviewWrite,
	MissionInterview,
	SmallAskAdmission,
} from "@pilot/protocol";
import { Conflict, NotFound } from "./errors.ts";
import { interviewExact, interviewId, interviewText, validateQuestions } from "./mission-interview-contract.ts";
import type { MissionStore } from "./missions.ts";
import { canonicalJSON, type OperationJournal, OperationRejected } from "./operation-journal.ts";
import type { WorkflowConfirmations } from "./workflow-confirmations.ts";

export const isInterviewOperation = (kind: string): boolean =>
	[
		"interview-create",
		"interview-questions",
		"interview-save",
		"interview-submit",
		"interview-continue",
		"agreement-start",
		"small-ask-start",
	].includes(kind);

type EffectRequest = InterviewContinuation | AgreementAdmission | SmallAskAdmission;
export interface FlowAdmissionReceipt {
	admissionId: string;
}
export interface QualifiedMissionFlowAdapter {
	/** Durable exact-operation dedupe. Recheck independent model/permission/lifecycle gates and
	 * call guard synchronously at the actual admission commit, after ALL asynchronous preparation.
	 * Small asks create a NEW standalone Build clone only. Continuations are planning-only, never
	 * builder admission. Agreement starts bind the exact assignment digest to the approved scope.
	 * No receipt may report acceptance merely for queueing an unguarded future start. */
	admit(op: DurableOperation, request: EffectRequest, guard: () => void): Promise<FlowAdmissionReceipt>;
	/** Exact committed operation receipt, never matching session state or a guessed new request. */
	lookup(op: DurableOperation): Promise<FlowAdmissionReceipt | undefined>;
}
interface Dependencies {
	store: MissionStore;
	journal: OperationJournal;
	confirmations: WorkflowConfirmations;
	/** Trusted host authorization, not caller-provided actor labels. Also checks current permissions.
	 * Small asks return the exact effective model/permission/project configuration digest.
	 * Agreement starts return the exact current assignment/owner/allocation digest and must
	 * check approved-scope fit. A caller-supplied digest is never proof of that fit.
	 * This does not replace the adapter's independent model, permission or lifecycle gates. */
	authorize(purpose: string, projectId: string, ownerSessionId: string | null, request: unknown): string;
	adapter?: QualifiedMissionFlowAdapter;
}
interface CreateInterview {
	purpose: "interview-create";
	projectId: string;
	title: string;
	ownerSessionId: string;
	questions: InterviewQuestion[];
}

export class MissionInterviews {
	private readonly deps: Dependencies;
	constructor(deps: Dependencies) {
		this.deps = deps;
	}
	private current(missionId: string): MissionInterview {
		const state = this.deps.store.interviews.latest(missionId);
		if (!state) throw new Conflict("Mission is not enrolled in the new interview flow");
		const mission = this.deps.store.require(missionId);
		const ownerFence = this.deps.store.interviewOwnerFence(missionId, state.fence.ownerSessionId);
		const member = this.deps.store.membership(state.fence.ownerSessionId);
		if (
			mission.status !== "active" ||
			mission.coordinatorSessionId !== state.fence.ownerSessionId ||
			!member?.active ||
			!member.coordinator ||
			member.missionId !== missionId ||
			state.ownerFence.memberEventId !== ownerFence.memberEventId ||
			state.ownerFence.coordinatorEventId !== ownerFence.coordinatorEventId
		)
			throw new Conflict("Interview owner or membership changed");
		return state;
	}
	/** Passive saved progress. Re-read the pinned snapshot after its durability barrier. */
	async read(missionId: string): Promise<MissionInterview> {
		const state = this.current(missionId);
		const projectId = this.deps.store.require(missionId).projectId;
		const check = () => {
			this.deps.authorize("interview-read", projectId, state.fence.ownerSessionId, state.fence);
			if (canonicalJSON(this.current(missionId)) !== canonicalJSON(state)) throw new Conflict("Interview changed");
		};
		check();
		await this.deps.store.durable();
		check();
		return state;
	}
	async admit(op: DurableOperation, firstEntry = false): Promise<unknown> {
		if (!isInterviewOperation(op.kind)) throw new OperationRejected("Unsupported interview purpose");
		if (!firstEntry) return this.recover(op);
		let request: CreateInterview | InterviewWrite | EffectRequest;
		let check: () => void;
		try {
			request = JSON.parse(op.payload);
			if (request?.purpose !== op.kind) throw new Conflict("Interview purpose changed");
			if (request.purpose === "interview-create") {
				interviewExact(request, ["purpose", "projectId", "title", "ownerSessionId", "questions"]);
				interviewId(request.projectId);
				interviewId(request.ownerSessionId);
				interviewId(op.targetId);
				interviewText(request.title, 200);
				validateQuestions(request.questions);
				const r = request as unknown as CreateInterview;
				check = () => {
					this.deps.authorize(r.purpose, r.projectId, r.ownerSessionId, r);
				};
			} else if (["interview-save", "interview-questions", "interview-submit"].includes(request.purpose)) {
				const r = request as InterviewWrite;
				interviewExact(r, [
					"purpose",
					"expected",
					...(r.purpose === "interview-save"
						? ["answers"]
						: r.purpose === "interview-questions"
							? ["questions"]
							: []),
				]);
				check = () => {
					const state = this.current(op.targetId);
					if (canonicalJSON(r.expected) !== canonicalJSON({ fence: state.fence, revision: state.revision }))
						throw new Conflict("Interview revision changed");
					this.deps.authorize(
						r.purpose,
						this.deps.store.require(op.targetId).projectId,
						state.fence.ownerSessionId,
						r,
					);
				};
			} else {
				return this.effect(op, request as EffectRequest);
			}
			check();
		} catch (error) {
			return this.reject(error);
		}
		await this.deps.journal.checkpoint(op, this.marker(op));
		let result: MissionInterview;
		try {
			check();
			if (request.purpose === "interview-create") {
				result = this.deps.store.interviews.create(
					op,
					{ projectId: request.projectId, title: request.title },
					request.ownerSessionId,
					request.questions,
				);
			} else result = this.deps.store.interviews.write(op, request as InterviewWrite, check);
		} catch (error) {
			return this.reject(error);
		}
		// After a commit, failed durability is Unknown, even if its error type looks like a conflict.
		await this.deps.store.durable();
		return this.writeReceipt(result);
	}
	private reject(error: unknown): never {
		if (error instanceof Conflict || error instanceof NotFound || error instanceof SyntaxError)
			throw new OperationRejected(error.message);
		throw error;
	}
	private marker(op: DurableOperation) {
		return { stage: "interview-effect-entered", purpose: op.kind, payloadHash: op.payloadHash };
	}
	private writeReceipt(state: MissionInterview) {
		return {
			missionId: state.fence.missionId,
			enrollmentId: state.fence.enrollmentId,
			revision: state.revision,
			submissionOperationId: state.submission?.operationId ?? null,
		};
	}
	private async recover(op: DurableOperation): Promise<unknown> {
		if (canonicalJSON((await this.deps.journal.lookup(op))?.result) !== canonicalJSON(this.marker(op)))
			throw new Error("Unknown interview entry; no replay");
		if (["interview-continue", "agreement-start", "small-ask-start"].includes(op.kind)) {
			const result = await this.deps.adapter?.lookup(op);
			if (!result) throw new Error("Unknown admission; exact lookup only");
			return result;
		}
		const state = this.deps.store.interviews.lookup(op);
		if (!state) throw new Error("Unknown saved interview; no replay");
		await this.deps.store.durable();
		return this.writeReceipt(state);
	}
	private async effect(op: DurableOperation, request: EffectRequest): Promise<FlowAdmissionReceipt> {
		let key: string;
		let check: () => void;
		try {
			if (!this.deps.adapter) throw new Conflict("Qualified admission adapter unavailable");
			if (request.purpose === "small-ask-start") {
				interviewExact(request, ["purpose", "requestId", "projectId", "text", "configurationDigest"]);
				interviewId(request.requestId);
				interviewId(request.projectId);
				interviewText(request.text, 16000);
				interviewText(request.configurationDigest, 256);
				if (op.targetId !== request.requestId) throw new Conflict("Small ask request identity changed");
				key = `small:${request.requestId}`;
				check = () => {
					if (
						this.deps.authorize(request.purpose, request.projectId, null, request) !== request.configurationDigest
					)
						throw new Conflict("Small ask configuration changed");
				};
			} else {
				const agreement = request.purpose === "agreement-start";
				interviewExact(request, [
					"purpose",
					"fence",
					"submissionOperationId",
					"submissionDigest",
					...(agreement ? ["approvalOperationId", "approvalDigest", "assignmentDigest"] : []),
				]);
				const state = this.current(op.targetId);
				const projectId = this.deps.store.require(op.targetId).projectId;
				key = agreement
					? `assignment:${op.targetId}:${(request as AgreementAdmission).assignmentDigest}`
					: `continue:${request.submissionOperationId}`;
				check = () => {
					const current = this.current(op.targetId);
					const s = current.submission;
					if (
						!s ||
						canonicalJSON(request.fence) !== canonicalJSON(current.fence) ||
						s.operationId !== request.submissionOperationId ||
						s.digest !== request.submissionDigest
					)
						throw new Conflict("Exact complete submitted answers required");
					this.deps.store.interviews.binding(op.targetId, this.deps.store.brief(op.targetId)!);
					const authorizedDigest = this.deps.authorize(
						request.purpose,
						projectId,
						state.fence.ownerSessionId,
						request,
					);
					if (request.purpose === "agreement-start") {
						interviewText(request.assignmentDigest, 256);
						if (authorizedDigest !== request.assignmentDigest)
							throw new Conflict("Assignment, owner or allocation changed");
						this.deps.confirmations.assertApproval(
							op.targetId,
							request.approvalOperationId,
							request.approvalDigest,
						);
					}
				};
				if (agreement) {
					const approval = await this.deps.confirmations.current(op.targetId);
					if (approval.state !== "applicable") throw new Conflict("Current workflow approval required");
				}
			}
			check();
		} catch (error) {
			return this.reject(error);
		}
		await this.deps.journal.checkpoint(op, this.marker(op));
		try {
			this.deps.store.interviews.reserveEffect(key, op, check);
		} catch (error) {
			return this.reject(error);
		}
		await this.deps.store.durable();
		// Everything after this point is lookup-only on uncertainty, including failed final checks.
		try {
			check();
			return await this.deps.adapter!.admit(op, structuredClone(request), check);
		} catch (cause) {
			throw new Error("Unknown entered admission; exact lookup only", { cause });
		}
	}
}
