import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { daemonHello } from "./hello.ts";
import { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import { ModelCatalog } from "./models.ts";
import { OperationJournal } from "./operation-journal.ts";
import { ProjectStore } from "./projects.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";
import { createDaemonFixtureServer as createDaemonServer } from "./testing/daemon-server.ts";
import { offlineSessionOptions } from "./testing/offline-session-options.ts";

test("transport construction and listening never recover durable operations, even without live update", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-recovery-owner-"));
	const projects = new ProjectStore(home);
	await projects.load();
	const sessions = new SessionManager(home, projects, home, {}, {}, offlineSessionOptions());
	const terminals = new TerminalManager();
	const hello = await daemonHello(home, {
		independentExecution: true,
		coordinatorIsolation: false,
		powerManagement: false,
		systemSleepEvents: false,
		swiftUIArtifacts: false,
	});
	let scans = 0;
	t.mock.method(OperationJournal.prototype, "recover", async () => {
		scans++;
	});
	const server = createDaemonServer({
		config: { home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		models: new ModelCatalog(home),
		terminals,
		hello,
	});
	t.after(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await Promise.all([server.services.close(), sessions.shutdown(), terminals.shutdown()]);
		await rm(home, { recursive: true, force: true });
	});
	await server.runtimeReady;
	assert.equal(scans, 0);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	assert.equal(scans, 0);
	await sessions.load();
	assert.equal(scans, 0);
	server.services.recoverOperations();
	assert.equal(scans, 1);
});

test("server close releases subscriptions before reusing the same session and project services", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-server-lifecycle-"));
	const projects = new ProjectStore(home);
	await projects.load();
	const sessions = new SessionManager(home, projects);
	const terminals = new TerminalManager();
	const models = new ModelCatalog(home);
	const active = { sessions: 0, projects: 0, artifacts: 0 };
	const sessionChange = sessions.onChange.bind(sessions);
	const projectChange = projects.onChange.bind(projects);
	const artifactChange = sessions.onArtifactsChanged.bind(sessions);
	t.mock.method(sessions, "onChange", (listener: Parameters<SessionManager["onChange"]>[0]) => {
		active.sessions++;
		const stop = sessionChange(listener);
		return () => {
			active.sessions--;
			stop();
		};
	});
	t.mock.method(projects, "onChange", (listener: Parameters<ProjectStore["onChange"]>[0]) => {
		active.projects++;
		const stop = projectChange(listener);
		return () => {
			active.projects--;
			stop();
		};
	});
	t.mock.method(sessions, "onArtifactsChanged", (listener: Parameters<SessionManager["onArtifactsChanged"]>[0]) => {
		active.artifacts++;
		const stop = artifactChange(listener);
		return () => {
			active.artifacts--;
			stop();
		};
	});
	t.after(async () => {
		await sessions.shutdown();
		await terminals.shutdown();
		await rm(home, { recursive: true, force: true });
	});
	for (let i = 0; i < 2; i++) {
		const server = createDaemonServer({
			config: { home, host: "127.0.0.1", port: 0 },
			sessions,
			projects,
			models,
			terminals,
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		try {
			assert.ok(active.sessions > 0 && active.projects > 0 && active.artifacts > 0);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		assert.deepEqual(active, { sessions: 0, projects: 0, artifacts: 0 });
	}
});

test("mission context observers have an idempotent owner disposal", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-mission-lifecycle-"));
	const projects = new ProjectStore(home);
	const sessions = new SessionManager(home, projects);
	const store = new MissionStore(":memory:");
	let changes = 0;
	let storeChanges = 0;
	const originalStore = store.onChange.bind(store);
	t.mock.method(store, "onChange", (listener: Parameters<MissionStore["onChange"]>[0]) => {
		storeChanges++;
		const stop = originalStore(listener);
		return () => {
			storeChanges--;
			stop();
		};
	});
	const original = sessions.onChange.bind(sessions);
	t.mock.method(sessions, "onChange", (listener: Parameters<SessionManager["onChange"]>[0]) => {
		changes++;
		const stop = original(listener);
		return () => {
			changes--;
			stop();
		};
	});
	const service = new MissionService(store, sessions, projects);
	t.after(async () => {
		await sessions.shutdown();
		service.dispose();
		store.close();
		await rm(home, { recursive: true, force: true });
	});
	assert.ok(changes > 0);
	await service.notices.stop();
	await service.continuations.stop();
	service.dispose();
	service.dispose();
	assert.equal(changes, 0);
	assert.equal(storeChanges, 0);
});
