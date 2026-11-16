import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type TestContext, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, type EntryId, MemoryStorage } from "@earendil-works/pi-durable";
import type { EntryRecord, SessionSummary, SpawnRequest } from "@pilot/protocol";
import type { MissionThreadReference, MissionThreadWrite } from "../../protocol/src/mission-thread.ts";
import { MissionService } from "./mission-service.ts";
import { MissionThreads } from "./mission-threads.ts";
import { nativePlanningFixture } from "./native-mission-planning.fixture.ts";
import { publishedPlanningFixture } from "./published-planning.fixture.ts";

type ThreadInput = {
	[P in MissionThreadWrite["purpose"]]: Omit<Extract<MissionThreadWrite, { purpose: P }>, "source" | "topicId">;
}[MissionThreadWrite["purpose"]];

async function fixture(t: TestContext, native = false) {
	const f = await publishedPlanningFixture(t, { native });
	t.mock.method(f.sessions, "inputCausality", async () => []);
	const threads = new MissionThreads({ ...f, workers: f.workers });
	const topicId = randomUUID();
	const request = async (write: ThreadInput, id = topicId) => {
		const view = await threads.read(f.project.id, f.missionId);
		return f.operation(f.missionId, { ...write, topicId: id, source: view.source }, view.source);
	};
	const execute = (op: ReturnType<typeof f.operation>) =>
		f.journal.execute(op, (o, e) => threads.admit(o, e.firstEntry));
	const create = await request({ purpose: "thread-create", title: "Importer limits" });
	assert.equal((await execute(create)).state, "accepted");
	return Object.assign(f, { threads, topicId, request, execute, create });
}

test("topics keep exact identity, attribution, references and reversible dispositions without work effects", async (t) => {
	const f = await fixture(t);
	const topic = f.store.threads.get(f.missionId, f.topicId);
	assert.equal(topic.ownerSessionId, f.owner);
	assert.deepEqual(topic.createdBy, { kind: "user", operationId: f.create.operationId, host: f.create.origin });
	const decision = f.store.addDecision(f.missionId, "Keep history");
	const before = {
		mission: f.store.require(f.missionId),
		tasks: f.store.tasks(f.missionId),
		brief: f.store.brief(f.missionId),
		controls: f.store.controls.current(f.missionId),
	};
	const storage = new MemoryStorage();
	const entry: EntryRecord = {
		id: await storage.mintId<EntryId>(),
		conversationId: await storage.mintId<ConversationId>(),
		kind: "original-evidence",
		model: [{ role: "user", content: "Exact old question", timestamp: 1 }],
	};
	const history = t.mock.method(f.sessions, "history", async () => ({ entries: [entry], more: false }));
	const task = f.store.tasks(f.missionId)[0]!;
	for (const reference of [
		{ kind: "history", sessionId: f.owner, entryId: Number(entry.id) },
		{ kind: "task", id: task.id },
		{ kind: "decision", id: decision.id },
	] satisfies MissionThreadReference[]) {
		assert.equal((await f.execute(await f.request({ purpose: "thread-reference", reference }))).state, "accepted");
	}
	for (const disposition of ["later", "discarded", "open"] as const) {
		const op = await f.request({ purpose: "thread-disposition", disposition });
		assert.equal((await f.execute(op)).state, "accepted");
		assert.equal((await f.execute(op)).state, "accepted");
		const current = f.store.threads.get(f.missionId, f.topicId);
		assert.equal(current.disposition, disposition);
		assert.equal(current.references.length, 3);
	}
	const read = await f.threads.history(f.project.id, f.missionId, f.topicId, Number(entry.id) + 1, 1);
	assert.equal(read.scope, "coordinator-history");
	assert.equal(read.sessionId, f.owner);
	assert.deepEqual(read.history.entries, [entry]);
	assert.equal(history.mock.calls[0]!.arguments[0], f.owner);
	assert.deepEqual(f.store.require(f.missionId), before.mission);
	assert.deepEqual(f.store.tasks(f.missionId), before.tasks);
	assert.deepEqual(f.store.brief(f.missionId), before.brief);
	assert.deepEqual(f.store.controls.current(f.missionId), before.controls);
	const originalReceipt = await f.threads.lookup(f.create);
	assert.deepEqual(originalReceipt?.result, { topic }, "exact ACK is not today's topic revision");
	const sibling = randomUUID();
	assert.equal(
		(await f.execute(await f.request({ purpose: "thread-create", title: "Other subject" }, sibling))).state,
		"accepted",
	);
	assert.equal(f.store.threads.list(f.missionId).length, 2);
	assert.equal(f.store.threads.get(f.missionId, f.topicId).references.length, 3);
	assert.equal(f.inputs.length, 0);
	assert.equal(f.store.planningWorkers.get(f.missionId)?.start, undefined);
});

