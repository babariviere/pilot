/** Event-driven admission of exact coordinator-requested slices. A todo task is not authority. */
import { randomUUID } from "node:crypto";
import type { StartMissionTaskRequest } from "@pilot/protocol";
import { Conflict, NotFound } from "./errors.ts";
import type { MissionStore } from "./missions.ts";
import { canonicalJSON } from "./operation-journal.ts";
import { RuntimeBackground } from "./runtime-background.ts";

export interface MissionContinuation {
	version: 1;
	operationId: string;
	missionId: string;
	coordinatorId: string;
	targetId: string;
	taskIds: string[];
	request: StartMissionTaskRequest;
	source: string;
	hostFence: string;
	stopGeneration: number;
	pauseGeneration: number;
	policySource?: AllowedContinuationPolicy;
	state: "waiting" | "entered" | "started" | "unknown" | "invalidated";
	reason: string;
}
/** Trusted host observations, not agent-provided flags or new grants. IDs pin actual authority rows. */
export interface AllowedContinuationPolicy {
	version: 1;
	state: "allowed";
	dispatch: { authorizationId: string; revision: number };
	model: { sourceId: string; revision: string; model: string; thinking: string };
	budget: { authorityId: string; revision: number };
}
export type ContinuationPolicy =
	| AllowedContinuationPolicy
	| {
			version: 1;
			state: "blocked" | "unavailable";
			gate: "dispatch" | "model" | "budget";
			reason: string;
	  };
export interface ContinuationPolicySource {
	/** Synchronous, authoritative check of exact scope, permissions, model and remaining budget.
	 * Must reject pending/revoked/unknown authority, including same-state reapproval with different IDs.
	 * This is called again at metadata commit and actual initial-input dispatch, not only selection. */
	current(record: Readonly<MissionContinuation>): ContinuationPolicy;
	onChange(listener: () => void): () => void;
}
export interface ContinuationHost {
	fence(coordinatorId: string): string;
	assertTaskHolds(missionId: string, taskIds: string[]): void;
	occupied(missionId: string, excludeId?: string): number;
	start(record: MissionContinuation, guard: () => void): Promise<void>;
	/** Passive exact receipt lookup only. Absence is not permission to retry. */
	lookup(record: MissionContinuation): Promise<boolean>;
}
class ContinuationChanged extends Conflict {}

