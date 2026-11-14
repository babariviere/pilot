/** Authenticated native human ingress. Interviews never admit builders; explicit Start is separate. */
import type {
	DurableOperation,
	EntryRecord,
	OperationReceipt,
	PlanningActivity,
	PlanningChatPage,
	PlanningInventory,
	PlanningInventoryItem,
} from "@pilot/protocol";
import { Conflict, ServiceUnavailable } from "./errors.ts";
import { interviewDigest, interviewExact } from "./mission-interview-contract.ts";
import { isInterviewOperation, MissionInterviews } from "./mission-interviews.ts";
import { isPlanOperation, MissionPlans } from "./mission-plans.ts";
import type { MissionStore } from "./missions.ts";
import { canonicalJSON, type OperationJournal, OperationRejected, payloadHash, sameHost } from "./operation-journal.ts";
import { planningActivity, planningChatPage } from "./planning-activity.ts";
import type { PlanningWorkers } from "./planning-workers.ts";
import type { ProjectStore } from "./projects.ts";
import type { SessionManager } from "./sessions.ts";
import type { WorkflowConfirmations } from "./workflow-confirmations.ts";

export const isNativePlanningOperation = (kind: string) =>
	isInterviewOperation(kind) ||
	isPlanOperation(kind) ||
	["plan-start", "plan-revisit", "revision-preview", "revision-confirm"].includes(kind);