test("decision references require canonical IDs in the current mission", async (t) => {
	const f = await fixture(t);
	const decision = f.store.addDecision(f.missionId, "Keep history");
	const other = await f.createPlanning("Other mission");
	const foreign = f.store.addDecision(other, "Other scope");
	for (const id of [randomUUID(), foreign.id, `D${decision.number}`]) {
		const receipt = await f.execute(
			await f.request({ purpose: "thread-reference", reference: { kind: "decision", id } }),
		);
		assert.equal(receipt.state, "rejected");
		assert.equal(f.store.threads.get(f.missionId, f.topicId).references.length, 0);
	}
	assert.equal(
		(
			await f.execute(
				await f.request({ purpose: "thread-reference", reference: { kind: "decision", id: decision.id } }),
			)
		).state,
		"accepted",
	);
	assert.equal(f.inputs.length, 0);
});

/** Thread chats without a model: Pilot's spawn, send and archive are recorded, and a chat joins the mission like a real one. */
function threadChats(t: TestContext, f: Awaited<ReturnType<typeof fixture>>) {
	const live = new Map<string, SessionSummary>();
	const sent: { id: string; text: string; requestId?: string }[] = [];
	const spawned: { request: SpawnRequest; admission: unknown }[] = [];
	const get = f.sessions.get.bind(f.sessions);
	t.mock.method(f.sessions, "get", (id: string) => live.get(id) ?? get(id));
	t.mock.method(
		f.sessions,
		"spawn",
		async (request: SpawnRequest, _coordinator: boolean, _task: unknown, admission: unknown) => {
			const id = `chat-${live.size + 1}`;
			const session = {
				id,
				projectId: f.project.id,
				title: request.title ?? "",
				state: "idle",
				working: false,
				outcome: "done",
			} as unknown as SessionSummary;
			live.set(id, session);
			f.store.join(id, f.missionId, undefined, "explorer");
			spawned.push({ request, admission });
			sent.push({ id, text: request.message });
			return session;
		},
	);
	t.mock.method(f.sessions, "send", async (id: string, text: string, _mode: string, requestId: string) => {
		if (!sent.some((s) => s.requestId === requestId)) sent.push({ id, text, requestId });
	});
	t.mock.method(f.sessions, "archive", async (id: string) => {
		const session = live.get(id)!;
		live.set(id, { ...session, archivedAt: Date.now() } as SessionSummary);
		return live.get(id)!;
	});
	return { live, sent, spawned };
}

test("a thread message starts the thread's own read-only chat, later ones go to it, and the planner gets none", async (t) => {
	const f = await fixture(t);
	const c = threadChats(t, f);
	const first = await f.request({ purpose: "thread-send", text: "  Rework the plan page 🙂 " });
	const receipt = await f.execute(first);
	assert.equal(receipt.state, "accepted", JSON.stringify(receipt));
	assert.deepEqual((receipt.result as { chat: unknown }).chat, { sessionId: "chat-1" });
	assert.equal(c.spawned.length, 1);
	const { request, admission } = c.spawned[0]!;
	assert.equal(request.mode, "ask");
	assert.equal(request.missionId, f.missionId);
	assert.equal(request.message, "  Rework the plan page 🙂 ", "the exact words");
	assert.deepEqual(admission, { role: "explorer", actorSessionId: f.owner, mainView: true });
	assert.deepEqual(f.store.threads.get(f.missionId, f.topicId).chat, {
		operationId: first.operationId,
		sessionId: "chat-1",
	});
	// The planning agent can be held: the thread chat still answers.
	const state = f.store.planningWorkers.get(f.missionId)!;
	f.store.planningWorkers.change(f.missionId, state.revision, (s) => {
		s.phase = "held";
	});
	const second = await f.request({ purpose: "thread-send", text: "Focus on what is next" });
	assert.equal((await f.execute(second)).state, "accepted");
	assert.equal((await f.execute(second)).state, "accepted");
	assert.equal(c.spawned.length, 1, "one chat per thread");
	assert.deepEqual(c.sent.slice(1), [{ id: "chat-1", text: "Focus on what is next", requestId: second.operationId }]);
	assert.equal(f.inputs.length, 0, "the planning agent gets no thread message");
	assert.equal(f.workers.waitingMessages(f.missionId).length, 0);
	const history = t.mock.method(f.sessions, "history", async () => ({ entries: [], more: false }));
	const read = await f.threads.history(f.project.id, f.missionId, f.topicId);
	assert.equal(read.scope, "thread-chat");
	assert.equal(read.sessionId, "chat-1");
	assert.equal(history.mock.calls[0]!.arguments[0], "chat-1");
	assert.equal((await f.threads.read(f.project.id, f.missionId)).discussion.available, true);
});

