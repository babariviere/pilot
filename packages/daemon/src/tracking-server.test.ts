import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ProjectDashboard, ServerMessage, SessionSummary, TrackingSource } from "@pilot/protocol";
import { WebSocket } from "ws";
import type { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import type { SessionManager } from "./sessions.ts";
import { SourceRegistry } from "./sources.ts";
import { SourceSignInRequired } from "./source-mcp.ts";
import type { TerminalManager } from "./terminals.ts";
import { TrackedItemStore } from "./tracked-items.ts";

test("tracking HTTP, WS invalidation and DashboardProviders.tracked share project-scoped data", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-tracking-server-"));
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: home, tracking: { slackChannels: ["C1"], linearTeam: "ENG" } });
	await mkdir(join(home, "other"));
	const other = await projects.create({ path: join(home, "other") });
	const items = new TrackedItemStore(join(home, "tracked.sqlite"));
	await items.load([project.id]);
	const tracking = new SourceRegistry(projects, items, {
		async call() {
			throw new SourceSignInRequired();
		},
	});
	tracking.register("linear", async (context) => {
		await context.call("issues", {});
		return { items: [] };
	});
	const chats = new Map<string, SessionSummary>();
	chats.set("foreign", { id: "foreign", projectId: other.id } as SessionSummary);
	const sessions = {
		list: () => [],
		get: (id: string) => chats.get(id),
		onChange: () => () => {},
		onArtifactsChanged: () => () => {},
		setWorkspaceProcessGuard() {},
	} as unknown as SessionManager;
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		{} as ModelCatalog,
		{ isRunning: () => false } as unknown as TerminalManager,
		undefined,
		undefined,
		undefined,
		undefined,
		tracking,
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
	const ws = new WebSocket(root.replace("http:", "ws:") + "/ws");
	const messages: ServerMessage[] = [];
	ws.on("message", (data) => messages.push(JSON.parse(String(data))));
	t.after(async () => {
		ws.terminate();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await tracking.stop();
		await items.close();
		await rm(home, { recursive: true, force: true });
	});
	await once(ws, "open");
	async function until(check: () => boolean) {
		for (let i = 0; i < 300; i++) {
			if (check()) return;
			await delay(10);
		}
		assert.fail("No expected WS update");
	}
	await until(() => messages.some((message) => message.type === "sources"));
	const api = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
		fetch(root + path, {
			method,
			...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
		});
	const sources = (await (await api(`/sources?projectId=${project.id}`)).json()) as TrackingSource[];
	assert.equal(sources.length, 2);
	assert.equal((await api("/sources/missing/poll", {})).status, 404);
	assert.equal((await api(`/sources/${other.id}:linear/poll`, {})).status, 409);
	assert.equal((await api(`/sources/${project.id}:slack/poll`, {})).status, 503, "no poller installed");
	const auth = (await (await api(`/sources/${project.id}:linear/poll`, {})).json()) as TrackingSource;
	assert.equal(auth.status, "sign_in_required");
	assert.equal(auth.signInCommand, "pi mcp login linear");
	ws.send(JSON.stringify({ type: "dashboard.subscribe", projectId: project.id }));
	await until(() => messages.some((message) => message.type === "dashboard"));
	await items.commit(
		project.id,
		"linear",
		Array.from({ length: 8 }, (_, i) => ({
			externalId: String(i),
			title: `Ticket ${i}`,
			url: `https://example.com/${i}`,
			status: "Todo",
			metadata: {},
			updatedAt: i,
		})),
	);
	await until(() =>
		messages.some((message) => message.type === "tracked.changed" && message.projectId === project.id),
	);
	await until(() =>
		messages.some((message) => message.type === "dashboard" && message.dashboard.tracked[0]?.total === 8),
	);
	const dashboard = (await (await api(`/projects/${project.id}/dashboard`)).json()) as ProjectDashboard;
	assert.equal(dashboard.tracked[0]?.items.length, 5);
	assert.equal(dashboard.tracked[0]?.status, "sign_in_required");
	assert.equal((await api("/tracked-items")).status, 400);
	assert.equal((await api(`/tracked-items?projectId=${project.id}&limit=101`)).status, 400);
	assert.equal((await api(`/tracked-items?projectId=${project.id}&kind=bogus`)).status, 400);
	const page = await (await api(`/tracked-items?projectId=${project.id}&limit=2`)).json();
	assert.equal(page.total, 8);
	assert.equal(page.items.length, 2);
	const id = page.items[0].id;
	assert.equal((await api(`/tracked-items/${id}`, { sessionId: "foreign" }, "PATCH")).status, 400);
	assert.equal((await api(`/tracked-items/${id}`, { missionId: "missing" }, "PATCH")).status, 400);
	assert.equal((await api(`/tracked-items/${id}`, { title: "forged" }, "PATCH")).status, 400);
	assert.equal((await api(`/tracked-items/${id}`, { dismissed: true }, "PATCH")).status, 200);
	assert.equal((await (await api(`/tracked-items?projectId=${project.id}&dismissed=true`)).json()).total, 1);
	assert.equal(tracking.dashboard(project.id)[0]?.total, 7);
	assert.equal((await (await api(`/tracked-items?projectId=${other.id}`)).json()).total, 0);
});
