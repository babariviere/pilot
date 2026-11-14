/** Trusted planning worker lifecycle. No existing chat adoption or generic send fallback. */
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
import { taskMessage } from "./mission-service.ts";
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
	/** An old mission this one re-plans. Linked in the enrollment transaction; the old mission is not changed. */
	replaces?: string;
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
		const missionId = state.binding.missionId;
		return hash({
			authority,
			plan: this.deps.store.plans.get(missionId) ?? null,
			...(this.deps.store.interviews.latest(missionId)?.kind === "revisit"
				? { briefRevision: this.deps.store.brief(missionId)?.revision }
				: {}),
		});
	}
	private input(state: PlanningWorkerState, op: DurableOperation): PlanningInput {
		const submitted = this.deps.store.interviews.latest(state.binding.missionId)?.submission;
		return {
			binding: state.binding,
			operation: op,
			hold: op.kind === "interview-continue" ? state.hold : null,
			content:
				op.kind === "thread-send"
					? this.discussionContent(op)
					: op.kind === "plan-revisit"
						? "The user explicitly requested a planning-only Revisit. Read mission_plan for current agreement, active decisions, tasks and settled answers. Use the trusted upstream skills. Keep settled answers; ask only genuinely new gaps in one saved kind=revisit round. Save an inert revision with action revision when ready. Never publish a creation plan, change agreement, approve or start execution."
						: op.kind === "interview-continue"
							? `Continue planning from this exact submitted interview. Answers are not build permission. Use the trusted native planning skills and records only.\n${canonicalJSON(submitted)}`
							: `Plan this requested outcome using the trusted upstream skills. Read mission_plan, then publish the complete first saved round with action questions. Do not ask inside ask_user or start implementation.\n${state.goal}`,
		};
	}
	private discussionContent(op: DurableOperation): string {
		// Reconstruct from the immutable intent, never today's topic revision or a copied transcript.
		const topic = this.deps.store.threads.lookup(op);
		if (!topic) throw new Error("Exact saved topic intent required");
		const context = { id: topic.id, title: topic.title, references: topic.references, inputs: topic.inputs };
		return `Discuss this one mission topic using lightweight clarification. The quoted user text is discussion, not execution, Start, agreement acceptance or approval. Read current mission records; use Wayfinder only if needed. Do not change the agreement or start work. Topic references (not a separate transcript): ${canonicalJSON(context)}\nOriginal input ${op.operationId}: ${JSON.stringify(JSON.parse(op.payload).text)}`;
	}
	private revisitPin(missionId: string) {
		const state = this.deps.store.planningWorkers.get(missionId);
		if (
			state?.phase !== "active" ||
			state.hold ||
			state.pendingHold ||
			this.admissions.has(missionId) ||
			this.turnAdmissions.has(missionId)
		)
			throw new Conflict("Revisit needs an active, unheld planner");
		const authority = this.authority(state.binding);
		const identity = this.deps.sessions.planningIdentity(state.binding.ownerSessionId) as { inputGeneration: number };
		const owner = this.deps.sessions.get(state.binding.ownerSessionId);
		if (
			identity.inputGeneration !== 0 ||
			owner?.working ||
			owner?.state !== "idle" ||
			!this.deps.store.plans.get(missionId)?.publication
		)
			throw new Conflict("Published, unstopped planning owner required");
		return { authority, source: this.deps.store.revisions.source(missionId), revision: state.revision };
	}
	revisitView(missionId: string) {
		try {
			const pin = this.revisitPin(missionId);
			return { available: true, source: pin.source, contextDigest: hash(pin), reason: "" };
		} catch (e) {
			return { available: false, reason: e instanceof Error ? e.message : "Revisit unavailable" };
		}
	}
	/** Same qualified unheld planning boundary as Revisit, with a distinct discussion purpose. */
	discuss(op: DurableOperation, guard: () => void): Promise<unknown> {
		const work = this.planningTurnEntered(op, true, guard);
		this.tasks.add(work);
		void work.finally(() => this.tasks.delete(work)).catch(() => {});
		return work;
	}
	/** Only authenticated native user ingress enters. Recovery never re-admits a turn. */
	revisit(op: DurableOperation, firstEntry: boolean): Promise<unknown> {
		if (this.closing.signal.aborted) return Promise.reject(new Error("Planning host is closing"));
		const work = this.planningTurnEntered(op, firstEntry);
		this.tasks.add(work);
		void work.finally(() => this.tasks.delete(work)).catch(() => {});
		return work;
	}
	private async planningTurnEntered(
		op: DurableOperation,
		firstEntry: boolean,
		discussionGuard?: () => void,
	): Promise<unknown> {
		if (!firstEntry) return this.recover(op);
		const discussion = op.kind === "thread-send" && !!discussionGuard;
		let pin: ReturnType<PlanningWorkers["revisitPin"]>;
		try {
			const request = JSON.parse(op.payload);
			interviewExact(request, discussion ? ["purpose", "source", "topicId", "text"] : ["purpose", "source"]);
			discussionGuard?.();
			pin = this.revisitPin(op.targetId);
			if (
				(!discussion && op.kind !== "plan-revisit") ||
				request.purpose !== op.kind ||
				(!discussion && (request.source !== pin.source || op.bindingId !== hash(pin))) ||
				op.bindingGeneration !== 1 ||
				op.origin.hostId !== "local" ||
				!sameHost(op.origin, this.deps.journal.destination) ||
				!sameHost(op.destination, this.deps.journal.destination)
			)
				throw new Conflict("Exact user Revisit preview required");
		} catch (e) {
			throw new OperationRejected(String(e));
		}
		await this.deps.journal.checkpoint(op, {
			stage: discussion ? "discussion-entered" : "revisit-entered",
			payloadHash: op.payloadHash,
		});
		discussionGuard?.();
		if (hash(this.revisitPin(op.targetId)) !== hash(pin)) throw new Conflict("Revisit context changed");
		const prior = this.deps.store.planningWorkers.get(op.targetId)!;
		this.deps.store.planningWorkers.retain(
			op.targetId,
			`$${discussion ? "discussion" : "revisit"}:${op.operationId}`,
			op,
		);
		const state = this.deps.store.planningWorkers.change(op.targetId, prior.revision, (s) => {
			if (discussion) s.discussion = { operation: op, admitted: false };
			else s.revisit = { operation: op, admitted: false };
			s.phase = discussion ? "discussing" : "revisiting";
		});
		let release!: () => void;
		const turn = new Promise<void>((r) => {
			release = r;
		});
		this.turnAdmissions.set(op.targetId, turn);
		const guard = () => {
			discussionGuard?.();
			if (
				this.closing.signal.aborted ||
				this.authority(state.binding) !== pin.authority ||
				this.deps.store.revisions.source(op.targetId) !== pin.source ||
				this.scope(state.binding).revision !== state.revision
			)
				throw new Conflict("Revisit admission changed");
		};
		try {
			await this.deps.store.durable();
			guard();
			const receipt = await this.admitInput(state, op, guard);
			guard();
			this.deps.store.planningWorkers.change(op.targetId, state.revision, (s) => {
				if (discussion) s.discussion!.admitted = true;
				else s.revisit!.admitted = true;
				s.phase = "active";
			});
			await this.deps.store.durable();
			return receipt;
		} finally {
			this.turnAdmissions.delete(op.targetId);
			release();
		}
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
			const keys = [
				"purpose",
				"projectId",
				"ownerSessionId",
				"title",
				"goal",
				"model",
				"profile",
				"configurationDigest",
			];
			if (request && typeof request === "object" && Object.hasOwn(request, "replaces")) keys.push("replaces");
			interviewExact(request, keys);
			interviewId(op.targetId);
			interviewId(request.projectId);
			interviewId(request.ownerSessionId);
			if (request.replaces !== undefined) interviewId(request.replaces);
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
			if (request.replaces !== undefined) this.deps.store.assertReplaceable(request.replaces, request.projectId);
		};
		try {
			check();
		} catch (e) {
			throw new OperationRejected(e instanceof Error ? e.message : String(e));
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
			if (request.replaces !== undefined)
				this.deps.store.linkSuccessor(
					request.replaces,
					interview.fence.missionId,
					request.projectId,
					op.operationId,
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
		const published = !!this.deps.store.plans.get(binding.missionId)?.publication;
		if (request.action === "read")
			return {
				value:
					published && request.revision === undefined
						? await this.revisitContext(binding, guard)
						: request.revision === undefined
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
			(request.action === "revision"
				? !published || !state.revisit?.admitted
				: request.action === "write"
					? !isPlanOperation(request.request.purpose)
					: request.request.purpose !== "interview-questions")
		)
			throw new Conflict("Planning is held or purpose unavailable");
		if (
			published &&
			(request.action === "write" ||
				!state.revisit?.admitted ||
				(request.action === "questions" && request.request.kind !== "revisit"))
		)
			throw new Conflict("Published planning only saves requested Revisit questions or inert revisions");
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
		// Every retained call consumes a producer sequence, not only calls opening an interview.
		state = this.deps.store.planningWorkers.change(binding.missionId, state.revision, (s) => {
			if (opensRound) {
				s.phase = "holding";
				s.pendingHold = { operationId: op.operationId, authority };
				s.continuation = null;
			}
		});
		await this.deps.store.durable();
		guard();
		const receipt = await this.deps.journal.execute(op, (operation, entry) =>
			request.action === "revision"
				? this.revision(operation, entry.firstEntry, binding, guard)
				: request.action === "write"
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
	private async revisitContext(binding: PlanningWorkerBinding, guard: () => void) {
		const store = this.deps.store;
		const snapshot = () => ({
			mission: store.require(binding.missionId),
			agreement: store.brief(binding.missionId),
			decisions: store.workflowConfirmationState(binding.missionId).decisions,
			tasks: store.tasks(binding.missionId),
			revisionDelta: store.revisions.latestConfirmed(binding.missionId) ?? null,
			revisionSource: store.revisions.source(binding.missionId),
			interview: store.interviews.latest(binding.missionId),
			settledAnswers: store.interviews.history(binding.missionId).map((h) => h.interview.submission),
			knowledge: store.knowledge.list(binding.projectId, { missionId: binding.missionId }, undefined, 40),
		});
		const pin = snapshot();
		await store.durable();
		guard();
		if (hash(pin) !== hash(snapshot())) throw new Conflict("Revisit context changed");
		return pin;
	}
	private async revision(
		op: DurableOperation,
		firstEntry: boolean,
		binding: PlanningWorkerBinding,
		guard: () => void,
	) {
		if (!firstEntry) {
			const saved = this.deps.store.revisions.lookup(op.targetId, op.operationId);
			if (!saved) throw new Error("Unknown revision; lookup only");
			await this.deps.store.durable();
			return saved;
		}
		const request: Extract<PlanningWorkerRequest, { action: "revision" }>["request"] = JSON.parse(op.payload);
		try {
			interviewExact(request, ["purpose", "source", "summary", "delta"]);
			if (request.purpose !== "revision-propose") throw new Conflict("Inert revision required");
			guard();
			return await this.deps.store.revisions.propose(
				op.targetId,
				{ operationId: op.operationId, source: request.source, summary: request.summary, delta: request.delta },
				{ sessionId: binding.ownerSessionId },
			);
		} catch (e) {
			if (this.deps.store.revisions.lookup(op.targetId, op.operationId))
				throw new Error("Unknown saved revision; lookup only", { cause: e });
			throw new OperationRejected(String(e));
		}
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
		if (op.kind === "plan-revisit" || op.kind === "thread-send") {
			const state = this.deps.store.planningWorkers.get(op.targetId);
			const retained = op.kind === "thread-send" ? state?.discussion : state?.revisit;
			if (!state || canonicalJSON(retained?.operation) !== canonicalJSON(op))
				throw new Error("Unknown Revisit identity; lookup only");
			const receipt = await this.deps.sessions.lookupPlanning(this.input(state, op));
			if (!receipt) throw new Error("Unknown Revisit admission; no replay");
			if (state.phase === (op.kind === "thread-send" ? "discussing" : "revisiting")) {
				this.deps.store.planningWorkers.change(op.targetId, state.revision, (s) => {
					s.phase = "active";
					if (op.kind === "thread-send") s.discussion!.admitted = true;
					else s.revisit!.admitted = true;
				});
				await this.deps.store.durable();
			}
			return receipt;
		}
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
		if (op.kind === "revision-propose") return this.revision(op, false, state.binding, () => {});
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
	/** Start uses the existing task model selection and Build policy, not a new budget or grant. */
	private startPin(missionId: string) {
		const { store, sessions, projects } = this.deps;
		const state = store.planningWorkers.get(missionId);
		if (!state) throw new Conflict("Trusted planning owner unavailable");
		this.scope(state.binding);
		sessions.assertPlanningOpen(state.binding.ownerSessionId);
		const control = store.controls.fenceCurrent(missionId),
			plan = store.plans.get(missionId);
		if (
			control.held ||
			!plan?.publication ||
			plan.publication.briefRevision !== store.brief(missionId)?.revision ||
			plan.publication.submissionDigest !== store.interviews.latest(missionId)?.submission?.digest
		)
			throw new Conflict("Current published agreement required; mission may be held");
		const identity = sessions.planningIdentity(state.binding.ownerSessionId) as {
			inputGeneration: number;
			permission?: { level: string };
		};
		if (identity.inputGeneration !== 0)
			throw new Conflict("Planning owner was stopped or reconfigured; Start unavailable");
		const permission = identity.permission;
		if (permission?.level === "investigate") throw new Conflict("Build permission unavailable");
		const { updatedAt: _updated, ...mission } = store.require(missionId);
		return {
			binding: state.binding,
			project: projects.require(state.binding.projectId),
			owner: sessions.planningIdentity(state.binding.ownerSessionId),
			mission,
			ownerFence: store.interviewOwnerFence(missionId, state.binding.ownerSessionId),
			interview: store.interviews.latest(missionId),
			plan,
			brief: store.brief(missionId),
			control,
			tasks: store.tasks(missionId),
			decisions: store.workflowConfirmationState(missionId).decisions,
		};
	}
	async startView(missionId: string) {
		const state = this.deps.store.planningWorkers.get(missionId);
		const worker = state?.start ? this.deps.sessions.get(state.start.sessionId) : undefined;
		if (state?.start)
			return {
				available: false as const,
				state: state.start.admitted ? "admitted" : "unknown",
				execution: worker?.working ? "working" : worker ? "not-running" : "unavailable",
				operationId: state.start.operation.operationId,
				sessionId: state.start.sessionId,
				taskId: state.start.taskId,
				reason: state.start.admitted
					? worker?.working
						? "One background task admitted and working. Reports show its progress."
						: "One background task admitted, not running now. Read its report."
					: "Start is not confirmed. Check only; do not start again.",
			};
		try {
			const pin = this.startPin(missionId);
			const task = pin.plan
				.publication!.tasks.map(({ taskId }) => pin.tasks.find((t) => t.id === taskId)!)
				.find(
					(t) =>
						t?.status === "todo" &&
						!t.sessionId &&
						!(t.dependsOn ?? []).some((id) => pin.tasks.find((d) => d.id === id)?.status !== "done"),
				);
			if (!task) throw new Conflict("No published task is ready");
			const slice = pin.plan.slices.find((s) =>
				pin.plan.publication!.tasks.some((p) => p.sliceId === s.id && p.taskId === task.id),
			)!;
			const body = `${slice.outcome}\n\nSpec revision: ${pin.plan.publication!.briefRevision}\nStories: ${slice.storyIds.join(", ")}\nOwnership: ${slice.owners.join(", ")}\n\nAcceptance:\n${slice.acceptance.map((s) => `- ${s}`).join("\n")}`;
			const dependencies = slice.dependsOn.map(
				(id) => pin.plan.publication!.tasks.find((p) => p.sliceId === id)!.taskId,
			);
			if (
				task.title !== slice.title ||
				task.body !== body ||
				canonicalJSON(task.dependsOn ?? []) !== canonicalJSON(dependencies) ||
				task.assignment ||
				task.decisionIds?.length
			)
				throw new Conflict("Task scope changed since publication; no Start authority");
			this.deps.store.prepareTaskStart(missionId, [task.id]);
			const selection = await this.deps.sessions.selectTaskModel(
				pin.project.path,
				task.preferredModel,
				task.preferredThinking,
			);
			if (hash(this.startPin(missionId)) !== hash(pin)) throw new Conflict("Start context changed");
			return {
				available: true as const,
				state: "ready",
				revision: pin.plan.revision,
				digest: pin.plan.publication!.digest,
				taskId: task.id,
				title: task.title,
				project: pin.project.name,
				access: (pin.owner as { permission?: { level: string } }).permission?.level ?? "build",
				...selection,
				contextDigest: hash({ pin, selection }),
				reason: "",
			};
		} catch (e) {
			return {
				available: false as const,
				state: "unavailable",
				reason: e instanceof Error ? e.message : "Start authority unavailable",
			};
		}
	}
	/** Only an authenticated, explicit native Start enters this method. No submission calls it. */
	start(op: DurableOperation, firstEntry: boolean): Promise<unknown> {
		if (this.closing.signal.aborted) return Promise.reject(new Error("Planning host is closing; lookup unavailable"));
		const work = this.startEntered(op, firstEntry);
		this.tasks.add(work);
		void work.finally(() => this.tasks.delete(work)).catch(() => {});
		return work;
	}
	private async startEntered(op: DurableOperation, firstEntry: boolean): Promise<unknown> {
		if (!firstEntry) return this.recoverStart(op);
		const { store, sessions } = this.deps;
		let pin: ReturnType<PlanningWorkers["startPin"]>, selection: { model: string; thinking: string }, taskId: string;
		try {
			const request = JSON.parse(op.payload);
			interviewExact(request, ["purpose", "expectedRevision", "planDigest", "taskId"]);
			const view = await this.startView(op.targetId);
			if (
				!view.available ||
				op.kind !== "plan-start" ||
				request.purpose !== op.kind ||
				request.expectedRevision !== view.revision ||
				request.planDigest !== view.digest ||
				request.taskId !== view.taskId ||
				op.bindingId !== view.contextDigest ||
				op.bindingGeneration !== 1 ||
				op.origin.hostId !== "local" ||
				!sameHost(op.origin, this.deps.journal.destination) ||
				!sameHost(op.destination, this.deps.journal.destination)
			)
				throw new Conflict("Exact published Start context changed or unavailable");
			pin = this.startPin(op.targetId);
			selection = { model: view.model!, thinking: view.thinking! };
			taskId = view.taskId!;
			if (hash({ pin, selection }) !== op.bindingId) throw new Conflict("Start context changed");
		} catch (e) {
			throw new OperationRejected(e instanceof Error ? e.message : "Invalid Start");
		}
		const sessionId = randomUUID(),
			task = pin.tasks.find((t) => t.id === taskId)!;
		const check = (claimed: boolean) => {
			const current = this.startPin(op.targetId);
			if (claimed) {
				const actual = current.tasks.find((t) => t.id === taskId);
				if (!actual || actual.sessionId !== sessionId || actual.status !== "in_progress")
					throw new Conflict("Start assignment changed");
				// Only this admission's exact claim may differ from the approved task snapshot.
				current.tasks = current.tasks.map((t) =>
					t.id !== taskId
						? t
						: { ...t, sessionId: task.sessionId, status: task.status, updatedAt: task.updatedAt },
				);
			}
			if (hash(current) !== hash(pin)) throw new Conflict("Published plan, owner, project or controls changed");
		};
		try {
			check(false);
			await this.deps.journal.checkpoint(op, { stage: "plan-start-entered", payloadHash: op.payloadHash });
			check(false);
			const state = store.planningWorkers.get(op.targetId)!;
			if (state.start) throw new Conflict("Start already entered; check only");
			store.planningWorkers.change(op.targetId, state.revision, (s) => {
				s.start = { operation: op, sessionId, taskId, admitted: false };
			});
		} catch (e) {
			throw new OperationRejected(e instanceof Error ? e.message : "Start refused");
		}
		await store.durable(); // Reservation and immutable identity precede every worker effect.
		check(false);
		const result = await sessions.admitPublishedTask(
			{
				projectId: pin.project.id,
				missionId: op.targetId,
				message: taskMessage([task]),
				title: task.title,
				mode: "build",
				...selection,
			},
			{ sessionId, taskId, operationId: op.operationId, ownerSessionId: pin.binding.ownerSessionId },
			check,
		);
		const state = store.planningWorkers.get(op.targetId)!;
		store.planningWorkers.change(op.targetId, state.revision, (s) => {
			s.start!.admitted = true;
		});
		await store.durable();
		return result;
	}
	private async recoverStart(op: DurableOperation) {
		const start = this.deps.store.planningWorkers.get(op.targetId)?.start;
		if (
			!start ||
			canonicalJSON(start.operation) !== canonicalJSON(op) ||
			!(await this.deps.sessions.lookupPublishedTask(start.sessionId, op.operationId))
		)
			throw new Error("Unknown Start admission; exact lookup only, no replay");
		const state = this.deps.store.planningWorkers.get(op.targetId)!;
		if (!state.start!.admitted)
			this.deps.store.planningWorkers.change(op.targetId, state.revision, (s) => {
				s.start!.admitted = true;
			});
		await this.deps.store.durable();
		return { admissionId: op.operationId, sessionId: start.sessionId };
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