test("a thread chat start that never finished stays Unknown; looking it up starts nothing", async (t) => {
	const f = await fixture(t);
	const c = threadChats(t, f);
	t.mock.method(f.sessions, "spawn", async () => {
		throw new Error("Lost while starting");
	});
	const op = await f.request({ purpose: "thread-send", text: "Hello" });
	assert.equal((await f.execute(op)).state, "pending");
	assert.equal((await f.threads.lookup(op))?.state, "pending");
	assert.deepEqual(f.store.threads.get(f.missionId, f.topicId).chat, { operationId: op.operationId });
	assert.equal(c.spawned.length, 0);
});

test("Discard closes the thread chat; after Reopen a message starts a new one", async (t) => {
	const f = await fixture(t);
	const c = threadChats(t, f);
	assert.equal((await f.execute(await f.request({ purpose: "thread-send", text: "First" }))).state, "accepted");
	assert.equal(
		(await f.execute(await f.request({ purpose: "thread-disposition", disposition: "discarded" }))).state,
		"accepted",
	);
	assert.ok(c.live.get("chat-1")?.archivedAt, "the discarded thread's chat is archived");
	assert.equal((await f.execute(await f.request({ purpose: "thread-send", text: "Ignored" }))).state, "rejected");
	assert.equal(
		(await f.execute(await f.request({ purpose: "thread-disposition", disposition: "open" }))).state,
		"accepted",
	);
	assert.equal((await f.execute(await f.request({ purpose: "thread-send", text: "Again" }))).state, "accepted");
	assert.equal(c.spawned.length, 2);
	assert.equal(f.store.threads.get(f.missionId, f.topicId).chat?.sessionId, "chat-2");
});

