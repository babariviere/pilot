/** Trusted creation-only planning worker lifecycle. No existing chat adoption or generic send fallback. */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
	assertPlanningBinding,
	PLANNING_PROFILE,
	type PlanningInput,
	type PlanningWorkerBinding,
	type PlanningWorkerReply,
	type PlanningWorkerRequest,
} from "@pilot/kernel";
import type { DurableOperation } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { interviewExact, interviewId, interviewText } from "./mission-interview-contract.ts";
import { MissionInterviews } from "./mission-interviews.ts";
import { isPlanOperation, MissionPlans } from "./mission-plans.ts";
import type { MissionStore } from "./missions.ts";
import { canonicalJSON, type OperationJournal, OperationRejected, payloadHash, sameHost } from "./operation-journal.ts";
import type { PlanningWorkerState } from "./planning-worker-store.ts";
import type { ProjectStore } from "./projects.ts";
import type { SessionManager } from "./sessions.ts";
import type { WorkflowConfirmations } from "./workflow-confirmations.ts";

export interface PlanningEnrollment {
	purpose: "planning-enroll";
	projectId: string;
	ownerSessionId: string;
	title: string;
	goal: string;
	model: string;
	profile: typeof PLANNING_PROFILE;
	configurationDigest: string;
}
interface Dependencies {
	home: string;
	store: MissionStore;
	journal: OperationJournal;
	projects: ProjectStore;
	sessions: SessionManager;
	confirmations: WorkflowConfirmations;
}
const hash = (value: unknown) => payloadHash(canonicalJSON(value));
export class PlanningWorkers {
	private readonly deps: Dependencies;
	private readonly closing = new AbortController();
	private readonly tasks = new Set<Promise<unknown>>();
	private readonly admissions = new Map<string, Promise<unknown>>();
	private readonly turnAdmissions = new Map<string, Promise<void>>();
	private readonly detach: () => void;
	private closed?: Promise<void>;
	constructor(deps: Dependencies) {
		this.deps = deps;
		this.detach = deps.sessions.setPlanningBridge({
			assert: (b) => {
				this.scope(b);
			},
			held: (b) => this.scope(b).phase !== "active",
			call: (b, r, guard) => this.call(b, r, guard),
			close: () => this.close(),
		});
	}
	configuration(projectId: string): string {
		return hash({ project: this.deps.projects.require(projectId), profile: PLANNING_PROFILE });
	}
	profile(projectId: string) {
		return { version: 1, projectId, profile: PLANNING_PROFILE, configurationDigest: this.configuration(projectId) };
	}
	private scope(binding: PlanningWorkerBinding): PlanningWorkerState {
		assertPlanningBinding(binding);
		const { store, projects, sessions, journal } = this.deps;
		const state = store.planningWorkers.get(binding.missionId),
			mission = store.require(binding.missionId),
			interview = store.interviews.latest(binding.missionId),
			owner = sessions.get(binding.ownerSessionId),
			member = store.membership(binding.ownerSessionId);
		if (
			this.closing.signal.aborted ||
			binding.home !== resolve(this.deps.home) ||
			!sameHost(binding.host, journal.destination) ||
			!state ||
			canonicalJSON(state.binding) !== canonicalJSON(binding) ||
			mission.projectId !== binding.projectId ||
			mission.status !== "active" ||
			mission.planningVersion !== 1 ||
			mission.coordinatorSessionId !== binding.ownerSessionId ||
			!member?.active ||
			!member.coordinator ||
			member.missionId !== binding.missionId ||
			!interview ||
			interview.fence.enrollmentId !== binding.enrollmentId ||
			canonicalJSON(interview.ownerFence) !==
				canonicalJSON(store.interviewOwnerFence(binding.missionId, binding.ownerSessionId)) ||
			!owner ||
			owner.projectId !== binding.projectId ||
			owner.mode !== "build" ||
			owner.role ||
			owner.control ||
			owner.archivedAt
		)
			throw new Conflict("Current trusted planning owner required");
		projects.require(binding.projectId);
		return state;
	}
	private authority(binding: PlanningWorkerBinding): string {
		this.scope(binding);
		this.deps.sessions.assertPlanningOpen(binding.ownerSessionId);
		const { store, sessions } = this.deps,
			mission = store.require(binding.missionId),
			control = store.controls.fenceCurrent(binding.missionId);
		const { briefRevision: _brief, ...context } = store.allocationContextFence(binding.missionId);
		if (control.held) throw new Conflict("Mission planning is paused");
		return hash({
			binding,
			project: this.deps.projects.require(binding.projectId),
			session: sessions.planningIdentity(binding.ownerSessionId),
			mission: {
				title: mission.title,
				goal: mission.goal,
				status: mission.status,
				coordinatorSessionId: mission.coordinatorSessionId,
			},
			owner: store.interviewOwnerFence(binding.missionId, binding.ownerSessionId),
			context,
			controls: control,
		});
	}
	private roundContext(state: PlanningWorkerState, authority: string): string {
		return hash({ authority, plan: this.deps.store.plans.get(state.binding.missionId) ?? null });
	}
	private input(state: PlanningWorkerState, op: DurableOperation): PlanningInput {
		const submitted = this.deps.store.interviews.latest(state.binding.missionId)?.submission;
		return {
			binding: state.binding,
			operation: op,
			hold: op.kind === "interview-continue" ? state.hold : null,
			content:
				op.kind === "interview-continue"
					? `Continue planning from this exact submitted interview. Answers are not build permission. Use the trusted native planning skills and records only.\n${canonicalJSON(submitted)}`
					: `Plan this requested outcome using the trusted upstream skills. Read mission_plan, then publish the complete first saved round with action questions. Do not ask inside ask_user or start implementation.\n${state.goal}`,
		};
	}
	private async admitInput(state: PlanningWorkerState, op: DurableOperation, guard: () => void) {
		const admission = Promise.resolve().then(() => this.deps.sessions.admitPlanning(this.input(state, op), guard));
		this.admissions.set(state.binding.missionId, admission);
		try {
			return await admission;
		} finally {
			if (this.admissions.get(state.binding.missionId) === admission)
				this.admissions.delete(state.binding.missionId);
		}
	}
	/** Called only by authenticated native ingress, with an exact retained envelope. */
	async enroll(op: DurableOperation, firstEntry: boolean): Promise<unknown> {
		if (!firstEntry) return this.recover(op);
		let request: PlanningEnrollment;
		try {
			request = JSON.parse(op.payload);
			interviewExact(request, [
				"purpose",
				"projectId",
				"ownerSessionId",
				"title",
				"goal",
				"model",
				"profile",
				"configurationDigest",
			]);
			interviewId(op.targetId);
			interviewId(request.projectId);
			interviewId(request.ownerSessionId);
			interviewText(request.title, 200);
			interviewText(request.goal, 12000);
			interviewText(request.model, 256);
			if (
				request.purpose !== "planning-enroll" ||
				op.kind !== request.purpose ||
				canonicalJSON(request.profile) !== canonicalJSON(PLANNING_PROFILE) ||
				op.bindingGeneration !== 1 ||
				op.bindingId !== request.configurationDigest ||
				op.origin.hostId !== "local" ||
				!sameHost(op.origin, this.deps.journal.destination) ||
				!sameHost(op.destination, this.deps.journal.destination)
			)
				throw new Conflict("Trusted planning enrollment required");
		} catch (e) {
			throw new OperationRejected(e instanceof Error ? e.message : "Invalid planning enrollment");
		}
		const check = () => {
			if (
				this.closing.signal.aborted ||
				this.configuration(request.projectId) !== request.configurationDigest ||
				this.deps.sessions.get(request.ownerSessionId) ||
				this.deps.store.membership(request.ownerSessionId)
			)
				throw new Conflict("Fresh planning enrollment changed");
		};
		try {
			check();
		} catch (e) {
			throw new OperationRejected(String(e));
		}
		await this.deps.journal.checkpoint(op, { stage: "planning-enrollment-entered", payloadHash: op.payloadHash });
		check();
		const state = this.deps.store.planningWorkers.create(() => {
			check();
			const interview = this.deps.store.interviews.enroll(
				op,
				{ projectId: request.projectId, title: request.title },
				request.ownerSessionId,
			);
			return {
				version: 1,
				binding: {
					version: 1,
					profile: PLANNING_PROFILE,
					home: resolve(this.deps.home),
					host: this.deps.journal.destination,
					projectId: request.projectId,
					ownerSessionId: request.ownerSessionId,
					missionId: interview.fence.missionId,
					enrollmentId: op.targetId,
					creationOperationId: op.operationId,
				},
				creation: op,
				goal: request.goal,
				configurationDigest: request.configurationDigest,
				revision: 1,
				phase: "setup",
				hold: null,
				pendingHold: null,
				continuation: null,
			};
		});
		await this.deps.store.durable();
		const setupGuard = () => {
			if (
				this.closing.signal.aborted ||
				this.configuration(request.projectId) !== request.configurationDigest ||
				this.deps.store.planningWorkers.get(state.binding.missionId)?.revision !== state.revision ||
				canonicalJSON(this.deps.store.interviews.latest(state.binding.missionId)?.ownerFence) !==
					canonicalJSON(this.deps.store.interviewOwnerFence(state.binding.missionId, request.ownerSessionId))
			)
				throw new Conflict("Planning setup changed");
		};
		await this.deps.sessions.createPlanningWorker(state.binding, request.title, request.model, setupGuard);
		setupGuard();
		const active = this.deps.store.planningWorkers.change(state.binding.missionId, state.revision, (s) => {
			s.phase = "active";
		});
		const payload = canonicalJSON({ purpose: "planning-generate", enrollmentOperationId: op.operationId });
		const initial: DurableOperation = {
			...op,
			operationId: `generate-${op.operationId}`,
			targetId: state.binding.missionId,
			origin: state.binding.host,
			kind: "planning-generate",
			payload,
			payloadHash: payloadHash(payload),
		};
		this.deps.store.planningWorkers.retain(state.binding.missionId, "$initial", initial);
		await this.deps.store.durable();
		const authority = this.authority(active.binding);
		await this.admitInput(active, initial, () => {
			if (this.authority(active.binding) !== authority || this.scope(active.binding).revision !== active.revision)
				throw new Conflict("Planning admission changed");
		});
		if (this.authority(active.binding) !== authority)
			throw new Error("Unknown changed planning enrollment; lookup only");
		return {
			missionId: active.binding.missionId,
			ownerSessionId: active.binding.ownerSessionId,
			enrollmentId: active.binding.enrollmentId,
		};
	}
	private services(binding: PlanningWorkerBinding, guard: () => void) {
		const plans = new MissionPlans({
			...this.deps,
			authorize: guard,
			validateRound: (questions) => this.deps.store.interviews.assertNewQuestions(binding.missionId, questions),
		});
		const interviews = new MissionInterviews({
			...this.deps,
			authorize: () => {
				guard();
				return "planning-only";
			},
			adapter: {
				admit: async (op, request, exactGuard) => {
					if (request.purpose !== "interview-continue") throw new Conflict("Planning never admits builders");
					const state = this.scope(binding);
					return this.admitInput(state, op, () => {
						guard();
						exactGuard();
					});
				},
				lookup: async (op) => this.deps.sessions.lookupPlanning(this.input(this.scope(binding), op)),
			},
		});
		return { plans, interviews };
	}
	async call(
		binding: PlanningWorkerBinding,
		request: PlanningWorkerRequest,
		supervisor: () => void = () => {},
	): Promise<PlanningWorkerReply> {
		await this.turnAdmissions.get(binding.missionId);
		await this.admissions.get(binding.missionId);
		supervisor();
		let state = this.scope(binding);
		const authority = this.authority(binding),
			planBefore = hash(this.deps.store.plans.get(binding.missionId) ?? null),
			guard = () => {
				supervisor();
				if (this.authority(binding) !== authority) throw new Conflict("Planning authority changed");
				if (
					request.action === "questions" &&
					hash(this.deps.store.plans.get(binding.missionId) ?? null) !== planBefore
				)
					throw new Conflict("Question context changed");
			};
		const { plans, interviews } = this.services(binding, guard);
		if (request.action === "read")
			return {
				value:
					request.revision === undefined
						? await plans.view(binding.missionId)
						: await plans.read(binding.missionId, request.revision),
			};
		if (request.action === "knowledge")
			return { value: await plans.knowledge(binding.missionId, request.id, request.revision) };
		if (request.action === "receipt") {
			const op = this.deps.store.planningWorkers.operation(binding.missionId, request.operationId);
			if (!op) throw new Conflict("Exact retained planning operation required");
			const receipt = await this.deps.journal.lookup(op);
			guard();
			const current = this.scope(binding);
			return {
				value: receipt ?? { state: "pending", operationId: op.operationId },
				...(current.phase === "held" && current.hold?.operationId === op.operationId ? { hold: current.hold } : {}),
			};
		}
		interviewText(request.toolCallId, 256);
		const old = this.deps.store.planningWorkers.call(binding.missionId, request.toolCallId);
		if (old) {
			if (old.payload !== canonicalJSON(request.request)) throw new Conflict("Planning call payload changed");
			return this.call(binding, { action: "receipt", operationId: old.operationId });
		}
		if (
			state.phase !== "active" ||
			(request.action === "write"
				? !isPlanOperation(request.request.purpose)
				: request.request.purpose !== "interview-questions")
		)
			throw new Conflict("Planning is held or purpose unavailable");
		if (request.action === "questions")
			this.deps.store.interviews.assertNewQuestions(binding.missionId, request.request.questions);
		const payload = canonicalJSON(request.request),
			op: DurableOperation = {
				schemaVersion: 1,
				operationId: randomUUID(),
				producerId: binding.enrollmentId,
				sequence: state.revision,
				origin: binding.host,
				destination: binding.host,
				targetId: binding.missionId,
				kind: request.request.purpose,
				payload,
				payloadHash: payloadHash(payload),
				bindingId: authority,
				bindingGeneration: 1,
			};
		this.deps.store.planningWorkers.retain(binding.missionId, request.toolCallId, op);
		const opensRound = ["interview-questions", "plan-ask", "plan-review"].includes(op.kind);
		if (opensRound)
			state = this.deps.store.planningWorkers.change(binding.missionId, state.revision, (s) => {
				s.phase = "holding";
				s.pendingHold = { operationId: op.operationId, authority };
				s.continuation = null;
			});
		await this.deps.store.durable();
		guard();
		const receipt = await this.deps.journal.execute(op, (operation, entry) =>
			request.action === "write"
				? plans.admit(operation, entry.firstEntry)
				: interviews.admit(operation, entry.firstEntry),
		);
		if (opensRound && receipt.state === "accepted") {
			guard();
			state = await this.finishHold(state, op);
			guard();
			return {
				value: {
					receipt,
					interview: this.deps.store.interviews.latest(binding.missionId),
					status: "awaiting-answers",
				},
				hold: state.hold!,
			};
		}
		if (
			opensRound &&
			receipt.state === "rejected" &&
			!this.deps.store.interviews.lookup(op) &&
			!this.deps.store.plans.lookup(op)
		) {
			// A terminal rejection with no saved effect can release this operation's provisional hold.
			// Pending/missing receipts are never absence proof and stay held.
			this.deps.store.planningWorkers.change(binding.missionId, state.revision, (next) => {
				next.phase = "active";
				next.pendingHold = null;
			});
			await this.deps.store.durable();
			guard();
		}
		return { value: receipt, ...(receipt.state === "pending" ? { blocked: true } : {}) };
	}
	private async finishHold(state: PlanningWorkerState, op: DurableOperation): Promise<PlanningWorkerState> {
		const interview = this.deps.store.interviews.lookup(op);
		if (
			!state.pendingHold ||
			state.pendingHold.operationId !== op.operationId ||
			!interview ||
			!interview.questions.length
		)
			throw new Error("Unknown saved planning hold");
		if (this.deps.store.interviews.latest(op.targetId)?.revision !== interview.revision)
			throw new Error("Saved planning round changed before its hold");
		if (
			isPlanOperation(op.kind) &&
			canonicalJSON(this.deps.store.plans.get(op.targetId)) !== canonicalJSON(this.deps.store.plans.lookup(op))
		)
			throw new Error("Saved planning context changed before its hold");
		const round = {
			fence: interview.fence,
			revision: interview.revision,
			operationId: op.operationId,
			contextDigest: this.roundContext(state, state.pendingHold.authority),
		};
		const held = this.deps.store.planningWorkers.change(op.targetId, state.revision, (s) => {
			s.phase = "held";
			s.hold = round;
			s.pendingHold = null;
		});
		await this.deps.store.durable();
		return held;
	}
	/** Only a fresh explicit submit invokes this. Restarts/status/duplicate POSTs never schedule input. */
	submitted(missionId: string, submissionOperationId: string): void {
		const state = this.deps.store.planningWorkers.get(missionId);
		if (
			!state?.continuation ||
			state.continuation.entered ||
			JSON.parse(state.continuation.operation.payload).submissionOperationId !== submissionOperationId
		)
			return;
		const task = this.continue(state).catch(() => {
			/* Saved pending state remains Unknown; never replay. */
		});
		this.tasks.add(task);
		void task.finally(() => this.tasks.delete(task));
	}
	private async continue(state: PlanningWorkerState): Promise<void> {
		const op = state.continuation!.operation,
			binding = state.binding;
		const guard = () => {
			const current = this.scope(binding);
			if (
				!state.hold ||
				current.hold?.operationId !== state.hold.operationId ||
				this.roundContext(state, this.authority(binding)) !== state.hold.contextDigest ||
				canonicalJSON(current.continuation?.operation) !== canonicalJSON(op)
			)
				throw new Conflict("Submitted planning round or controls changed");
		};
		guard();
		await this.deps.sessions.planningIdle(binding.ownerSessionId, guard, this.closing.signal);
		guard();
		const latest = this.scope(binding);
		if (latest.continuation?.entered) return;
		let release!: () => void;
		const turnAdmission = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.turnAdmissions.set(binding.missionId, turnAdmission);
		try {
			this.deps.store.planningWorkers.change(binding.missionId, latest.revision, (s) => {
				s.continuation!.entered = true;
				s.phase = "continuing";
			});
			await this.deps.store.durable();
			guard();
			const service = this.services(binding, guard).interviews;
			const receipt = await this.deps.journal.execute(op, (o, entry) => service.admit(o, entry.firstEntry));
			if (receipt.state === "accepted") {
				const current = this.scope(binding);
				this.deps.store.planningWorkers.change(binding.missionId, current.revision, (s) => {
					s.phase = "active";
					s.hold = null;
				});
				await this.deps.store.durable();
			}
		} finally {
			if (this.turnAdmissions.get(binding.missionId) === turnAdmission)
				this.turnAdmissions.delete(binding.missionId);
			release();
		}
	}
	/** Recovery router only. Retained identities cannot be used by native human ingress. */
	owns(op: DurableOperation): boolean {
		if (op.kind === "planning-enroll") return true;
		const state = this.deps.store.planningWorkers.get(op.targetId);
		return (
			!!state &&
			(canonicalJSON(state.continuation?.operation) === canonicalJSON(op) ||
				canonicalJSON(this.deps.store.planningWorkers.operation(op.targetId, op.operationId)) === canonicalJSON(op))
		);
	}
	async recover(op: DurableOperation): Promise<unknown> {
		if (op.kind === "planning-enroll") {
			if (
				canonicalJSON((await this.deps.journal.lookup(op))?.result) !==
				canonicalJSON({ stage: "planning-enrollment-entered", payloadHash: op.payloadHash })
			)
				throw new Error("Unknown planning enrollment checkpoint");
			const state = this.deps.store.planningWorkers.enrollment(op.targetId);
			if (!state || canonicalJSON(state.creation) !== canonicalJSON(op))
				throw new Error("Unknown planning enrollment; lookup only");
			const initial = this.deps.store.planningWorkers.call(state.binding.missionId, "$initial");
			if (!initial || !(await this.deps.sessions.lookupPlanning(this.input(state, initial))))
				throw new Error("Unknown initial planning admission; no replay");
			return {
				missionId: state.binding.missionId,
				ownerSessionId: state.binding.ownerSessionId,
				enrollmentId: state.binding.enrollmentId,
			};
		}
		const state = this.deps.store.planningWorkers.get(op.targetId);
		if (!state) throw new Error("Unknown planning worker");
		if (op.kind === "interview-continue") {
			if (
				canonicalJSON(this.deps.store.planningWorkers.operation(op.targetId, op.operationId)) !==
					canonicalJSON(op) ||
				canonicalJSON((await this.deps.journal.lookup(op))?.result) !==
					canonicalJSON({ stage: "interview-effect-entered", purpose: op.kind, payloadHash: op.payloadHash })
			)
				throw new Error("Unknown continuation identity or checkpoint");
			const receipt = await this.deps.sessions.lookupPlanning(this.input(state, op));
			if (!receipt) throw new Error("Unknown planning admission; no replay");
			if (canonicalJSON(state.continuation?.operation) === canonicalJSON(op) && state.phase === "continuing") {
				this.deps.store.planningWorkers.change(op.targetId, state.revision, (next) => {
					next.phase = "active";
					next.hold = null;
				});
				await this.deps.store.durable();
			}
			return receipt;
		}
		const retained = this.deps.store.planningWorkers.operation(op.targetId, op.operationId);
		if (canonicalJSON(retained) !== canonicalJSON(op)) throw new Error("Unknown planning operation");
		const { plans, interviews } = this.services(state.binding, () => {});
		const receipt = await (isPlanOperation(op.kind) ? plans.admit(op, false) : interviews.admit(op, false));
		if (state.phase === "holding" && state.pendingHold?.operationId === op.operationId)
			await this.finishHold(state, op);
		return receipt;
	}
	status(missionId: string) {
		const state = this.deps.store.planningWorkers.get(missionId);
		if (!state) return { coordinatorProfile: "not-configured", continuation: "unavailable" };
		try {
			this.authority(state.binding);
			return {
				coordinatorProfile: 1,
				continuation: 1,
				phase: state.phase,
				continuationOperationId: state.continuation?.operation.operationId ?? null,
			};
		} catch {
			return { coordinatorProfile: "unavailable", continuation: "unavailable" };
		}
	}
	close(): Promise<void> {
		if (this.closed) return this.closed;
		this.closing.abort(new Error("Planning worker host is closing"));
		this.closed = Promise.allSettled([...this.tasks, ...this.admissions.values()]).then(() => {
			this.detach();
		});
		return this.closed;
	}
}
