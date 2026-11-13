/** Authenticated user topics. No pre-mission conversations, copied transcripts or generic send. */
import type { DurableOperation, OperationReceipt } from "@pilot/protocol";
import type {
	MissionThread,
	MissionThreadHistory,
	MissionThreadsView,
	MissionThreadWrite,
} from "../../protocol/src/mission-thread.ts";
import { Conflict } from "./errors.ts";
import { interviewExact, interviewId } from "./mission-interview-contract.ts";
import { revisionText } from "./mission-revisions.ts";
import type { MissionStore } from "./missions.ts";
import { canonicalJSON, type OperationJournal, OperationRejected, payloadHash, sameHost } from "./operation-journal.ts";
import type { PlanningWorkers } from "./planning-workers.ts";
import type { ProjectStore } from "./projects.ts";
import type { SessionManager } from "./sessions.ts";

export const isThreadOperation = (kind: string) =>
	["thread-create", "thread-disposition", "thread-reference", "thread-send"].includes(kind);
interface Dependencies {
	store: MissionStore;
	journal: OperationJournal;
	projects: ProjectStore;
	sessions: SessionManager;
	workers?: PlanningWorkers;
}
export class MissionThreads {
	private readonly deps: Dependencies;
	constructor(deps: Dependencies) {
		this.deps = deps;
	}
	private scope(id: string, projectId?: string) {
		const { store, projects, sessions } = this.deps;
		const mission = store.require(id),
			project = projects.require(mission.projectId);
		const owner = mission.coordinatorSessionId;
		const member = owner ? store.membership(owner) : undefined;
		const session = owner ? sessions.get(owner) : undefined;
		if (
			(projectId !== undefined && project.id !== projectId) ||
			mission.status !== "active" ||
			!owner ||
			!member?.active ||
			!member.coordinator ||
			member.missionId !== id ||
			!session ||
			session.projectId !== project.id ||
			session.mode !== "build" ||
			session.role ||
			session.control
		)
			throw new Conflict("Current same-project mission coordinator required");
		return { mission, project, owner };
	}
	private source(id: string): string {
		const pin = this.scope(id);
		return payloadHash(
			canonicalJSON({
				pin,
				revision: this.deps.store.revisions.source(id),
				identity: this.deps.sessions.planningIdentity(pin.owner),
				topics: this.deps.store.threads.list(id),
			}),
		);
	}
	async read(projectId: string, id: string): Promise<MissionThreadsView> {
		await this.deps.store.durable();
		this.scope(id, projectId);
		const discussion = this.deps.workers?.revisitView(id);
		return {
			version: 1,
			missionId: id,
			projectId,
			source: this.source(id),
			topics: this.deps.store.threads.list(id),
			discussion: {
				available: discussion?.available ?? false,
				reason: discussion?.reason ?? "Trusted planning discussion unavailable",
			},
		};
	}
	private historyOwner(id: string, topic: MissionThread) {
		this.scope(id);
		const original = this.deps.sessions.get(topic.ownerSessionId);
		if (!original || original.projectId !== topic.projectId)
			throw new Conflict("Original topic history is inaccessible");
	}
	async history(
		projectId: string,
		id: string,
		topicId: string,
		before = Number.MAX_SAFE_INTEGER,
		limit = 32,
	): Promise<MissionThreadHistory> {
		if (!Number.isSafeInteger(before) || before < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
			throw new Error("Invalid topic history cursor or limit");
		await this.deps.store.durable();
		this.scope(id, projectId);
		const source = this.source(id),
			topic = this.deps.store.threads.get(id, topicId);
		this.historyOwner(id, topic);
		const history = await this.deps.sessions.history(topic.ownerSessionId, before, limit);
		this.historyOwner(id, topic);
		if (this.source(id) !== source) throw new Conflict("Topic history source changed");
		return { topic, sessionId: topic.ownerSessionId, scope: "coordinator-history", history };
	}
	private envelope(op: DurableOperation) {
		if (
			!isThreadOperation(op.kind) ||
			op.origin?.hostId !== "local" ||
			!sameHost(op.origin, this.deps.journal.destination) ||
			!sameHost(op.destination, this.deps.journal.destination) ||
			op.bindingGeneration !== 1 ||
			!/^[a-f0-9]{64}$/.test(op.bindingId ?? "")
		)
			throw new Conflict("Exact native topic operation required");
		this.scope(op.targetId);
	}
	/** Requalify even terminal receipts. Pending recovery only observes original effects. */
	async lookup(op: DurableOperation): Promise<OperationReceipt | undefined> {
		await this.deps.store.durable();
		this.envelope(op);
		let receipt = await this.deps.journal.lookup(op);
		if (receipt?.state === "pending") receipt = await this.deps.journal.execute(op, () => this.admit(op, false));
		this.envelope(op);
		return receipt;
	}
	private async reference(id: string, topic: MissionThread, reference: MissionThread["references"][number]) {
		const { store, sessions } = this.deps;
		if (!reference || typeof reference !== "object") throw new Error("Topic reference required");
		if (reference.kind === "task" || reference.kind === "decision") {
			interviewExact(reference, ["kind", "id"]);
			interviewId(reference.id);
			const record = reference.kind === "task" ? store.task(id, reference.id) : store.decision(id, reference.id);
			if (record.id !== reference.id) throw new Conflict("Canonical mission reference ID required");
		} else if (reference.kind === "history") {
			interviewExact(reference, ["kind", "sessionId", "entryId"]);
			if (
				reference.sessionId !== topic.ownerSessionId ||
				!Number.isSafeInteger(reference.entryId) ||
				reference.entryId < 1 ||
				reference.entryId >= Number.MAX_SAFE_INTEGER
			)
				throw new Conflict("Exact original coordinator entry required");
			this.historyOwner(id, topic);
			const page = await sessions.history(reference.sessionId, reference.entryId + 1, 1);
			if (!page.entries.some((e) => e.id === reference.entryId))
				throw new Conflict("Original history entry unavailable");
			this.historyOwner(id, topic);
		} else throw new Error("Unsupported topic reference");
	}
	async admit(op: DurableOperation, firstEntry: boolean): Promise<unknown> {
		const { store, workers } = this.deps;
		if (!firstEntry) {
			// No writes or dispatch on an entered operation without exact saved evidence.
			await store.durable();
			const result = store.threads.lookup(op);
			if (!result) throw new Error("Unknown topic effect; no replay");
			if (op.kind === "thread-send") {
				if (!workers) throw new Error("Topic admission lookup unavailable");
				return { topic: result, admission: await workers.recover(op) };
			}
			return { topic: result };
		}
		let request: MissionThreadWrite;
		let topic: MissionThread | undefined;
		try {
			this.envelope(op);
			request = JSON.parse(op.payload);
			const field =
				op.kind === "thread-create"
					? "title"
					: op.kind === "thread-disposition"
						? "disposition"
						: op.kind === "thread-reference"
							? "reference"
							: "text";
			interviewExact(request, ["purpose", "source", "topicId", field!]);
			interviewId(request.topicId);
			if (
				request.purpose !== op.kind ||
				request.source !== op.bindingId ||
				request.source !== this.source(op.targetId)
			)
				throw new Conflict("Topic source changed");
			if (request.purpose === "thread-create") {
				revisionText(request.title, 200);
				if (
					store.threads.list(op.targetId).length >= 100 ||
					store.threads.list(op.targetId).some((t) => t.id === request.topicId)
				)
					throw new Conflict("Topic identity exists or capacity reached");
			} else {
				topic = store.threads.get(op.targetId, request.topicId);
				if (
					request.purpose === "thread-disposition" &&
					!["open", "later", "discarded"].includes(request.disposition)
				)
					throw new Error("Invalid topic disposition");
				if (request.purpose === "thread-reference") {
					if (topic.references.length >= 100) throw new Conflict("Topic reference capacity reached");
					await this.reference(op.targetId, topic, request.reference);
				}
				if (request.purpose === "thread-send") {
					if (typeof request.text !== "string" || !request.text.trim() || Buffer.byteLength(request.text) > 32000)
						throw new Error("Topic input must contain 1 to 32000 bytes");
					if (
						topic.disposition !== "open" ||
						topic.ownerSessionId !== this.scope(op.targetId).owner ||
						!workers?.revisitView(op.targetId).available
					)
						throw new Conflict("Topic needs an open, active unheld trusted planning owner");
				}
			}
		} catch (e) {
			throw new OperationRejected(String(e));
		}
		// All validation I/O precedes this fence. The journal already saved the exact operation.
		const check = (source: string) => {
			this.envelope(op);
			if (this.source(op.targetId) !== source) throw new Conflict("Topic source changed");
		};
		check(request.source);
		const result = store.threads.write(op, () => {
			check(request.source);
			if (request.purpose === "thread-create") {
				const pin = this.scope(op.targetId);
				return {
					version: 1,
					id: request.topicId,
					missionId: op.targetId,
					projectId: pin.project.id,
					ownerSessionId: pin.owner,
					title: request.title,
					revision: 1,
					disposition: "open",
					createdBy: { kind: "user", operationId: op.operationId, host: op.origin },
					references: [],
					inputs: [],
				};
			}
			const next = structuredClone(topic!);
			next.revision++;
			if (request.purpose === "thread-disposition") next.disposition = request.disposition;
			if (
				request.purpose === "thread-reference" &&
				!next.references.some((r) => canonicalJSON(r) === canonicalJSON(request.reference))
			)
				next.references.push(request.reference);
			if (request.purpose === "thread-send")
				next.inputs.push({ sessionId: next.ownerSessionId, operationId: op.operationId });
			return next;
		});
		const source = this.source(op.targetId);
		await store.durable();
		check(source);
		if (request.purpose !== "thread-send") return { topic: result };
		const admission = await workers!.discuss(op, () => check(source));
		return { topic: result, admission };
	}
}
