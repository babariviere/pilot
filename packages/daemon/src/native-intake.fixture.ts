/** Real local HTTP/storage; synthetic sources and no model processes or external calls. */
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubSetupService } from "./github-setup.ts";
import { daemonHello } from "./hello.ts";
import { MissionControls } from "./mission-controls.ts";
import { MissionReports } from "./mission-reports.ts";
import type { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { SourceRegistry } from "./sources.ts";
import { TerminalManager } from "./terminals.ts";
import { TrackedItemStore } from "./tracked-items.ts";

export async function nativeIntakeFixture(options: { tracking?: boolean; nativeAuth?: boolean } = {}) {
	const home = await mkdtemp(join(tmpdir(), "native-intake-http-"));
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({
		path: home,
		workspace: "direct",
		tracking: { linearTeam: "FAKE", slackChannels: [] },
	});
	await mkdir(join(home, "other"));
	const other = await projects.create({
		path: join(home, "other"),
		tracking: { linearTeam: "OTHER", slackChannels: [] },
	});
	const hello = await daemonHello(home, {
		independentExecution: true,
		powerManagement: false,
		systemSleepEvents: false,
		swiftUIArtifacts: true,
		coordinatorIsolation: true,
	});
	const host = { hostId: "daemon", daemonId: hello.daemonId, lineageId: hello.lineageId! };
	const native = new GitHubSetupService(home, { ...host, hostId: "local" }, { userHome: home, env: {} });
	await native.status();
	const capability = JSON.parse(await readFile(join(home, "github-app-capability"), "utf8")).token;
	const items = new TrackedItemStore(join(home, "items.sqlite"));
	await items.load([project.id, other.id]);
	const input = (externalId: string) => ({
		externalId,
		title: `Request ${externalId}`,
		url: "https://example.invalid/request",
		status: "Todo",
		metadata: {},
		updatedAt: 10,
	});
	await items.commit(project.id, "linear", [input("one"), input("two")]);
	await items.commit(other.id, "linear", [input("foreign")]);
	let external = 0;
	const tracking = new SourceRegistry(projects, items, {
		async call() {
			external++;
			throw new Error("No external writes or reads");
		},
	});
	const sessions = new SessionManager(home, projects);
	// Use real durable session metadata/admission but do not open a provider or worker.
	Object.defineProperty(sessions, "start", { value: async () => new Map() });
	sessions.selectTaskModel = async () => ({ model: "fake/model", thinking: "high" });
	const terminals = new TerminalManager();
	const store = new MissionStore(join(home, "missions.sqlite"));
	const args: Parameters<typeof createDaemonServer> = [
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog(home),
		terminals,
	];
	args[5] = {
		store,
		service: {
			reports: new MissionReports(store),
			controls: new MissionControls(store, {
				checkpointMission: async () => {
					throw new Error("No mission work");
				},
				resumeMission: async () => {
					throw new Error("No mission work");
				},
			}),
		} as MissionService,
	};
	args[9] = options.tracking === false ? undefined : tracking;
	args[12] = hello;
	args[17] = options.nativeAuth === false ? undefined : native;
	const server = createDaemonServer(...args);
	await server.runtimeReady;
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		server,
		home,
		project,
		other,
		projects,
		items,
		sessions,
		tracking,
		store,
		hello,
		host,
		root,
		capability,
		stats: () => ({ external, sessions: sessions.list().length }),
		async close() {
			server.closeAllConnections();
			await new Promise<void>((r) => server.close(() => r()));
			await server.closePlanning();
			await tracking.stop();
			await sessions.shutdown();
			terminals.shutdown();
			await native.close();
			await items.close();
			store.close();
			await rm(home, { recursive: true, force: true });
		},
	};
}
