/** Authenticated user topics. No pre-mission conversations, copied transcripts or generic send. */
import type { DurableOperation, OperationReceipt, SessionHistoryPage } from "@pilot/protocol";
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
	/**
	 * What a thread write names: the active mission, its project and planning owner, and the topics. Task progress and
	 * mission activity are left out, so they never refuse a thread message.
	 */
	private source(id: string): string {
		const pin = this.scope(id);
		return payloadHash(
			canonicalJSON({
				mission: { id: pin.mission.id, status: pin.mission.status, projectId: pin.mission.projectId },
				project: pin.project.id,
				owner: pin.owner,
				identity: this.deps.sessions.planningIdentity(pin.owner),
				topics: this.deps.store.threads.list(id),
			}),
		);
	}
	async read(projectId: string, id: string): Promise<MissionThreadsView> {
		await this.deps.store.durable();
		this.scope(id, projectId);
		return {
			version: 1,
			missionId: id,
			projectId,
			source: this.source(id),
			topics: this.deps.store.threads.list(id),
			// A thread chat takes messages whenever the thread is open; the planning agent can be busy. It needs native
			// planning, which takes its handoffs.
			discussion: this.deps.workers?.canQueueMessage(id)
				? { available: true, reason: "", waits: false }
				: {
						available: false,
						reason: "This mission has no native planning to take what a thread agrees on",
						waits: false,
					},
			waiting: (this.deps.workers?.waitingMessages(id) ?? []).map(({ operationId, topicId, text, at }) => ({
				operationId,
				topicId,
				text,
				at,
			})),
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
		const chat = topic.chat?.sessionId;
		if (chat) {
			const session = this.deps.sessions.get(chat);
			if (!session || session.projectId !== topic.projectId)
				throw new Conflict("Thread chat history is inaccessible");
			const history = await this.deps.sessions.history(chat, before, limit);
			if (this.source(id) !== source) throw new Conflict("Topic history source changed");
			return { topic, sessionId: chat, scope: "thread-chat", history };
		}
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
			const record =
				reference.kind === "task"
					? store.task(id, reference.id)
					: store.detail(id, false).decisions.find((decision) => decision.id === reference.id);
			if (record?.id !== reference.id) throw new Conflict("Canonical mission reference ID required");
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
				// Messages from before thread chats: waiting for, or taken by, the planning agent.
				if (workers?.queuedMessage(op.targetId, op.operationId)) return { topic: result, queued: true };
				const entered = (await this.deps.journal.lookup(op))?.result as { stage?: string } | undefined;
				if (workers && entered?.stage === "discussion-entered") {
					return { topic: result, admission: await workers.recover(op) };
				}
				return { topic: result, chat: await this.chatRecover(op, result) };
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
						!workers?.canQueueMessage(op.targetId)
					)
						throw new Conflict("Topic needs an open thread and native planning");
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
		if (request.purpose === "thread-disposition" && request.disposition === "discarded") await this.closeChat(result);
		if (request.purpose !== "thread-send") return { topic: result };
		return { topic: result, chat: await this.chatSend(op, result, request.text) };
	}
	/**
	 * Sends a thread message to the thread's chat, starting the chat with it when the thread has none open. The chat's
	 * start is saved before it starts, so a crash in between stays Unknown instead of starting a second chat.
	 */
	private async chatSend(op: DurableOperation, topic: MissionThread, text: string): Promise<{ sessionId: string }> {
		const { store, sessions, projects } = this.deps;
		const live = this.liveChat(topic);
		if (live) {
			await sessions.send(live, text, "followUp", op.operationId);
			return { sessionId: live };
		}
		const earlier =
			topic.earlier === undefined && topic.inputs.some((i) => i.operationId !== op.operationId)
				? await this.earlier(topic, op.operationId).catch((error: unknown) => {
						console.warn(`pilotd: thread ${topic.id} earlier messages not read: ${error}`);
						return undefined;
					})
				: undefined;
		store.threads.amend(op.targetId, topic.id, (t) => {
			t.chat = { operationId: op.operationId };
			if (earlier && t.earlier === undefined) t.earlier = earlier;
		});
		await store.durable();
		const scope = this.scope(op.targetId);
		const selection = await sessions.selectTaskModel(projects.require(scope.project.id).path);
		this.scope(op.targetId);
		const chat = await sessions.spawn(
			{
				projectId: scope.project.id,
				missionId: op.targetId,
				mode: "ask",
				title: `Thread: ${topic.title}`.slice(0, 200),
				message: text,
				...selection,
			},
			false,
			undefined,
			{ role: "explorer", actorSessionId: scope.owner, mainView: true },
		);
		store.threads.amend(op.targetId, topic.id, (t) => {
			t.chat = { operationId: op.operationId, sessionId: chat.id };
		});
		await store.durable();
		console.log(`pilotd: thread ${topic.id} of mission ${op.targetId} started thread chat ${chat.id}`);
		return { sessionId: chat.id };
	}
	/**
	 * Moves older threads to thread chats, once at startup and safe to repeat: messages that still wait for the planning
	 * agent go to their thread's chat instead.
	 */
	async migrate(): Promise<void> {
		const { store, workers } = this.deps;
		if (!workers) return;
		for (const missionId of store.planningWorkers.missionIds()) {
			for (const message of workers.takeWaitingMessages(missionId)) {
				try {
					const topic = store.threads.get(missionId, message.topicId);
					if (topic.disposition !== "open") continue;
					const op = { operationId: message.operationId, targetId: missionId } as DurableOperation;
					await this.chatSend(op, topic, message.text);
					console.log(`pilotd: thread ${topic.id} message ${message.operationId} moved to its thread chat`);
				} catch (error) {
					console.warn(`pilotd: thread message ${message.operationId} not moved to a thread chat: ${error}`);
				}
			}
			await store.durable();
		}
	}
	/**
	 * The thread's messages with the planning agent from before thread chats: the user's sends and the agent's replies
	 * that followed each. Read once, when its first thread chat starts, so the chat knows what was said.
	 */
	private async earlier(topic: MissionThread, skip: string): Promise<NonNullable<MissionThread["earlier"]>> {
		const sent = new Map<string, string>();
		for (const op of await this.deps.journal.operations("thread-send", topic.missionId)) {
			const payload = JSON.parse(op.payload) as { topicId?: string; text?: string };
			if (payload.topicId === topic.id && op.operationId !== skip && typeof payload.text === "string")
				sent.set(op.operationId, payload.text);
		}
		if (!sent.size) return [];
		const entries: SessionHistoryPage["entries"] = [];
		for (let before = Number.MAX_SAFE_INTEGER; ; ) {
			const page = await this.deps.sessions.history(topic.ownerSessionId, before, 100);
			entries.unshift(...page.entries);
			if (!page.more || !page.entries.length) break;
			before = page.entries[0]!.id;
		}
		const out: NonNullable<MissionThread["earlier"]> = [];
		let replying = false;
		for (const entry of entries) {
			const record = entry as unknown as Record<string, any>;
			if (record.kind === "pilot.planning-input") {
				const op = JSON.parse(String(record.data?.operation ?? "{}")) as { operationId?: string; payload?: string };
				const carried =
					op.operationId && sent.has(op.operationId)
						? [op.operationId]
						: ((JSON.parse(op.payload ?? "{}").operationIds as string[] | undefined) ?? []).filter((id) =>
								sent.has(id),
							);
				for (const id of carried) out.push({ role: "you", text: sent.get(id)! });
				replying = carried.length > 0;
			} else if (record.kind === "pi.assistant" && replying) {
				const text = (record.model ?? [])
					.flatMap((m: { content?: Array<{ type: string; text?: string }> }) => m.content ?? [])
					.filter((c: { type: string; text?: string }) => c.type === "text" && c.text)
					.map((c: { text: string }) => c.text)
					.join("\n")
					.trim();
				if (text) out.push({ role: "coordinator", text });
			}
		}
		return out;
	}
	/** After a restart: the message reached the chat it names, or it sends again with the same request ID. */
	private async chatRecover(op: DurableOperation, saved: MissionThread): Promise<{ sessionId: string }> {
		const topic = this.deps.store.threads.get(op.targetId, saved.id);
		if (topic.chat?.operationId === op.operationId) {
			if (!topic.chat.sessionId) throw new Error("Unknown thread chat start; no replay");
			return { sessionId: topic.chat.sessionId };
		}
		const live = this.liveChat(topic);
		if (!live) throw new Error("Unknown thread message; its chat is closed");
		// The chat takes one input per request ID, so sending again cannot repeat the message.
		await this.deps.sessions.send(live, JSON.parse(op.payload).text, "followUp", op.operationId);
		return { sessionId: live };
	}
	/** The thread's chat session when it exists and is not archived. */
	private liveChat(topic: MissionThread): string | undefined {
		const id = topic.chat?.sessionId;
		const chat = id ? this.deps.sessions.get(id) : undefined;
		return chat && !chat.archivedAt ? chat.id : undefined;
	}
	/** Archives the chat of a thread the user discarded or a revision resolved. Its history stays readable. */
	async closeChat(topic: MissionThread): Promise<void> {
		const live = this.liveChat(topic);
		if (!live) return;
		try {
			await this.deps.sessions.archive(live);
		} catch (error) {
			console.warn(`pilotd: thread chat ${live} not archived: ${error}`);
		}
	}
}
