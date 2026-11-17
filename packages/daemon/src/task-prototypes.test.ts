/** A builder asks for a prototype of its own published task; Pilot makes it read-only and sends the result back once. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ArtifactSummary, SessionSummary } from "@pilot/protocol";
import { MissionService } from "./mission-service.ts";
import { publishedPlanningFixture as fixture } from "./published-planning.fixture.ts";

test("a builder's task prototype runs once, links its mockup to the task and reaches only that builder", async (t) => {
	const f = await fixture(t);
	const task = f.store.tasks(f.missionId)[0]!;
	const builder = "builder-1";
	const other = "builder-2";
	const chats = new Map<string, Partial<SessionSummary>>();
	for (const id of [builder, other]) {
		chats.set(id, { id, projectId: f.project.id, state: "idle", working: false, inputGeneration: 0 });
		f.store.join(id, f.missionId, { sessionId: f.owner }, "builder");
	}
	f.store.updateTask(f.missionId, task.id, { sessionId: builder }, { sessionId: f.owner });
	const get = f.sessions.get.bind(f.sessions);
	t.mock.method(f.sessions, "get", (id: string) =>
		chats.has(id) ? ({ ...chats.get(id) } as SessionSummary) : get(id),
	);
	const models: (string | undefined)[] = [];
	t.mock.method(f.sessions, "selectTaskModel", async (_cwd: string, model?: string) => {
		if (model === "faux/forbidden") throw new Error("Allowed models: faux/opus");
		models.push(model);
		return { model: model ?? "faux/default", thinking: "high" };
	});
	const spawned: { id: string; title: string; mode?: string; role: string; message: string; model: string }[] = [];
	t.mock.method(
		f.sessions,
		"spawn",
		async (
			request: { title: string; mode?: string; message: string; model: string },
			_c: boolean,
			_t: unknown,
			admission: { role: string },
		) => {
			const id = `proto-${spawned.length + 1}`;
			spawned.push({ id, ...request, role: admission.role });
			f.store.join(id, f.missionId, { sessionId: f.owner }, "explorer");
			chats.set(id, { id, projectId: f.project.id, state: "working", working: true });
			return { id } as SessionSummary;
		},
	);
	t.mock.method(f.sessions, "lastAssistantReply", async () => "## Variants\nA, B and C.");
	const published = new Map<string, ArtifactSummary[]>();
	t.mock.method(f.sessions, "artifacts", async (id: string) => published.get(id) ?? []);
	const sent: { id: string; message: string; operationId: string }[] = [];
	t.mock.method(f.sessions, "sendDurable", async (id: string, message: string, _mode: string, operationId: string) => {
		sent.push({ id, message, operationId });
	});
	t.mock.method(f.sessions, "lookupNativeAttentionInput", async (id: string, operationId: string) =>
		sent.some((s) => s.id === id && s.operationId === operationId),
	);
	const service = new MissionService(f.store, f.sessions, f.projects);
	const ask = (session: string, args: Record<string, unknown>) => service.call(session, "prototype", args);
	const request = {
		taskId: task.id,
		requestId: "layouts-1",
		question: "Compare three overview layouts",
		prototypeModel: "faux/opus",
		prototypeThinking: "high",
	};
	const settle = async () => {
		f.workers.scheduleResearch(f.missionId);
		await f.workers.settleResearch();
	};

	// Only the task's own builder, a known model and a limited time.
	await assert.rejects(ask(other, request), /your own task/);
	await assert.rejects(ask(builder, { ...request, prototypeModel: "faux/forbidden" }), /Allowed models/);
	await assert.rejects(ask(builder, { ...request, maxMinutes: 90 }), /prototype takes only/);
	await assert.rejects(ask(builder, { ...request, cwd: "/" }), /prototype takes only/);
	assert.deepEqual(await ask(builder, { taskId: task.id }), { taskId: task.id, state: "none" });

	const first = (await ask(builder, request)) as { state: string; next: string };
	assert.equal(first.state, "requested");
	assert.match(first.next, /End your turn/);
	assert.equal(((await ask(builder, request)) as { state: string }).state, "requested", "the same ID only reads it");
	await assert.rejects(ask(builder, { ...request, requestId: "layouts-2" }), /already has a prototype in progress/);

	f.workers.startResearch();
	await f.workers.settleResearch();
	assert.equal(spawned.length, 1, "one read-only chat");
	assert.deepEqual([spawned[0]!.mode, spawned[0]!.role, spawned[0]!.model], ["ask", "explorer", "faux/opus"]);
	assert.equal(spawned[0]!.title, "Prototype for #1: Importer");
	assert.doesNotMatch(spawned[0]!.message, /minute/);
	assert.match(spawned[0]!.message, /Compare three overview layouts/);
	assert.match(spawned[0]!.message, /Publish exactly one NSH artifact/);
	assert.equal(f.store.plans.get(f.missionId)!.publication !== null, true, "the published plan is left alone");

	published.set("proto-1", [
		{ id: "layouts", sessionId: "proto-1", title: "Layouts", kind: "nsh", revision: 2, createdAt: 1, updatedAt: 5 },
	]);
	chats.set("proto-1", { id: "proto-1", projectId: f.project.id, state: "idle", working: false, outcome: "done" });
	await settle();
	const links = f.store.artifactReferences(f.missionId, "layouts");
	assert.deepEqual(
		links.map((l) => [l.sessionId, l.revision, l.taskId]),
		[["proto-1", 2, task.id]],
	);
	assert.equal(sent.length, 1);
	assert.equal(sent[0]!.id, builder);
	assert.match(sent[0]!.message, /artifact layouts, revision 2/);
	assert.match(sent[0]!.message, /Ask the user with ask_user/);
	assert.match(sent[0]!.message, /A, B and C/);
	await settle();
	assert.equal(sent.length, 1, "the result is sent once");
	assert.equal(((await ask(builder, { taskId: task.id })) as { state: string }).state, "reported");

	// A change request starts from the earlier mockup, within the per-task limit.
	await ask(builder, { ...request, requestId: "layouts-2", question: "Make B denser" });
	await settle();
	assert.equal(spawned.length, 2);
	assert.match(spawned[1]!.message, /artifact layouts, revision 2, of chat proto-1/);
});

test("builders waiting for their task prototypes leave worker slots for the prototype chats", async (t) => {
	const f = await fixture(t, { twoSlices: true });
	const tasks = f.store.tasks(f.missionId);
	const builders = ["builder-1", "builder-2"];
	const chats = new Map<string, Partial<SessionSummary>>();
	for (const [i, id] of builders.entries()) {
		chats.set(id, { id, projectId: f.project.id, state: "idle", working: false, inputGeneration: 0 });
		f.store.join(id, f.missionId, { sessionId: f.owner }, "builder");
		f.store.updateTask(f.missionId, tasks[i]!.id, { sessionId: id }, { sessionId: f.owner });
	}
	const get = f.sessions.get.bind(f.sessions);
	t.mock.method(f.sessions, "get", (id: string) =>
		chats.has(id) ? ({ ...chats.get(id) } as SessionSummary) : get(id),
	);
	const service = new MissionService(f.store, f.sessions, f.projects);
	const occupied = async () =>
		((await service.call(f.owner, "get", {})) as { continuation: { occupiedWorkers: number } }).continuation
			.occupiedWorkers;
	assert.equal(await occupied(), 2, "idle builders with open tasks hold their slots");

	const ask = (i: number) =>
		service.call(builders[i]!, "prototype", {
			taskId: tasks[i]!.id,
			requestId: `layouts-${i}`,
			question: "Compare layouts",
			prototypeModel: "faux/opus",
		});
	await ask(0);
	assert.equal(await occupied(), 1, "a builder waiting for its prototype frees its slot");
	await ask(1);
	assert.equal(await occupied(), 0);

	chats.set(builders[0]!, { ...chats.get(builders[0]!), state: "working", working: true });
	assert.equal(await occupied(), 1, "a working builder still holds a slot");
});
