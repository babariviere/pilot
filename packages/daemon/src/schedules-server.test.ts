import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ScheduledItem, ServerMessage, SessionSummary } from "@pilot/protocol";
import { WebSocket } from "ws";
import type { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { ScheduleStore } from "./schedule-store.ts";
import { ScheduleService } from "./schedules.ts";
import { createDaemonServer } from "./server.ts";
import type { SessionManager } from "./sessions.ts";
import type { TerminalManager } from "./terminals.ts";
import { TrackedItemStore } from "./tracked-items.ts";

test("schedule CRUD API, reconnect snapshot, WS updates, and dashboard provider", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-schedules-api-"));
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: home, workspace: "direct" });
	const existing: SessionSummary = {
		id: "existing",
		title: "Existing",
		projectId: project.id,
		cwd: home,
		state: "idle",
		createdAt: 1,
		updatedAt: 1,
	};
	let targetExists = true;
	const sessions = {
		setWorkspaceProcessGuard() {},
		list: () => [existing],
		get: () => (targetExists ? existing : undefined),
		onChange: () => () => {},
		onArtifactsChanged: () => () => {},
		send: async () => {},
		spawn: async () => ({ id: "spawned" }),
	} as unknown as SessionManager;
	const store = new ScheduleStore(join(home, "schedules.sqlite"));
	const trackedItems = new TrackedItemStore(join(home, "tracked-items.sqlite"));
	await trackedItems.load([project.id]);
	await trackedItems.commit(project.id, "linear", [
		{
			externalId: "issue-1",
			title: "Fix crash",
			url: "https://example.com/issue/1",
			status: "Todo",
			metadata: {},
			updatedAt: 1,
		},
	]);
	const ticket = (await trackedItems.list({ projectId: project.id })).items[0]!;
	const schedules = new ScheduleService(store, { sessions, projects, trackedItems });
	await schedules.load();
	schedules.start();
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		{} as ModelCatalog,
		{ isRunning: () => false } as unknown as TerminalManager,
		undefined,
		undefined,
		undefined,
		schedules,
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = (server.address() as AddressInfo).port;
	const sockets: WebSocket[] = [];
	t.after(async () => {
		for (const ws of sockets) ws.terminate();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await schedules.stop();
		await store.close();
		await trackedItems.close();
		await rm(home, { recursive: true, force: true });
	});
	const api = (path: string, method = "GET", body?: unknown) =>
		fetch(`http://127.0.0.1:${port}/api${path}`, {
			method,
			...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
		});
	const connect = async () => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
		const messages: ServerMessage[] = [];
		sockets.push(ws);
		ws.on("message", (raw) => messages.push(JSON.parse(String(raw))));
		await once(ws, "open");
		return { ws, messages };
	};
	const waitFor = async (check: () => boolean) => {
		const deadline = Date.now() + 5000;
		while (!check()) {
			assert.ok(Date.now() < deadline, "missing WS update");
			await delay(5);
		}
	};
	const first = await connect();
	assert.equal((await api("/schedules/wifi")).status, 404);
	assert.equal((await api("/schedules/wifi", "POST", {})).status, 404);
	await waitFor(() => first.messages.some((m) => m.type === "schedules" && m.schedules.length === 0));
	first.ws.send(JSON.stringify({ type: "dashboard.subscribe", projectId: project.id }));
	const request = { trigger: "on_wake", target: { kind: "message", sessionId: "existing", message: "Continue" } };
	assert.equal((await api("/schedules", "POST", null)).status, 400);
	assert.equal((await api("/schedules", "POST", { ...request, trigger: "bogus" })).status, 400);
	assert.equal((await api("/schedules/unknown")).status, 404);
	for (const trigger of ["on_join_network", "on_leave_network", "removed"])
		assert.equal((await api("/schedules", "POST", { ...request, trigger })).status, 400);
	const response = await api("/schedules", "POST", request);
	assert.equal(response.status, 201);
	const item = (await response.json()) as ScheduledItem;
	assert.equal(item.projectId, project.id);
	for (const trigger of ["on_join_network", "on_leave_network", "removed"])
		assert.equal((await api(`/schedules/${item.id}`, "PATCH", { trigger })).status, 400);
	await waitFor(() => first.messages.some((m) => m.type === "schedules" && m.schedules.some((s) => s.id === item.id)));
	await waitFor(() => first.messages.some((m) => m.type === "dashboard" && m.dashboard.scheduled.total === 1));
	const list = (await (await api(`/schedules?projectId=${project.id}`)).json()) as ScheduledItem[];
	assert.equal(list[0].id, item.id);
	assert.deepEqual(await (await api("/schedules?projectId=elsewhere")).json(), []);
	const editedResponse = await api(`/schedules/${item.id}`, "PATCH", { title: "New title", expectedRevision: 1 });
	assert.equal(editedResponse.status, 200);
	const edited = (await editedResponse.json()) as ScheduledItem;
	assert.equal(edited.revision, 2);
	assert.equal((await api(`/schedules/${item.id}`, "PATCH", { expectedRevision: 1, title: "Stale" })).status, 409);
	const second = await connect();
	await waitFor(() =>
		second.messages.some((m) => m.type === "schedules" && m.schedules.some((s) => s.title === "New title")),
	);
	targetExists = false;
	await schedules.signal({ type: "sleep", at: Date.now() + 1 });
	await schedules.signal({ type: "wake", full: true });
	await waitFor(() =>
		first.messages.some(
			(m) => m.type === "schedules" && m.schedules.some((s) => s.id === item.id && s.state === "failed"),
		),
	);
	await waitFor(() =>
		first.messages.some(
			(m) => m.type === "dashboard" && m.dashboard.needsYou.items.some((s) => s.scheduledId === item.id),
		),
	);
	assert.equal((await api(`/schedules/${item.id}`, "PATCH", { title: "Too late" })).status, 409);
	assert.equal((await api(`/schedules/${item.id}`, "DELETE")).status, 200);
	assert.equal((await api(`/schedules/${item.id}`)).status, 404);
	targetExists = true;
	const cancelled = (await (await api("/schedules", "POST", request)).json()) as ScheduledItem;
	assert.equal((await api(`/schedules/${cancelled.id}`, "DELETE")).status, 200);
	await schedules.signal({ type: "sleep", at: Date.now() + 1 });
	await schedules.signal({ type: "wake", full: true });
	assert.equal(((await (await api(`/schedules/${cancelled.id}`)).json()) as ScheduledItem).state, "cancelled");

	const chatTarget = {
		kind: "chat",
		spawn: { projectId: project.id, message: "Fix crash" },
		trackedItemId: ticket.id,
	};
	assert.equal((await api("/schedules", "POST", { target: { ...chatTarget, trackedItemId: null } })).status, 400);
	assert.equal((await api("/schedules", "POST", { target: { ...chatTarget, trackedItemId: "missing" } })).status, 404);
	const chatResponse = await api("/schedules", "POST", { trigger: "on_wake", target: chatTarget });
	assert.equal(chatResponse.status, 201);
	const scheduledChat = (await chatResponse.json()) as ScheduledItem;
	assert.deepEqual(scheduledChat.target, chatTarget);
	assert.equal((await trackedItems.require(ticket.id)).sessionId, undefined);
	const updatedChat = await api(`/schedules/${scheduledChat.id}`, "PATCH", { title: "Later" });
	assert.equal(updatedChat.status, 200);
	assert.deepEqual(((await updatedChat.json()) as ScheduledItem).target, chatTarget);
	await waitFor(() =>
		first.messages.some(
			(m) =>
				m.type === "schedules" &&
				m.schedules.some(
					(s) => s.id === scheduledChat.id && s.target.kind === "chat" && s.target.trackedItemId === ticket.id,
				),
		),
	);
	await schedules.signal({ type: "sleep", at: Date.now() + 1 });
	await schedules.signal({ type: "wake", full: true });
	assert.equal((await trackedItems.require(ticket.id)).sessionId, "spawned");
	const dispatched = (await (await api(`/schedules/${scheduledChat.id}`)).json()) as ScheduledItem;
	assert.equal(dispatched.state, "fired");
	assert.equal(dispatched.sessionId, "spawned");
});
