/** Authenticated user topics. No pre-mission conversations, copied transcripts or generic send. */

import { PLANNING_INPUT_ENTRY } from "@pilot/kernel";
import type {
	DurableOperation,
	MissionThread,
	MissionThreadHistory,
	MissionThreadsView,
	MissionThreadWrite,
	OperationReceipt,
	SessionHistoryPage,
} from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { interviewExact, interviewId } from "./mission-interview-contract.ts";
import { revisionText } from "./mission-revisions.ts";
import { threadBatch, threadConversationEntries } from "./mission-thread-conversation.ts";
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
	private chatStartAuthority(id: string): string {
		const pin = this.scope(id);
		return payloadHash(
			canonicalJSON({
				project: pin.project,
				owner: pin.owner,
				identity: this.deps.sessions.planningIdentity(pin.owner),
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
		sessionId?: string,
	): Promise<MissionThreadHistory> {
		if (!Number.isSafeInteger(before) || before < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
			throw new Error("Invalid topic history cursor or limit");
		await this.deps.store.durable();
		this.scope(id, projectId);
		const source = this.source(id),
			topic = this.deps.store.threads.get(id, topicId);
		// Immutable accepted effects keep old chat bindings when reopening replaces topic.chat.
		const receipts = await this.deps.journal.targetReceipts("thread-send", id);
		const [originalSends, batches] = await Promise.all([
			this.deps.journal.operations("thread-send", id),
			this.deps.journal.operations("plan-thread-messages", id),
		]);
		const sends = new Map<string, string>();
		for (const op of originalSends) {
			const payload = JSON.parse(op.payload) as { topicId?: string; text?: string };
			if (
				payload.topicId === topicId &&
				typeof payload.text === "string" &&
				topic.inputs.some((i) => i.operationId === op.operationId)
			)
				sends.set(op.operationId, payload.text);
		}
		const carriers = new Map<string, string[]>();
		for (const op of batches) {
			const ids: unknown = JSON.parse(op.payload).operationIds;
			if (Array.isArray(ids) && ids.every((value) => typeof value === "string")) carriers.set(op.operationId, ids);
		}
		for (const message of this.deps.store.planningWorkers.get(id)?.threadQueue ?? []) {
			if (message.carriedBy && !message.handoff)
				carriers.set(message.carriedBy, [...(carriers.get(message.carriedBy) ?? []), message.operationId]);
		}
		const chats = new Map<string, string>();
		for (const receipt of receipts) {
			const result = receipt.result as { topic?: MissionThread; chat?: { sessionId?: string } } | undefined;
			if (
				receipt.state === "accepted" &&
				result?.topic?.id === topicId &&
				result.topic.projectId === projectId &&
				result.topic.missionId === id &&
				result.chat?.sessionId
			)
				chats.set(receipt.operationId, result.chat.sessionId);
		}
		for (const link of topic.chats ?? []) chats.set(link.operationId, link.sessionId);
		if (topic.chat?.sessionId) chats.set(topic.chat.operationId, topic.chat.sessionId);
		const sources = [
			...new Set([
				topic.ownerSessionId,
				...topic.inputs.flatMap((i) => (chats.has(i.operationId) ? [chats.get(i.operationId)!] : [])),
				...chats.values(),
			]),
		];
		const selected = sessionId ?? sources.at(-1)!;
		const index = sources.indexOf(selected);
		if (index < 0) throw new Conflict("Exact topic history session required");
		const chat = selected !== topic.ownerSessionId;
		const qualify = () => {
			this.scope(id, projectId);
			const session = this.deps.sessions.get(selected),
				member = this.deps.store.membership(selected);
			if (!session || session.projectId !== projectId || (chat && member?.missionId !== id))
				throw new Conflict("Thread chat history is inaccessible");
		};
		qualify();
		const history = await this.deps.sessions.history(selected, before, limit);
		const causality = await this.deps.sessions.inputCausality(
			selected,
			history.entries.map((e) => Number(e.id)),
			topic.inputs.map((i) => i.operationId),
		);
		for (const entry of history.entries) {
			const batch = threadBatch(entry);
			if (batch) carriers.set(batch.operationId, batch.inputIds);
		}
		// A reply page need not contain its input. Resolve exact carrier entries only, with limited I/O.
		if (!chat && sends.size) {
			const answerIds = new Set(history.entries.map((e) => Number(e.id)));
			const missing = [
				...new Set(
					causality
						.filter(
							(c) =>
								c.entryId &&
								c.answerId &&
								answerIds.has(c.answerId) &&
								!carriers.has(c.requestId ?? "") &&
								!sends.has(c.requestId ?? ""),
						)
						.map((c) => c.entryId!),
				),
			].slice(0, limit);
			for (let start = 0; start < missing.length; start += 4) {
				const pages = await Promise.all(
					missing.slice(start, start + 4).map((entryId) => this.deps.sessions.history(selected, entryId + 1, 1)),
				);
				for (const page of pages)
					for (const entry of page.entries) {
						if (!missing.includes(Number(entry.id))) continue;
						const batch = threadBatch(entry);
						if (batch) carriers.set(batch.operationId, batch.inputIds);
					}
			}
		}
		// Older sends can have no surviving carrier link. Keep their exact words, but do not
		// call a known placement unknown merely because its history page is not on screen.
		const legacy = topic.inputs.filter((i) => !chats.has(i.operationId));
		const legacyIds = new Set(legacy.map((i) => i.operationId));
		const legacyRequests = [
			...new Set([
				...legacyIds,
				...[...carriers].filter(([, ids]) => ids.some((i) => legacyIds.has(i))).map(([id]) => id),
			]),
		];
		// Migration can place an old send in this chat without changing its old accepted receipt.
		const placed = new Set(causality.flatMap((link) => (link.entryId && link.requestId ? [link.requestId] : [])));
		if (legacyRequests.length) this.historyOwner(id, topic);
		for (let start = 0; start < legacyRequests.length; start += 2048) {
			const links = await this.deps.sessions.inputCausality(
				topic.ownerSessionId,
				[],
				legacyRequests.slice(start, start + 2048),
			);
			for (const link of links)
				if (link.requestId && link.entryId) {
					placed.add(link.requestId);
					for (const input of carriers.get(link.requestId) ?? []) placed.add(input);
				}
		}
		if (legacyRequests.length) this.historyOwner(id, topic);
		const waiting = new Set(
			(this.deps.workers?.waitingMessages(id) ?? []).filter((m) => m.topicId === topicId).map((m) => m.operationId),
		);
		qualify();
		if (this.source(id) !== source) throw new Conflict("Topic history source changed");
		const oldest = history.entries[0]?.id;
		if (history.more && (!oldest || oldest >= before)) throw new Conflict("Topic history cursor did not advance");
		const older = index > 0 ? sources[index - 1]! : null;
		return {
			topic,
			sessionId: selected,
			scope: chat ? "thread-chat" : "coordinator-history",
			history,
			conversation: {
				queuedMessages: [
					...causality.flatMap((c) =>
						c.status === "queued" && c.requestId && sends.has(c.requestId) && chats.get(c.requestId) === selected
							? [
									{
										operationId: c.requestId,
										text: sends.get(c.requestId)!,
										timestamp: topic.inputs.find((i) => i.operationId === c.requestId)?.at ?? null,
										replyState: "pending" as const,
									},
								]
							: [],
					),
					...topic.inputs.flatMap((input) =>
						!chats.has(input.operationId) && sends.has(input.operationId) && !placed.has(input.operationId)
							? [
									{
										operationId: input.operationId,
										text: sends.get(input.operationId)!,
										timestamp: input.at ?? null,
										replyState: waiting.has(input.operationId) ? ("pending" as const) : ("unknown" as const),
									},
								]
							: [],
					),
				],
				entries: threadConversationEntries(
					topic,
					selected,
					history.entries,
					chat,
					waiting,
					causality,
					sends,
					carriers,
				),
				more: history.more || older !== null,
				nextBefore: history.more ? Number(oldest) : null,
				nextSessionId: history.more ? selected : older,
				earlierContext:
					topic.inputs.every((i) => chats.has(i.operationId)) &&
					!topic.references.some((r) => r.kind === "history") &&
					!topic.earlier?.length
						? "complete"
						: "unknown",
			},
		};
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
			interviewExact(request, [
				"purpose",
				"source",
				"topicId",
				field!,
				...(op.kind === "thread-send" && Object.hasOwn(request, "interrupt") ? ["interrupt"] : []),
			]);
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
					if (request.interrupt !== undefined && request.interrupt !== true)
						throw new Error("Invalid Interrupt confirmation");
					if (request.interrupt && (!this.liveChat(topic) || store.controls.current(op.targetId).held))
						throw new Conflict("Interrupt needs an existing discussion and an unpaused mission");
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
		// All validation I/O precedes this fence. The journal already saved the exact operation, but nothing was
		// written yet: a source that moved meanwhile rejects it. A plain error here left it Unknown for good.
		const check = (source: string) => {
			this.envelope(op);
			if (this.source(op.targetId) !== source) throw new OperationRejected("Topic source changed");
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
				next.inputs.push({
					sessionId: next.ownerSessionId,
					deliverySessionId: this.liveChat(next),
					operationId: op.operationId,
					at: Date.now(),
				});
			return next;
		});
		const source = this.source(op.targetId);
		await store.durable();
		check(source);
		if (request.purpose === "thread-disposition" && request.disposition === "discarded") await this.closeChat(result);
		if (request.purpose !== "thread-send") return { topic: result };
		return { topic: result, chat: await this.chatSend(op, result, request.text, request.interrupt) };
	}
	/**
	 * Sends a thread message to the thread's chat, starting the chat with it when the thread has none open. The chat's
	 * start is saved before it starts, so a crash in between stays Unknown instead of starting a second chat.
	 */
	private async chatSend(
		op: DurableOperation,
		topic: MissionThread,
		text: string,
		interrupt = false,
		expectedAuthority?: string,
	): Promise<{ sessionId: string }> {
		const { store, sessions, projects } = this.deps;
		const authority = expectedAuthority ?? this.chatStartAuthority(op.targetId);
		const guard = () => {
			if (this.chatStartAuthority(op.targetId) !== authority) throw new Conflict("Thread start authority changed");
		};
		guard();
		const live = this.liveChat(topic);
		if (live) {
			if (interrupt) {
				const generation = sessions.get(live)?.inputGeneration ?? 0;
				await sessions.stop(live);
				const guard = () => {
					this.scope(op.targetId);
					if (
						store.controls.current(op.targetId).held ||
						this.liveChat(store.threads.get(op.targetId, topic.id)) !== live ||
						sessions.get(live)?.inputGeneration !== generation + 1
					)
						throw new Conflict("Discussion or Stop changed during Interrupt; inspect before sending again");
				};
				guard();
				await sessions.sendDurable(live, text, "followUp", op.operationId, {
					inputGeneration: generation + 1,
					admissionGuard: guard,
				});
				return { sessionId: live };
			}
			await sessions.send(live, text, "followUp", op.operationId);
			return { sessionId: live };
		}
		// Preserve the thread chat's existing context contract. This legacy snapshot is not
		// evidence of topic membership and is never used by the conversation projection.
		const earlier =
			topic.earlier === undefined && topic.inputs.some((i) => i.operationId !== op.operationId)
				? await this.earlier(topic, op.operationId).catch((error: unknown) => {
						console.warn(`pilotd: thread ${topic.id} earlier messages not read: ${error}`);
						return undefined;
					})
				: undefined;
		store.threads.amend(op.targetId, topic.id, (t) => {
			if (t.chat?.sessionId && !t.chats?.some((c) => c.sessionId === t.chat!.sessionId))
				t.chats = [...(t.chats ?? []), { operationId: t.chat.operationId, sessionId: t.chat.sessionId }];
			t.chat = { operationId: op.operationId };
			delete t.chatStartRefusal;
			if (earlier && t.earlier === undefined) t.earlier = earlier;
		});
		await store.durable();
		const scope = this.scope(op.targetId);
		const selection = await sessions.selectTaskModel(projects.require(scope.project.id).path);
		this.scope(op.targetId);
		let chat: { id: string };
		try {
			chat = await sessions.spawn(
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
				{ role: "explorer", actorSessionId: scope.owner, mainView: true, guard },
			);
		} catch (error) {
			// Spawn admission refused it and removed the new chat, so none exists: Check may start it later.
			if (error instanceof Conflict) {
				store.threads.amend(op.targetId, topic.id, (t) => {
					if (t.chat?.operationId === op.operationId && !t.chat.sessionId) {
						delete t.chat;
						t.chatStartRefusal = { operationId: op.operationId, authority };
					}
				});
				await store.durable();
			}
			throw error;
		}
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
	/** Existing model-context snapshot for old thread chats, not the topic conversation read model. */
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
			if (record.kind === PLANNING_INPUT_ENTRY) {
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
	/** After a restart, only inspect the exact original effect. Never resend or choose today's chat. */
	private async chatRecover(op: DurableOperation, saved: MissionThread): Promise<{ sessionId: string }> {
		const topic = this.deps.store.threads.get(op.targetId, saved.id);
		if (topic.chat?.operationId === op.operationId) {
			if (!topic.chat.sessionId) throw new Error("Unknown thread chat start; no replay");
			return { sessionId: topic.chat.sessionId };
		}
		// Retry only this exact saved pre-effect refusal, never infer it from an absent chat.
		if (!topic.chat && topic.disposition === "open" && topic.chatStartRefusal?.operationId === op.operationId) {
			if (topic.chatStartRefusal.authority !== this.chatStartAuthority(op.targetId))
				throw new Error("Refused thread start authority changed; read it and send a fresh request");
			return this.chatSend(op, topic, JSON.parse(op.payload).text, false, topic.chatStartRefusal.authority);
		}
		// The immutable legacy topic receipt also pins its then-current chat, not today's chat.
		const target =
			saved.inputs.find((i) => i.operationId === op.operationId)?.deliverySessionId ?? saved.chat?.sessionId;
		if (!target || !(await this.deps.sessions.lookupNativeAttentionInput(target, op.operationId)))
			throw new Error("Unknown thread message; checking the original input only, never resend");
		return { sessionId: target };
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
