import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Inbox, ProjectDashboard, ProjectDashboardCounts, ServerMessage } from "@pilot/protocol";
import { WebSocket } from "ws";
import { ChatSettingsService } from "./chat-settings.ts";
import { GitHubSetupService } from "./github-setup.ts";
import { daemonHello } from "./hello.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { ScheduleStore } from "./schedule-store.ts";
import { ScheduleService } from "./schedules.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

test("recurring schedule writes require native authority, live setting and exact home", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-hook-api-"));
	const settings = await ChatSettingsService.open(home);
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: home });
	const sessions = new SessionManager(home, projects);
	const terminals = new TerminalManager();
	const native = new GitHubSetupService(
		home,
		{ hostId: "fixture", daemonId: "fixture", lineageId: "fixture" },
		{ userHome: home, env: {} },
	);
	await native.status();
	const token = JSON.parse(await readFile(join(home, "github-app-capability"), "utf8")).token as string;
	const hello = await daemonHello(home, {
		powerManagement: false,
		systemSleepEvents: false,
		swiftUIArtifacts: false,
		coordinatorIsolation: false,
		independentExecution: true,
	});
	const store = new ScheduleStore(join(home, "schedules.sqlite"));
	const schedules = new ScheduleService(store, {
		sessions,
		projects,
		automationsEnabled: () => settings.automationsEnabled(),
		home: { daemonId: hello.daemonId, lineageId: hello.lineageId! },
	});
	await schedules.load();
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog(home),
		terminals,
		undefined,
		undefined,
		undefined,
		schedules,
		undefined,
		undefined,
		undefined,
		hello,
		undefined,
		false,
		undefined,
		undefined,
		native,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		settings,
	);
	t.after(async () => {
		await schedules.stop();
		await store.close();
		await sessions.shutdown();
		await terminals.shutdown();
		await native.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(home, { recursive: true, force: true });
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/schedules`;
	const request = {
		trigger: "recurring",
		recurrence: { every: "day", time: "09:00", timeZone: "UTC" },
		expectedHome: { daemonId: hello.daemonId, lineageId: hello.lineageId },
		target: { kind: "chat", spawn: { projectId: project.id, message: "Check" } },
	};
	const write = (body: unknown, auth = token, id = "") =>
		fetch(url + id, {
			method: id ? "PATCH" : "POST",
			headers: { "content-type": "application/json", "x-pilot-github-capability": auth },
			body: JSON.stringify(body),
		});
	assert.equal((await write(request)).status, 503);
	await settings.update({ automations: true, expectedRevision: settings.settings().revision });
	assert.equal((await write(request, "wrong")).status, 403);
	assert.equal(
		(await write({ ...request, expectedHome: { ...request.expectedHome, lineageId: "other" } })).status,
		409,
	);
	assert.equal((await write({ ...request, handledThrough: 0 })).status, 400);
	const response = await write(request);
	assert.equal(response.status, 201);
	const row = await response.json();
	const patch = { title: "Edited", expectedHome: request.expectedHome, expectedRevision: row.revision };
	assert.equal((await write(patch, "wrong", "/" + row.id)).status, 403);
	assert.equal((await write(patch, token, "/" + row.id)).status, 200);
	assert.equal((await write(patch, token, "/" + row.id)).status, 409);
	// The scheduler is deliberately unstarted. Roster, dashboard, Inbox and WS reads are passive.
	const current = schedules.require(row.id);
	const run = {
		due: current.at!,
		at: current.at! + 600000,
		outcome: "started" as const,
		late: true as const,
		sessionId: "chat",
	};
	const noted = await store.replace(current, { ...current, notice: run, runs: [run] });
	const root = url.replace("/api/schedules", "/api");
	const get = async <T>(path: string): Promise<T> => (await (await fetch(root + path)).json()) as T;
	const inbox = await get<Inbox>("/inbox");
	assert.equal(inbox.needsYou.total, 1);
	assert.equal(inbox.needsYou.items[0].countsInBadge, false);
	assert.deepEqual(await get<ProjectDashboardCounts>("/dashboard/counts"), { projects: {} });
	assert.equal((await get<ProjectDashboard>(`/projects/${project.id}/dashboard`)).summary.needsYou, 0);
	assert.deepEqual(schedules.require(row.id), noted, "reads leave the durable cursor and revision untouched");
	const ws = new WebSocket(root.replace("http:", "ws:") + "/ws");
	t.after(() => ws.terminate());
	const next = (predicate: (message: ServerMessage) => boolean): Promise<ServerMessage> =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				ws.off("message", receive);
				reject(new Error("Missing notice WS frame"));
			}, 5000);
			const receive = (raw: Buffer) => {
				const value = JSON.parse(String(raw)) as ServerMessage;
				if (predicate(value)) {
					clearTimeout(timer);
					ws.off("message", receive);
					resolve(value);
				}
			};
			ws.on("message", receive);
		});
	const baseline = next(
		(m) => m.type === "schedules" && m.schedules.some((item) => item.id === row.id && !!item.notice?.late),
	);
	await once(ws, "open");
	await baseline;
	const pushedDashboard = next(
		(m) => m.type === "dashboard" && m.dashboard.needsYou.items.some((item) => item.countsInBadge === false),
	);
	ws.send(JSON.stringify({ type: "dashboard.subscribe", projectId: project.id }));
	await pushedDashboard;
	const failedCounts = next((m) => m.type === "dashboard.counts" && m.counts.projects[project.id]?.needsYou === 1);
	const failedRun = { due: run.due, at: run.at + 1, outcome: "failed" as const, error: "Missing target" };
	const failed = await store.replace(noted, { ...noted, notice: failedRun, runs: [run, failedRun], paused: true });
	await failedCounts;
	const dismissal = { dismissNotice: true, expectedRevision: failed.revision, expectedHome: request.expectedHome };
	assert.equal((await write(dismissal, "wrong", `/${row.id}`)).status, 403);
	assert.equal((await write({ ...dismissal, expectedRevision: noted.revision }, token, `/${row.id}`)).status, 409);
	const dismissedFrame = next(
		(m) =>
			m.type === "schedules" &&
			m.schedules.some((item) => item.id === row.id && item.revision > failed.revision && !item.notice),
	);
	const clearedCounts = next((m) => m.type === "dashboard.counts" && !m.counts.projects[project.id]);
	assert.equal((await write(dismissal, token, `/${row.id}`)).status, 200);
	await Promise.all([dismissedFrame, clearedCounts]);
	assert.equal((await get<Inbox>("/inbox")).needsYou.total, 0);
	assert.equal(schedules.require(row.id).handledThrough, current.handledThrough);
	assert.deepEqual(schedules.require(row.id).runs, [run, failedRun]);
	assert.equal(schedules.require(row.id).at, current.at);
	ws.terminate();
	await settings.update({ automations: false, expectedRevision: settings.settings().revision });
	assert.equal((await write({ ...patch, expectedRevision: row.revision + 1 }, token, "/" + row.id)).status, 503);
	assert.equal((await fetch(url)).status, 200);
	assert.equal(schedules.list().length, 1);
});
