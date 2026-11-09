/** Authenticated native human ingress. No enrollment, model execution or worker admission. */
import type { DurableOperation, OperationReceipt } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { interviewDigest } from "./mission-interview-contract.ts";
import { isInterviewOperation, MissionInterviews } from "./mission-interviews.ts";
import { isPlanOperation, MissionPlans } from "./mission-plans.ts";
import type { MissionStore } from "./missions.ts";
import { canonicalJSON, type OperationJournal, OperationRejected, payloadHash, sameHost } from "./operation-journal.ts";
import type { PlanningWorkers } from "./planning-workers.ts";
import type { ProjectStore } from "./projects.ts";
import type { SessionManager } from "./sessions.ts";
import type { WorkflowConfirmations } from "./workflow-confirmations.ts";

export const isNativePlanningOperation = (kind: string) => isInterviewOperation(kind) || isPlanOperation(kind);
const humanKinds = ["interview-save", "interview-submit"];
interface Dependencies {
	store: MissionStore;
	journal: OperationJournal;
	projects: ProjectStore;
	sessions: SessionManager;
	confirmations: WorkflowConfirmations;
	workers?: PlanningWorkers;
}

export class NativeMissionPlanning {
	private readonly deps: Dependencies;
	constructor(deps: Dependencies) {
		this.deps = deps;
	}
	/** A current same-project owner is required even for historical receipt access. */
	private scope(missionId: string, projectId?: string) {
		const { store, projects, sessions } = this.deps;
		const mission = store.require(missionId),
			project = projects.require(mission.projectId),
			interview = store.interviews.latest(missionId),
			owner = mission.coordinatorSessionId,
			member = owner ? store.membership(owner) : undefined,
			coordinator = owner ? sessions.get(owner) : undefined;
		if (
			(projectId !== undefined && projectId !== project.id) ||
			mission.status !== "active" ||
			mission.planningVersion !== 1 ||
			!interview ||
			!owner ||
			interview.fence.ownerSessionId !== owner ||
			!member?.active ||
			!member.coordinator ||
			member.missionId !== missionId ||
			!coordinator ||
			coordinator.projectId !== project.id ||
			coordinator.archivedAt ||
			coordinator.mode === "ask" ||
			coordinator.role ||
			coordinator.control ||
			canonicalJSON(interview.ownerFence) !== canonicalJSON(store.interviewOwnerFence(missionId, owner))
		)
			throw new Conflict("Current enrolled planning owner required");
		return { mission, project, interview, coordinator, plan: store.plans.get(missionId) ?? null };
	}
	private authority(missionId: string): string {
		const pin = this.scope(missionId);
		const evidence = this.deps.store.workflowConfirmationState(missionId);
		// Include configuration, proposal, topic and owner ABA. Human answers have their own CAS.
		return payloadHash(
			canonicalJSON({
				mission: {
					id: pin.mission.id,
					projectId: pin.mission.projectId,
					goal: pin.mission.goal,
					title: pin.mission.title,
					status: pin.mission.status,
					coordinatorSessionId: pin.mission.coordinatorSessionId,
				},
				project: pin.project,
				coordinator: {
					id: pin.coordinator.id,
					projectId: pin.coordinator.projectId,
					mode: pin.coordinator.mode,
					role: pin.coordinator.role,
					model: pin.coordinator.model,
					inputGeneration: pin.coordinator.inputGeneration,
				},
				ownerFence: pin.interview.ownerFence,
				plan: pin.plan,
				decisions: evidence.decisions,
				decisionEventId: evidence.contextFence.decisionEventId,
				artifactEventId: evidence.contextFence.artifactEventId,
			}),
		);
	}
	private digest(missionId: string): string {
		return payloadHash(
			canonicalJSON({
				authority: this.authority(missionId),
				briefRevision: this.deps.store.brief(missionId)?.revision,
			}),
		);
	}
	private interviews(check: () => void) {
		return new MissionInterviews({
			...this.deps,
			authorize: () => {
				check();
				return "native-human-only";
			},
		});
	}
	async read(projectId: string, missionId: string) {
		const mission = this.deps.store.require(missionId);
		this.deps.projects.require(projectId);
		if (mission.projectId !== projectId) throw new Conflict("Native planning project changed");
		if (mission.planningVersion !== 1 || !this.deps.store.interviews.latest(missionId)) {
			const pin = canonicalJSON(mission);
			await this.deps.store.durable();
			this.deps.projects.require(projectId);
			if (canonicalJSON(this.deps.store.require(missionId)) !== pin || this.deps.store.interviews.latest(missionId))
				throw new Conflict("Native planning enrollment changed");
			return {
				version: 1,
				projectId,
				missionId,
				status: "not-enrolled",
				contextDigest: null,
				view: null,
				capabilities: {
					answers: "unavailable",
					enrollment: "not-configured",
					coordinatorProfile: "not-configured",
					continuation: "unavailable",
					admission: "unavailable",
					prototype: "unavailable",
				},
			};
		}
		this.scope(missionId, projectId);
		const worker = this.deps.store.planningWorkers.get(missionId);
		const contextDigest = this.digest(missionId);
		const check = () => {
			this.scope(missionId, projectId);
			if (this.digest(missionId) !== contextDigest) throw new Conflict("Native planning context changed");
			if (canonicalJSON(this.deps.store.planningWorkers.get(missionId)) !== canonicalJSON(worker))
				throw new Conflict("Native planning worker changed during read");
		};
		const plans = new MissionPlans({ ...this.deps, authorize: check });
		const view = await plans.view(missionId);
		check();
		return {
			version: 1,
			projectId,
			missionId,
			status: view.interview.questions.length ? "available" : "preparing",
			contextDigest: view.interview.questions.length ? contextDigest : null,
			questionDigests: Object.fromEntries(view.interview.questions.map((q) => [q.id, interviewDigest(q)])),
			view: view.interview.questions.length ? view : null,
			capabilities: {
				answers: worker && worker.phase !== "held" ? "unavailable" : 1,
				enrollment: "not-configured",
				...(this.deps.workers?.status(missionId) ?? {
					coordinatorProfile: "not-configured",
					continuation: "unavailable",
				}),
				admission: "unavailable",
				prototype: "unavailable",
			},
		};
	}
	private envelope(op: DurableOperation) {
		if (!humanKinds.includes(op.kind))
			throw new OperationRejected("Native planning adapter unavailable for this purpose");
		if (
			op.origin?.hostId !== "local" ||
			!sameHost(op.origin, this.deps.journal.destination) ||
			!sameHost(op.destination, this.deps.journal.destination) ||
			op.bindingGeneration !== 1 ||
			!op.bindingId ||
			!/^[a-f0-9]{64}$/.test(op.bindingId)
		)
			throw new OperationRejected("Native planning identity required");
		const pin = this.scope(op.targetId);
		let request: unknown;
		try {
			request = JSON.parse(op.payload);
		} catch {
			throw new OperationRejected("Invalid native planning payload");
		}
		const expected = (
			request as { expected?: { fence?: { ownerSessionId?: string; enrollmentId?: string; missionId?: string } } }
		)?.expected?.fence;
		if (
			expected?.missionId !== op.targetId ||
			expected.ownerSessionId !== pin.interview.fence.ownerSessionId ||
			expected.enrollmentId !== pin.interview.fence.enrollmentId
		)
			throw new OperationRejected("Native interview owner or enrollment changed");
	}
	/** Called only after the native capability has authenticated. Status never executes a handler. */
	async lookup(op: DurableOperation): Promise<OperationReceipt | undefined> {
		this.envelope(op);
		const receipt = await this.deps.journal.lookup(op);
		this.envelope(op);
		return receipt;
	}
	/** Journal recovery is exact saved-effect lookup, never new authority or model dispatch. */
	async admit(op: DurableOperation, firstEntry = false): Promise<unknown> {
		if (!firstEntry) {
			if (isPlanOperation(op.kind)) return new MissionPlans({ ...this.deps, authorize: () => {} }).admit(op, false);
			return this.interviews(() => {}).admit(op, false);
		}
		if (!humanKinds.includes(op.kind))
			throw new OperationRejected("Native planning adapter unavailable for this purpose");
		const authority = this.authority(op.targetId);
		const check = () => {
			this.envelope(op);
			const worker = this.deps.store.planningWorkers.get(op.targetId);
			if (worker && worker.phase !== "held") throw new Conflict("Saved planning round is not ready for answers");
			if (this.digest(op.targetId) !== op.bindingId) throw new Conflict("Native planning context changed");
		};
		const result = await this.interviews(check).admit(op, true);
		// The service already committed. A late authority change must remain Unknown, not rejected.
		try {
			this.envelope(op);
			const committed = this.deps.store.interviews.lookup(op)!;
			if (
				this.authority(op.targetId) !== authority ||
				this.deps.store.interviews.latest(op.targetId)?.revision !== committed.revision ||
				(op.kind === "interview-submit" &&
					this.deps.store.brief(op.targetId)?.revision !== committed.submission?.briefRevision)
			)
				throw new Conflict("Native planning authority changed after saving");
		} catch (cause) {
			throw new Error("Unknown saved planning operation; lookup only", { cause });
		}
		if (op.kind === "interview-submit") this.deps.workers?.submitted(op.targetId, op.operationId);
		return result;
	}
}