test("a thread chat reads like the coordinator, hands off agreed work, and confirming its revision resolves the thread", async (t) => {
	const f = await fixture(t);
	const c = threadChats(t, f);
	assert.equal((await f.execute(await f.request({ purpose: "thread-send", text: "Show agents" }))).state, "accepted");
	const service = new MissionService(f.store, f.sessions, f.projects);
	await assert.rejects(service.call("chat-1", "update", { goal: "Changed" }), /thread chat reads the mission/);
	await assert.rejects(service.call("chat-1", "task", { title: "New" }), /cannot use task to change it/);
	await assert.rejects(service.call(f.owner, "handoff", {}), /Only a thread chat/);
	const view = (await service.call("chat-1", "get", {})) as Record<string, unknown>;
	assert.ok("members" in view && "needsYou" in view, "the coordinator's view");
	assert.equal(service.context("chat-1")?.thread?.topicId, f.topicId);
	assert.equal(((await service.call("chat-1", "thread", {})) as { title: string }).title, "Importer limits");
	await assert.rejects(
		service.call("chat-1", "handoff", { summary: "S", handoffTasks: [] }),
		/handoffTasks must list 1 to 20 items/,
	);
	t.mock.method(f.sessions, "artifacts", async () => [{ id: "mock-1", revision: 2 }]);
	await assert.rejects(
		service.call("chat-1", "handoff", {
			summary: "S",
			handoffTasks: [
				{ key: "a", title: "A", outcome: "O", acceptance: ["x"], prototype: { artifactId: "other", revision: 1 } },
			],
		}),
		/not one of this chat's artifacts/,
	);
	const done = (await service.call("chat-1", "handoff", {
		summary: "Show working agents on Today",
		handoffTasks: [
			{
				key: "agents",
				title: "Working agents on Today",
				outcome: "Today lists working agents",
				acceptance: ["Each working agent shows with its task"],
				prototype: { artifactId: "mock-1", revision: 2 },
			},
		],
	})) as { handoffId: string };
	const workers = f.workers as unknown as {
		queueHandoffs(id: string): void;
		deliverMessages(id: string): Promise<void>;
		closeThreadChats(id: string): Promise<void>;
	};
	workers.queueHandoffs(f.missionId);
	workers.queueHandoffs(f.missionId);
	await workers.deliverMessages(f.missionId);
	assert.equal(f.inputs.length, 1, "one planning turn, sent once");
	assert.match(f.inputs[0]!.content, /Thread chats handed off work/);
	assert.match(f.inputs[0]!.content, /Show working agents on Today/);
	assert.ok(f.store.threads.get(f.missionId, f.topicId).handoff?.queuedAt);
	assert.equal(f.store.threads.get(f.missionId, f.topicId).handoff?.id, done.handoffId);
	// Another thread's proposal and a Revisit proposal do not replace this thread's.
	const other = randomUUID();
	assert.equal(
		(await f.execute(await f.request({ purpose: "thread-create", title: "Other" }, other))).state,
		"accepted",
	);
	f.store.threads.amend(f.missionId, other, (topic) => {
		topic.handoff = { id: "h2", sessionId: "chat-1", summary: "Other", tasks: [], at: 1 };
	});
	const propose = (topicId: string | undefined, title: string, prototype?: boolean) =>
		f.store.revisions.propose(
			f.missionId,
			{
				operationId: randomUUID(),
				source: f.store.revisions.source(f.missionId),
				summary: title,
				delta: {
					newTasks: [
						{
							key: "k",
							title,
							body: "Outcome: it shows.",
							...(prototype ? { prototype: { sessionId: "chat-1", artifactId: "mock-1", revision: 2 } } : {}),
						},
					],
				},
				...(topicId ? { topicId } : {}),
			},
			{ sessionId: f.owner },
		);
	await assert.rejects(propose(randomUUID(), "Unknown thread"), /Unknown mission topic/);
	const mine = await propose(f.topicId, "Working agents on Today", true);
	await propose(other, "Other work");
	await propose(undefined, "Revisit work");
	const pending = f.store.revisions.pending(f.missionId)!;
	assert.equal(pending.proposal.id, mine.id, "the oldest that applies comes first");
	assert.equal(pending.waiting, 2);
	await f.store.revisions.confirm(f.missionId, mine.id, { digest: mine.digest, humanSource: "user:test" });
	const topic = f.store.threads.get(f.missionId, f.topicId);
	const task = f.store.tasks(f.missionId).find((x) => x.title === "Working agents on Today")!;
	assert.equal(topic.disposition, "resolved");
	assert.deepEqual(topic.resolvedBy, { proposalId: mine.id, taskIds: [task.id] });
	assert.ok(topic.references.some((r) => r.kind === "task" && r.id === task.id));
	assert.match(task.body!, /Chosen mockup: artifact mock-1 revision 2/);
	assert.ok(
		f.store
			.detail(f.missionId, false)
			.artifacts.some((a) => a.artifactId === "mock-1" && a.taskId === task.id && a.revision === 2),
	);
	assert.equal(f.store.revisions.pending(f.missionId)?.waiting, 1, "the other two still wait");
	await workers.closeThreadChats(f.missionId);
	assert.ok(c.live.get("chat-1")?.archivedAt, "the resolved thread's chat is closed");
});

test("messages that still waited for the planning agent move to their thread chats", async (t) => {
	const f = await fixture(t);
	const c = threadChats(t, f);
	f.workers.queueMessage(f.missionId, {
		operationId: "old-1",
		topicId: f.topicId,
		title: "Importer limits",
		text: "Old words",
	});
	await f.threads.migrate();
	assert.equal(f.workers.waitingMessages(f.missionId).length, 0);
	assert.equal(c.spawned[0]?.request.message, "Old words");
	assert.equal(f.store.threads.get(f.missionId, f.topicId).chat?.sessionId, "chat-1");
	await f.threads.migrate();
	assert.equal(c.spawned.length, 1, "moved once");
});

test("history rechecks permission, project and membership after asynchronous reads", async (t) => {
	const f = await fixture(t);
	t.mock.method(f.sessions, "history", async () => {
		f.store.update(f.missionId, { coordinatorSessionId: null });
		return { entries: [], more: false };
	});
	await assert.rejects(f.threads.history(f.project.id, f.missionId, f.topicId), /coordinator|source/);
	await assert.rejects(f.threads.read(f.project.id, f.missionId), /coordinator/);
	await assert.rejects(f.threads.lookup(f.create), /coordinator/);
});