const humanKinds = [
	"interview-save",
	"interview-submit",
	"plan-start",
	"plan-revisit",
	"revision-preview",
	"revision-confirm",
];
/** Only the complete planning inventory limit, not general service unavailability. */
export class PlanningInventoryCapacity extends ServiceUnavailable {
	readonly limit: number;
	constructor(limit: number) {
		super("Planning inventory exceeds limit");
		this.limit = limit;
	}
}
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
	/** Complete, limited read. Any unqualified owner refuses the read, never silently hides a mission. */
	async inventory(projectId: string, limit = 100): Promise<PlanningInventory> {
		const { store, projects } = this.deps;
		const snapshot = () => {
			const project = projects.require(projectId);
			const ids = store.planningCandidates(projectId, limit);
			if (ids.length > limit) throw new PlanningInventoryCapacity(limit);
			const plans = new MissionPlans({
				...this.deps,
				authorize: (_purpose, missionId) => {
					this.scope(missionId, projectId);
				},
			});
			return {
				project,
				rows: ids.map((missionId) => {
					const { interview, plan, ownerFence } = plans.summary(missionId);
					const submitted =
						interview.submission?.fence.questionSetRevision === interview.fence.questionSetRevision;
					const review = plan?.review?.questionSetRevision === interview.fence.questionSetRevision;
					const stage: PlanningInventoryItem["stage"] =
						interview.questions.length && !submitted
							? review
								? "review"
								: "questions"
							: plan?.publication
								? "published"
								: !interview.questions.length || this.deps.workers?.status(missionId).continuation === 1
									? "planning"
									: "submitted";
					const replaces = store.replaced(missionId);
					const item: PlanningInventoryItem = {
						missionId,
						title: store.require(missionId).title,
						stage,
						needsYou: stage === "questions" || stage === "review",
						round: interview.fence,
						interviewRevision: interview.revision,
						planRevision: plan?.revision ?? null,
						...(replaces ? { replaces } : {}),
					};
					return { item, ownerFence };
				}),
			};
		};
		const pin = snapshot();
		const identity = canonicalJSON(pin);
		await store.durable();
		if (canonicalJSON(snapshot()) !== identity) throw new Conflict("Planning inventory changed");
		const items = pin.rows.map(({ item }) => item);
		return { version: 1, projectId, status: "available", limit, total: items.length, items };
	}

	/** The coordinator's live run. Passive: it reads the newest saved history only while the coordinator works. */
	private async activity(missionId: string): Promise<PlanningActivity> {
		const { coordinator } = this.scope(missionId);
		const working = coordinator.working ?? coordinator.state === "working";
		let entries: EntryRecord[] = [];
		if (working)
			try {
				entries = (await this.deps.sessions.history(coordinator.id, Number.MAX_SAFE_INTEGER, 8)).entries;
			} catch {
				// An unreadable history leaves the run without a step. It never hides that the coordinator works.
			}
		return planningActivity(
			// Test doubles may lack live workers; then times stay unknown.
			{ sessionId: coordinator.id, working, cwd: coordinator.cwd, ...this.deps.sessions.liveRun?.(coordinator.id) },
			entries,
		);
	}

	/** One compact page of the current planning coordinator's chat, oldest first. Never wakes or subscribes to it. */
	async chat(
		projectId: string,
		missionId: string,
		before = Number.MAX_SAFE_INTEGER,
		limit = 32,
	): Promise<PlanningChatPage> {
		if (!Number.isSafeInteger(before) || before < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
			throw new Error("Invalid planning chat cursor or limit");
		await this.deps.store.durable();
		const { coordinator } = this.scope(missionId, projectId);
		const history = await this.deps.sessions.history(coordinator.id, before, limit);
		if (this.scope(missionId, projectId).coordinator.id !== coordinator.id)
			throw new Conflict("Planning owner changed during read");
		return planningChatPage(
			{
				missionId,
				sessionId: coordinator.id,
				cwd: coordinator.cwd,
				newest: before === Number.MAX_SAFE_INTEGER,
			},
			history,
		);
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
					enrollment: "unavailable",
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
		const start = await this.deps.workers?.startView(missionId);
		const activity = await this.activity(missionId);
		const revision = this.revisionView(missionId);
		await this.deps.store.durable();
		check();
		if (canonicalJSON(revision) !== canonicalJSON(this.revisionView(missionId)))
			throw new Conflict("Revision view changed");
		return {
			version: 1,
			projectId,
			missionId,
			status: view.interview.questions.length ? "available" : "preparing",
			contextDigest: view.interview.questions.length ? contextDigest : null,
			questionDigests: Object.fromEntries(view.interview.questions.map((q) => [q.id, interviewDigest(q)])),
			start: start ?? { available: false, state: "unavailable", reason: "Start authority unavailable" },
			revisit: this.deps.workers?.revisitView(missionId) ?? {
				available: false,
				reason: "Trusted Revisit owner unavailable",
			},
			revision,
			activity,
			view: view.interview.questions.length ? view : null,
			capabilities: {
				answers: worker && worker.phase !== "held" ? "unavailable" : 1,
				enrollment: "unavailable",
				...(this.deps.workers?.status(missionId) ?? {
					coordinatorProfile: "not-configured",
					continuation: "unavailable",
				}),
				admission: start?.available ? 1 : "unavailable",
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
		if (["plan-start", "plan-revisit", "revision-preview", "revision-confirm"].includes(op.kind)) return;
		if (
			expected?.missionId !== op.targetId ||
			expected.ownerSessionId !== pin.interview.fence.ownerSessionId ||
			expected.enrollmentId !== pin.interview.fence.enrollmentId
		)
			throw new OperationRejected("Native interview owner or enrollment changed");
	}
	/** Authenticated exact receipt recovery, never a new turn or revision mutation. */
	async lookup(op: DurableOperation): Promise<OperationReceipt | undefined> {
		this.envelope(op);
		let receipt = await this.deps.journal.lookup(op);
		if (
			["plan-start", "plan-revisit", "revision-preview", "revision-confirm"].includes(op.kind) &&
			receipt?.state === "pending"
		) {
			// Inspect saved kernel/canonical effects under the original identity. Never re-enter them.
			receipt = await this.deps.journal.execute(op, () => this.admit(op, false));
		}
		this.envelope(op);
		return receipt;
	}
	/** Journal recovery is exact saved-effect lookup, never new authority or model dispatch. */
	async admit(op: DurableOperation, firstEntry = false): Promise<unknown> {
		if (op.kind === "plan-revisit") {
			if (!this.deps.workers) throw new OperationRejected("Revisit authority unavailable");
			if (firstEntry) {
				try {
					this.envelope(op);
				} catch (cause) {
					throw new OperationRejected(String(cause));
				}
			}
			return this.deps.workers.revisit(op, firstEntry);
		}
		if (["revision-preview", "revision-confirm"].includes(op.kind)) return this.revisionIntent(op, firstEntry);
		if (op.kind === "plan-start") {
			if (!this.deps.workers) throw new OperationRejected("Start authority unavailable");
			if (firstEntry) this.envelope(op);
			return this.deps.workers.start(op, firstEntry);
		}
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
	private revisionView(missionId: string) {
		const store = this.deps.store;
		return {
			source: store.revisions.source(missionId),
			pending: store.revisions.pending(missionId),
			latestConfirmed: store.revisions.latestConfirmed(missionId) ?? null,
			mission: store.require(missionId),
			brief: store.brief(missionId) ?? null,
			tasks: store.tasks(missionId),
			decisions: store.workflowConfirmationState(missionId).decisions,
			control: store.controls.current(missionId),
		};
	}
	private async revisionIntent(op: DurableOperation, firstEntry: boolean) {
		const store = this.deps.store;
		const request: { purpose: string; proposalId: string; digest: string; source: string } = JSON.parse(op.payload);
		if (!firstEntry) {
			const saved =
				op.kind === "revision-preview"
					? store.revisions.lookup(op.targetId, op.operationId)
					: store.revisions.get(op.targetId, request.proposalId);
			if (
				!saved ||
				(op.kind === "revision-confirm" &&
					(saved.digest !== request.digest ||
						saved.confirmation?.humanSource !== `native-revision:${op.operationId}`))
			)
				throw new Error("Unknown revision effect; lookup only");
			await store.durable();
			return saved;
		}
		try {
			this.envelope(op);
			interviewExact(request, ["purpose", "proposalId", "digest", "source"]);
			if (
				request.purpose !== op.kind ||
				request.source !== store.revisions.source(op.targetId) ||
				op.bindingId !== request.source
			)
				throw new Conflict("Exact current revision source required");
			const saved = store.revisions.get(op.targetId, request.proposalId);
			if (saved.digest !== request.digest || saved.confirmation)
				throw new Conflict("Exact pending revision required");
			return op.kind === "revision-preview"
				? await store.revisions.repreview(op.targetId, saved.id, {
						operationId: op.operationId,
						source: request.source,
						digest: request.digest,
					})
				: await store.revisions.confirm(op.targetId, saved.id, {
						digest: request.digest,
						humanSource: `native-revision:${op.operationId}`,
					});
		} catch (cause) {
			const saved =
				op.kind === "revision-preview"
					? store.revisions.lookup(op.targetId, op.operationId)
					: store.revisions.get(op.targetId, request.proposalId);
			if (saved && (op.kind === "revision-preview" || saved.confirmation))
				throw new Error("Unknown saved revision; lookup only", { cause });
			throw new OperationRejected(String(cause));
		}
	}
}