export class MissionContinuations {
	readonly runtime = new RuntimeBackground("mission-continuation", () => this.schedule());
	private stopped = true;
	private running?: Promise<void>;
	private dirty = false;
	private scheduled = false;
	private readonly store: MissionStore;
	private readonly host: ContinuationHost;
	private policySource?: ContinuationPolicySource;
	private stopPolicy?: () => void;
	constructor(store: MissionStore, host: ContinuationHost) {
		this.store = store;
		this.host = host;
		store.onChange(() => this.schedule());
	}
	setPolicySource(source: ContinuationPolicySource): void {
		if (this.policySource) throw new Conflict("Continuation policy source is already bound");
		this.policySource = source;
		this.stopPolicy = source.onChange(() => this.schedule());
		this.schedule();
	}
	start(): void {
		this.stopped = false;
		this.schedule();
	}
	async stop(): Promise<void> {
		this.stopped = true;
		this.stopPolicy?.();
		await this.running;
	}
	/** Coalesce event bursts. Blocked records have no timer and no self-generated wake. */
	schedule(): void {
		this.dirty = true;
		if (this.stopped || this.runtime.frozen || this.running || this.scheduled) return;
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			void this.flush().catch((error) => console.warn(`pilotd: continuation reconciliation failed: ${error}`));
		});
	}
	flush(): Promise<void> {
		if (this.running) return this.running;
		if (this.stopped || this.runtime.frozen) return Promise.resolve();
		this.dirty = false;
		this.running = this.runtime
			.run("reconcile", () => this.reconcile())
			.finally(() => {
				this.running = undefined;
				if (this.dirty) this.schedule();
			});
		return this.running;
	}
	private source(missionId: string, taskIds: string[], admittedTarget?: string): string {
		const mission = this.store.require(missionId),
			context = this.store.allocationContextFence(missionId);
		return canonicalJSON({
			projectId: mission.projectId,
			coordinatorId: mission.coordinatorSessionId,
			briefRevision: context.briefRevision,
			decisionEventId: context.decisionEventId,
			coordinatorEventId: context.coordinatorEventId,
			tasks: taskIds.map((id) => {
				const task = this.store.task(missionId, id);
				const admitted = !!admittedTarget && task.sessionId === admittedTarget && task.status === "in_progress";
				return {
					id,
					owner: admitted ? null : (task.sessionId ?? null),
					definitionRevision: this.store.sharedDefinitionRevision(id) - (admitted ? 1 : 0),
					assignment: task.assignment ?? null,
					model: task.preferredModel,
					thinking: task.preferredThinking,
				};
			}),
		});
	}
	async enqueue(
		missionId: string,
		coordinatorId: string,
		operationId: string,
		refs: string[],
		request: StartMissionTaskRequest,
	) {
		if (!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) throw new Error("start requires a stable operationId");
		if (canonicalJSON(request).length > 16000) throw new Error("Start request is too large");
		const mission = this.store.require(missionId);
		if (mission.coordinatorSessionId !== coordinatorId || this.store.missionOf(coordinatorId) !== missionId)
			throw new Conflict("Only the current coordinator may queue starts");
		const taskIds = [...new Set(refs.map((ref) => this.store.resolveTask(missionId, ref).id))];
		if (!taskIds.length || taskIds.length > 100) throw new Error("start requires 1 to 100 tasks");
		const prior = this.store.controls.continuation(operationId);
		if (prior) {
			if (
				canonicalJSON([missionId, coordinatorId, taskIds, request]) !==
				canonicalJSON([prior.missionId, prior.coordinatorId, prior.taskIds, prior.request])
			)
				throw new Conflict("Start operation identity reused");
			await this.store.durable();
			return prior; // Lookup only, including Unknown. Never re-enqueue an entered effect.
		}
		const controls = this.store.controls.fenceCurrent(missionId);
		if (this.store.controls.unsettledContinuationCount() >= 128) throw new Conflict("Continuation queue is full");
		if (controls.held || mission.status !== "active" || this.store.passiveLifecycle(missionId))
			throw new Conflict("Mission is held");
		for (const id of taskIds) {
			const task = this.store.task(missionId, id);
			if (task.sessionId || task.status !== "todo") throw new Conflict("Queue only unclaimed todo tasks");
		}
		if (
			this.store.controls
				.continuations(missionId, true)
				.some(
					(r) =>
						["waiting", "entered", "unknown"].includes(r.state) && r.taskIds.some((id) => taskIds.includes(id)),
				)
		)
			throw new Conflict("Task already has a queued or uncertain start; look up its original operation");
		const record: MissionContinuation = {
			version: 1,
			operationId,
			missionId,
			coordinatorId,
			taskIds,
			request: structuredClone(request),
			targetId: randomUUID(),
			source: this.source(missionId, taskIds),
			hostFence: this.host.fence(coordinatorId),
			stopGeneration: controls.stopGeneration,
			pauseGeneration: controls.pauseGeneration,
			state: "waiting",
			reason: "Awaiting fresh reconciliation",
		};
		this.store.controls.saveContinuation(record);
		await this.store.durable();
		this.schedule();
		return record;
	}
	/** Guards a saved initial input too. Recovery never re-enters creation or repairs membership. */
	inputAllowed(sessionId: string, operationId: string): boolean {
		const record = this.store.controls.continuation(operationId);
		if (!record || record.targetId !== sessionId || !["entered", "started", "unknown"].includes(record.state))
			return false;
		try {
			this.assertCurrent(record, true);
			return true;
		} catch (error) {
			record.reason = `Initial input held: ${error instanceof Error ? error.message : "Current policy unavailable"}`;
			this.store.controls.saveContinuation(record);
			return false;
		}
	}
	private currentPolicy(record: MissionContinuation): AllowedContinuationPolicy {
		const policy = this.policySource?.current(record);
		if (!policy) throw new Conflict("Dispatch policy unavailable: no qualified current dispatch/model/budget source");
		if (policy.version !== 1) throw new Conflict("Dispatch policy version is unavailable");
		if (policy.state !== "allowed") throw new Conflict(`${policy.gate} policy ${policy.state}: ${policy.reason}`);
		if (
			!policy.dispatch.authorizationId ||
			!Number.isSafeInteger(policy.dispatch.revision) ||
			policy.dispatch.revision < 0 ||
			!policy.model.sourceId ||
			!policy.model.revision ||
			!policy.model.model ||
			!policy.model.thinking ||
			!policy.budget.authorityId ||
			!Number.isSafeInteger(policy.budget.revision) ||
			policy.budget.revision < 0
		)
			throw new Conflict("Dispatch policy source is incomplete");
		if (record.policySource && canonicalJSON(record.policySource) !== canonicalJSON(policy))
			throw new ContinuationChanged(
				"Current dispatch/model/budget authority changed; reconcile before a new request",
			);
		return policy;
	}
	private assertCurrent(record: MissionContinuation, savedInput = false): void {
		if (record.version !== 1) throw new ContinuationChanged("Continuation version is unavailable");
		this.currentPolicy(record);
		this.host.assertTaskHolds(record.missionId, record.taskIds);
		const mission = this.store.require(record.missionId),
			controls = this.store.controls.fenceCurrent(record.missionId);
		if (mission.status !== "active" || this.store.passiveLifecycle(record.missionId))
			throw new ContinuationChanged("Mission lifecycle changed; a fresh authorized request is required");
		if (
			(!savedInput && (this.stopped || this.runtime.frozen)) ||
			mission.status !== "active" ||
			this.store.passiveLifecycle(record.missionId) ||
			controls.held
		)
			throw new Conflict("Mission is paused, archived or unavailable");
		if (
			controls.stopGeneration !== record.stopGeneration ||
			controls.pauseGeneration !== record.pauseGeneration ||
			this.host.fence(record.coordinatorId) !== record.hostFence ||
			this.source(record.missionId, record.taskIds, record.targetId) !== record.source
		)
			throw new ContinuationChanged(
				"Start authority, owner, assignment or scope changed; reconcile before a new request",
			);
		const uncertain = this.store.controls
			.continuations(record.missionId, true)
			.filter((r) => r.operationId !== record.operationId && (r.state === "entered" || r.state === "unknown"));
		if (this.host.occupied(record.missionId, record.targetId) + uncertain.length >= 2)
			throw new Conflict("Waiting for a worker slot (2 occupied, reviewers included)");
		// Canonical order is authoritative. Never choose a later queued slice around a blocked earlier slice.
		const queued = this.store.controls
			.continuations(record.missionId, true)
			.filter((r) => r.state === "waiting" || r.operationId === record.operationId);
		const order = (r: MissionContinuation) =>
			Math.min(
				...r.taskIds.map((id) => {
					try {
						return this.store.task(r.missionId, id).order;
					} catch {
						return Infinity;
					}
				}),
			);
		const number = (r: MissionContinuation) =>
			Math.min(
				...r.taskIds.map((id) => {
					try {
						const task = this.store.task(r.missionId, id);
						return task.order === order(r) ? task.number : Infinity;
					} catch {
						return Infinity;
					}
				}),
			);
		if (
			queued.some(
				(r) =>
					r.operationId !== record.operationId &&
					(order(r) < order(record) || (order(r) === order(record) && number(r) < number(record))),
			)
		)
			throw new Conflict("Waiting for an earlier queued priority");
		if (
			this.store.controls.orderPinned(record.missionId) &&
			this.store
				.tasks(record.missionId)
				.some(
					(t) =>
						!t.sessionId &&
						t.status !== "done" &&
						t.status !== "dropped" &&
						!record.taskIds.includes(t.id) &&
						(t.order < order(record) || (t.order === order(record) && t.number < number(record))),
				)
		)
			throw new Conflict(
				"Waiting for an earlier user-pinned priority; missing authority or prerequisites cannot be skipped",
			);
		const tasks = record.taskIds.map((id) => this.store.task(record.missionId, id));
		const selected = new Set(record.taskIds);
		for (const task of tasks)
			for (const dep of task.dependsOn ?? [])
				if (!selected.has(dep) && this.store.task(record.missionId, dep).status !== "done")
					throw new Conflict(`Task #${task.number} depends on unfinished work`);
		if (tasks.every((t) => t.sessionId === record.targetId && t.status === "in_progress")) return;
		if (tasks.some((t) => t.status !== "todo")) throw new Conflict("Task is held or no longer todo");
		this.store.prepareTaskStart(record.missionId, record.taskIds);
	}
	private async reconcile(): Promise<void> {
		if (!this.store.controls.continuations(undefined, true).length) return;
		await this.store.durable();
		const records = this.store.controls.continuations(undefined, true).sort((a, b) => {
			const order = (r: MissionContinuation) =>
				Math.min(
					...r.taskIds.map((id) => {
						try {
							return this.store.task(r.missionId, id).order;
						} catch {
							return Infinity;
						}
					}),
				);
			const number = (r: MissionContinuation) =>
				Math.min(
					...r.taskIds.map((id) => {
						try {
							const task = this.store.task(r.missionId, id);
							return task.order === order(r) ? task.number : Infinity;
						} catch {
							return Infinity;
						}
					}),
				);
			return order(a) - order(b) || number(a) - number(b);
		});
		for (const record of records) {
			if (this.stopped || this.runtime.frozen) return;
			if (record.state === "entered" || record.state === "unknown") {
				if (await this.host.lookup(record)) {
					record.state = "started";
					record.reason = "Exact saved start found";
				} else {
					record.state = "unknown";
					record.reason = "Start outcome unknown; lookup only, never retry";
				}
			} else if (record.state === "waiting") {
				try {
					this.assertCurrent(record);
				} catch (error) {
					if (error instanceof ContinuationChanged || error instanceof NotFound) record.state = "invalidated";
					record.reason = error instanceof Error ? error.message : "Admission unavailable";
					this.store.controls.saveContinuation(record);
					continue;
				}
				record.policySource = structuredClone(this.currentPolicy(record));
				record.state = "entered";
				record.reason = "Start entered; recovery is lookup only";
				this.store.controls.saveContinuation(record);
				await this.store.durable();
				try {
					this.assertCurrent(record);
					await this.host.start(record, () => this.assertCurrent(record));
					record.state = "started";
					record.reason = "Start admitted; task completion and user acceptance remain separate";
				} catch (error) {
					record.state = "unknown";
					record.reason = `Start not acknowledged; lookup only: ${error instanceof Error ? error.message : "unavailable"}`;
				}
			}
			this.store.controls.saveContinuation(record);
		}
		await this.store.durable();
	}
}
