import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ProjectDashboard, ProjectDashboardCounts, ServerMessage, SessionSummary } from "@pilot/protocol";
import { WebSocket } from "ws";
import type { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import type { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import type { SessionManager } from "./sessions.ts";
import type { TerminalManager } from "./terminals.ts";

async function until<T>(check: () => T | undefined | false): Promise<T> {
	const deadline = Date.now() + 3_000;
	for (;;) {
		const value = check();
		if (value) return value;
		assert.ok(Date.now() < deadline, "condition did not settle");
		await delay(5);
	}
}

async function fixture(t: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "pilot-dashboard-"));
	const projectDir = join(home, "project");
	const { mkdir } = await import("node:fs/promises");
	await mkdir(projectDir);
	const projects = new ProjectStore(join(home, "data"));
	await projects.load();
	const project = await projects.create({ path: projectDir, workspace: "direct" });
	const store = new MissionStore(":memory:");
	const chats = new Map<string, SessionSummary>();
	const listeners = new Set<(session: SessionSummary) => void>();
	const sessions = {
		setWorkspaceProcessGuard() {},
		list: (query: { projectId?: string; archived?: string } = {}) =>
			[...chats.values()].filter((chat) => !query.projectId || chat.projectId === query.projectId),
		get: (id: string) => chats.get(id),
		onChange(listener: (session: SessionSummary) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		onArtifactsChanged: () => () => {},
	} as unknown as SessionManager;
	const put = (chat: Partial<SessionSummary> & { id: string }) => {
		const value: SessionSummary = {
			title: chat.id,
			cwd: "/work",
			projectId: project.id,
			createdAt: 1,
			updatedAt: 1,
			state: "idle",
			...chat,
		};
		chats.set(value.id, value);
		for (const listener of listeners) listener(value);
		return value;
	};
	const providerListeners = new Set<() => void>();
	let pending = [] as Array<{ id: string; title: string; kind: "chat"; trigger: "on_back"; state: "pending" }>;
	const server = createDaemonServer(
		{ home: join(home, "data"), host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		{} as ModelCatalog,
		{ isRunning: () => false } as unknown as TerminalManager,
		{ service: {} as MissionService, store },
		{
			scheduled: () => pending,
			onChange(listener) {
				providerListeners.add(listener);
				return () => providerListeners.delete(listener);
			},
		},
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = (server.address() as AddressInfo).port;
	const sockets: WebSocket[] = [];
	t.after(async () => {
		for (const ws of sockets) ws.terminate();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		store.close();
		await rm(home, { recursive: true, force: true });
	});
	const api = (path: string, init?: RequestInit) =>
		fetch(`http://127.0.0.1:${port}/api${path}`, {
			...init,
			headers: init?.body ? { "content-type": "application/json" } : {},
		});
	const connect = async () => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
		sockets.push(ws);
		const messages: ServerMessage[] = [];
		ws.on("message", (raw) => messages.push(JSON.parse(String(raw)) as ServerMessage));
		await once(ws, "open");
		return { ws, messages };
	};
	return {
		project,
		store,
		put,
		api,
		connect,
		schedule: (item: (typeof pending)[number]) => {
			pending = [...pending, item];
			for (const listener of providerListeners) listener();
		},
	};
}

test("GET /api/projects/:id/dashboard aggregates the project and rejects unknown ones", async (t) => {
	const f = await fixture(t);
	const mission = f.store.create({ projectId: f.project.id, title: "API v2", goal: "" });
	f.store.addTask(mission.id, { title: "One", status: "done" });
	f.store.addTask(mission.id, { title: "Two", status: "blocked" });
	f.store.addTask(mission.id, { title: "Dropped", status: "dropped" });
	f.put({ id: "working", state: "working", lastUserMessageAt: 50, missionId: mission.id, model: "t/m" });
	f.put({ id: "failed", outcome: "failed", outcomeAt: 10, outcomeReason: "boom" });
	f.put({ id: "other", projectId: "elsewhere", state: "working" });

	const response = await f.api(`/projects/${f.project.id}/dashboard`);
	assert.equal(response.status, 200);
	const dashboard = (await response.json()) as ProjectDashboard;
	assert.equal(dashboard.projectId, f.project.id);
	assert.deepEqual(dashboard.summary, {
		chats: 2,
		working: 1,
		needsYou: 2,
		openPullRequests: 0,
		readyPullRequests: 0,
		activeMissions: 1,
	});
	assert.deepEqual(
		dashboard.needsYou.items.map((item) => [item.kind, item.title, item.reason, item.count]),
		[
			["failed", "failed", "boom", undefined],
			["question", "API v2", undefined, 1],
		],
	);
	assert.equal(dashboard.working.items[0]?.missionTitle, "API v2");
	assert.deepEqual(dashboard.missions.items[0], {
		id: mission.id,
		title: "API v2",
		tasksDone: 1,
		tasksTotal: 2,
		working: 1,
		needsYou: 1,
	});

	assert.equal((await f.api("/projects/nope/dashboard")).status, 404);
	const counts = (await (await f.api("/dashboard/counts")).json()) as ProjectDashboardCounts;
	assert.deepEqual(counts, { projects: { [f.project.id]: { working: 1, needsYou: 2 } } });
});

test("POST /api/reviews moves a result from needs you to recent and rejects bad input", async (t) => {
	const f = await fixture(t);
	f.put({ id: "done", outcome: "done", outcomeAt: 20 });
	const read = async () => (await (await f.api(`/projects/${f.project.id}/dashboard`)).json()) as ProjectDashboard;
	assert.equal((await read()).needsYou.total, 1);
	const post = (body: unknown) => f.api("/reviews", { method: "POST", body: JSON.stringify(body) });
	// Unknown chats are ignored, an older mark does not review a newer result.
	assert.equal((await post({ marks: [{ sessionId: "ghost", outcomeAt: 99 }] })).status, 200);
	assert.equal((await post({ marks: [{ sessionId: "done", outcomeAt: 19 }] })).status, 200);
	assert.equal((await read()).needsYou.total, 1);
	assert.equal((await post({ marks: [{ sessionId: "done", outcomeAt: 20 }] })).status, 200);
	const after = await read();
	assert.equal(after.needsYou.total, 0);
	assert.deepEqual(
		after.recent.items.map((item) => item.sessionId),
		["done"],
	);
	for (const body of [
		{},
		{ marks: "x" },
		{ marks: [{ sessionId: "done" }] },
		{ marks: [{ sessionId: 1, outcomeAt: 1 }] },
	])
		assert.equal((await post(body)).status, 400);
	assert.equal(
		(await post({ marks: Array.from({ length: 1001 }, () => ({ sessionId: "done", outcomeAt: 1 })) })).status,
		400,
	);
});

test("WebSocket pushes counts on connect and dashboards on change, without duplicates", async (t) => {
	const f = await fixture(t);
	f.put({ id: "a", state: "working" });
	const { ws, messages } = await f.connect();
	const dashboards = () =>
		messages.filter((m): m is Extract<ServerMessage, { type: "dashboard" }> => m.type === "dashboard");
	const counts = () =>
		messages.filter((m): m is Extract<ServerMessage, { type: "dashboard.counts" }> => m.type === "dashboard.counts");
	await until(() => counts().length === 1);
	assert.deepEqual(counts()[0]!.counts, { projects: { [f.project.id]: { working: 1, needsYou: 0 } } });
	assert.equal(dashboards().length, 0);

	ws.send(JSON.stringify({ type: "dashboard.subscribe", projectId: f.project.id }));
	await until(() => dashboards().length === 1);
	assert.equal(dashboards()[0]!.dashboard.working.total, 1);

	// A burst of changes yields one update with the final state.
	f.put({ id: "b", state: "working" });
	f.put({ id: "c", outcome: "done", outcomeAt: 5 });
	await until(() => dashboards().length === 2);
	assert.equal(dashboards()[1]!.dashboard.working.total, 2);
	assert.equal(dashboards()[1]!.dashboard.needsYou.total, 1);
	await until(() => counts().length === 2);
	assert.deepEqual(counts()[1]!.counts, { projects: { [f.project.id]: { working: 2, needsYou: 1 } } });

	// A change that does not alter the dashboard (a title-less metadata touch) pushes nothing.
	f.put({ id: "a", state: "working", updatedAt: 99 });
	await delay(500);
	assert.equal(dashboards().length, 2);
	assert.equal(counts().length, 2);

	// Mission changes and extension providers also update it.
	f.store.create({ projectId: f.project.id, title: "M", goal: "" });
	await until(() => dashboards().length === 3);
	assert.equal(dashboards()[2]!.dashboard.missions.total, 1);
	f.schedule({ id: "x", title: "Plan", kind: "chat", trigger: "on_back", state: "pending" });
	await until(() => dashboards().length === 4);
	assert.equal(dashboards()[3]!.dashboard.scheduled.total, 1);

	ws.send(JSON.stringify({ type: "dashboard.unsubscribe", projectId: f.project.id }));
	await delay(50);
	f.put({ id: "d", state: "working" });
	await until(() => counts().length === 3);
	await delay(400);
	assert.equal(dashboards().length, 4);

	ws.send(JSON.stringify({ type: "dashboard.subscribe", projectId: "missing" }));
	await until(() => messages.some((m) => m.type === "error" && /Unknown project/.test(m.message)));
});