test("HTTP topics require native authority, preserve metadata across reopen, and never adopt legacy planners", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	t.mock.method(f.sessions, "planningIdentity", () => ({ inputGeneration: 0 }));
	const url = `${f.root}/api/projects/${f.project.id}/missions/${f.missionId}/threads`;
	assert.equal((await fetch(url)).status, 403);
	const headers = { "x-pilot-github-capability": f.capability };
	let view = await (await fetch(url, { headers })).json();
	assert.equal(view.discussion.available, false);
	const topicId = randomUUID();
	const create = f.operation(
		f.missionId,
		{ purpose: "thread-create", topicId, title: "Question", source: view.source } as { purpose: string },
		view.source,
	);
	assert.equal((await f.post(create, false, "invalid")).status, 403);
	assert.equal((await (await f.post(create)).json()).state, "accepted");
	view = await (await fetch(url, { headers })).json();
	const send = f.operation(
		f.missionId,
		{ purpose: "thread-send", topicId, text: "Not a Build", source: view.source } as { purpose: string },
		view.source,
	);
	assert.equal((await (await f.post(send)).json()).state, "rejected");
	assert.equal(f.store.planningWorkers.get(f.missionId), undefined);
	await f.restart();
	assert.equal((await (await f.post(create, true)).json()).state, "accepted");
	assert.equal(f.store.threads.get(f.missionId, topicId).title, "Question");
});

test("conversation keeps reopened originals, full text, exact origins and independent cursors", async (t) => {
	const f = await fixture(t);
	const c = threadChats(t, f);
	const first = await f.request({ purpose: "thread-send", text: "first" });
	assert.equal((await f.execute(first)).state, "accepted");
	await f.execute(await f.request({ purpose: "thread-disposition", disposition: "discarded" }));
	await f.execute(await f.request({ purpose: "thread-disposition", disposition: "open" }));
	assert.equal((await f.execute(await f.request({ purpose: "thread-send", text: "second" }))).state, "accepted");
	const storage = new MemoryStorage();
	const make = async (kind: string, text: string): Promise<EntryRecord> => ({
		id: await storage.mintId<EntryId>(),
		conversationId: await storage.mintId<ConversationId>(),
		kind,
		model: [{ role: "user", content: text, timestamp: 1 }],
	});
	const old = await make("pi.user", "old"),
		latest = await make("pi.user", "é".repeat(12000));
	let answered = false;
	t.mock.method(f.sessions, "inputCausality", async () => [
		{ entryId: Number(latest.id), status: answered ? ("done" as const) : ("placed" as const) },
	]);
	t.mock.method(f.sessions, "history", async (id: string) => ({
		entries: [id === "chat-1" ? old : latest],
		more: false,
	}));
	const newest = await f.threads.history(f.project.id, f.missionId, f.topicId);
	assert.equal(newest.sessionId, "chat-2");
	assert.equal(newest.conversation.entries[0]!.text, "é".repeat(12000));
	assert.equal(newest.conversation.entries[0]!.replyState, "awaiting");
	answered = true;
	const refreshed = await f.threads.history(f.project.id, f.missionId, f.topicId);
	assert.equal(
		refreshed.conversation.entries[0]!.replyState,
		"answered",
		"late causal updates refresh without sending",
	);
	assert.deepEqual(newest.conversation.entries[0]!.original, {
		kind: "history",
		sessionId: "chat-2",
		entryId: Number(latest.id),
	});
	assert.equal(newest.conversation.nextSessionId, "chat-1");
	const previous = await f.threads.history(f.project.id, f.missionId, f.topicId, undefined, 32, "chat-1");
	assert.equal(previous.conversation.entries[0]!.text, "old");
	assert.equal(previous.conversation.nextSessionId, f.owner);
	assert.equal(previous.conversation.earlierContext, "complete");
	assert.equal(c.spawned.length, 2, "reads never spawn");
	await assert.rejects(
		f.threads.history(f.project.id, f.missionId, f.topicId, undefined, 32, "unrelated"),
		/Exact topic/,
	);
	c.live.set("chat-1", { ...c.live.get("chat-1")!, projectId: "foreign" });
	await assert.rejects(
		f.threads.history(f.project.id, f.missionId, f.topicId, undefined, 32, "chat-1"),
		/inaccessible/,
	);
});

