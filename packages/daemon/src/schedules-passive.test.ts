import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ScheduledItem } from "@pilot/protocol";
import type { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { ScheduleStore } from "./schedule-store.ts";
import { ScheduleService } from "./schedules.ts";
import { createDaemonServer } from "./server.ts";
import type { SessionManager } from "./sessions.ts";
import type { TerminalManager } from "./terminals.ts";

test("schedule GET list/detail are passive even after a pending deadline becomes overdue", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-schedule-passive-"));
	const store = new ScheduleStore(join(home, "schedules.sqlite"));
	await store.load(100);
	const item: ScheduledItem = {
		id: "exact-schedule",
		revision: 1,
		title: "日本語 👩‍💻",
		projectId: "exact-project",
		trigger: "at",
		at: 200,
		target: { kind: "message", sessionId: "exact-chat", message: "Keep  spaces\n é" },
		sessionId: "exact-chat",
		state: "pending",
		createdAt: 100,
		updatedAt: 100,
	};
	await store.create(item);
	let now = 100;
	let cancelCount = 0;
	let timerCount = 0;
	let markArmed!: () => void;
	const armed = new Promise<void>((resolve) => {
		markArmed = resolve;
	});
	const calls: string[] = [];
	const forbidden = (name: string): never => {
		calls.push(name);
		assert.fail(`passive GET must not invoke ${name}`);
	};
	const sessions = {
		setWorkspaceProcessGuard() {},
		list: () => [],
		get: () => forbidden("session validation"),
		onChange: () => () => {},
		onArtifactsChanged: () => () => {},
		send: async () => forbidden("send"),
		spawn: async () => forbidden("spawn"),
	} as unknown as SessionManager;
	const schedules = new ScheduleService(store, {
		sessions,
		projects: { require: () => forbidden("project validation") },
		trackedItems: {
			require: async () => forbidden("tracked-item validation"),
			patch: async () => forbidden("tracked-item mutation"),
		},
		triggers: {
			online: true,
			subscribe: () => () => {},
			refreshOnline: async () => forbidden("reachability/provider probe"),
		},
		clock: {
			now: () => now,
			setTimeout: (_callback, delay) => {
				assert.equal(delay, 100);
				timerCount++;
				markArmed();
				return () => {
					cancelCount++;
				};
			},
		},
	});
	const projects = new ProjectStore(home);
	await projects.load();
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
	t.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await schedules.stop();
		await store.close();
		await rm(home, { recursive: true, force: true });
	});
	schedules.start();
	await armed;
	now = 300; // Advance time without delivering the scheduler-owned timer callback.
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = (server.address() as AddressInfo).port;
	const get = async (path: string, status = 200) => {
		const response = await fetch(`http://127.0.0.1:${port}/api${path}`);
		assert.equal(response.status, status);
		return response.json();
	};
	for (let i = 0; i < 2; i++) {
		assert.deepEqual(await get("/schedules"), [item]);
		assert.deepEqual(await get("/schedules?projectId=exact-project"), [item]);
		assert.deepEqual(await get("/schedules?projectId=other-project"), []);
		assert.deepEqual(await get("/schedules/exact-schedule"), item);
		await get("/schedules/missing", 404);
	}
	assert.deepEqual(store.list(), [item], "no claim, state, revision or latch changed");
	assert.deepEqual(calls, []);
	assert.equal(timerCount, 1, "GET did not queue or rearm a sweep");
	assert.equal(cancelCount, 0, "GET did not touch the scheduler timer");
});