test("conversation refuses a chat whose mission membership changes during history I/O", async (t) => {
	const f = await fixture(t);
	const c = threadChats(t, f);
	await f.execute(await f.request({ purpose: "thread-send", text: "hello" }));
	t.mock.method(f.sessions, "history", async () => {
		c.live.set("chat-1", { ...c.live.get("chat-1")!, projectId: "foreign" });
		return { entries: [], more: false };
	});
	await assert.rejects(f.threads.history(f.project.id, f.missionId, f.topicId), /inaccessible/);
});

test("legacy user words survive lost carrier links while the chat keeps its existing context", async (t) => {
	const f = await fixture(t);
	const chats = threadChats(t, f);
	const legacy = await f.request({ purpose: "thread-send", text: "Exact old user words" });
	await f.journal.execute(legacy, async () => ({
		topic: f.store.threads.amend(f.missionId, f.topicId, (topic) => {
			topic.inputs.push({ operationId: legacy.operationId, sessionId: f.owner, at: 1 });
		}),
		queued: true,
	}));
	t.mock.method(f.sessions, "history", async () => ({ entries: [], more: false }));
	const unplaced = await f.threads.history(f.project.id, f.missionId, f.topicId);
	assert.deepEqual(unplaced.conversation.queuedMessages, [
		{
			operationId: legacy.operationId,
			text: "Exact old user words",
			timestamp: 1,
			replyState: "unknown",
		},
	]);
	const storage = new MemoryStorage();
	const input: EntryRecord = {
		id: await storage.mintId<EntryId>(),
		conversationId: await storage.mintId<ConversationId>(),
		kind: "pilot.planning-input",
		data: { operation: JSON.stringify(legacy) },
	};
	const oldReply: EntryRecord = {
		id: await storage.mintId<EntryId>(),
		conversationId: input.conversationId,
		kind: "pi.assistant",
		model: [fauxAssistantMessage("Legacy context, not an explicit topic reply")],
	};
	t.mock.method(f.sessions, "history", async (sessionId: string) => ({
		entries: sessionId === f.owner ? [input, oldReply] : [],
		more: false,
	}));
	await f.execute(await f.request({ purpose: "thread-send", text: "Follow-up" }));
	assert.equal(chats.spawned.length, 1);
	assert.deepEqual(f.store.threads.get(f.missionId, f.topicId).earlier, [
		{ role: "you", text: "Exact old user words" },
		{ role: "coordinator", text: "Legacy context, not an explicit topic reply" },
	]);
	const conversation = await f.threads.history(f.project.id, f.missionId, f.topicId, undefined, 32, f.owner);
	assert.equal(
		conversation.conversation.entries.some((e) => e.role === "coordinator"),
		false,
		"legacy context capture is not evidence for the displayed conversation",
	);
	t.mock.method(f.sessions, "inputCausality", async (sessionId: string) =>
		sessionId === f.owner
			? [{ requestId: legacy.operationId, entryId: Number(input.id), status: "placed" as const }]
			: [],
	);
	const chatPage = await f.threads.history(f.project.id, f.missionId, f.topicId);
	assert.deepEqual(
		chatPage.conversation.queuedMessages,
		[],
		"known legacy placements do not become pending or unknown just because their page is not shown",
	);
	const carrier = f.operation(f.missionId, { purpose: "plan-thread-messages", operationIds: [legacy.operationId] });
	await f.journal.execute(carrier, async () => ({ saved: true }));
	t.mock.method(f.sessions, "inputCausality", async (sessionId: string) =>
		sessionId === f.owner
			? [{ requestId: carrier.operationId, entryId: Number(input.id), status: "placed" as const }]
			: [],
	);
	const batchPage = await f.threads.history(f.project.id, f.missionId, f.topicId);
	assert.deepEqual(
		batchPage.conversation.queuedMessages,
		[],
		"a placed batch also suppresses its sends even when the carrier page was not read",
	);
	t.mock.method(f.sessions, "inputCausality", async (sessionId: string) =>
		sessionId === "chat-1"
			? [{ requestId: legacy.operationId, entryId: Number(input.id), status: "placed" as const }]
			: [],
	);
	const migratedPage = await f.threads.history(f.project.id, f.missionId, f.topicId);
	assert.deepEqual(
		migratedPage.conversation.queuedMessages,
		[],
		"migration's exact chat placement also suppresses an old receipt without a chat binding",
	);
});
