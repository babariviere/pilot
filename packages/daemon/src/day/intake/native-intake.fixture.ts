/** Real local HTTP/storage; synthetic sources and no model processes or external calls. */
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubImportService } from "../../sources/github/github-import.ts";
import { GitHubSetupService } from "../../sources/github/github-setup.ts";
import { daemonHello } from "../../transport/hello.ts";
import { MissionControls } from "../../missions/lifecycle/mission-controls.ts";
import { MissionReports } from "../../missions/threads/mission-reports.ts";
import type { MissionService } from "../../missions/mission-service.ts";
import { MissionStore } from "../../missions/missions.ts";
import { ModelCatalog } from "../../models/models.ts";
import { ProjectStore } from "../../projects/projects.ts";
import { ScheduleStore } from "../../schedules/schedule-store.ts";
import { ScheduleService } from "../../schedules/schedules.ts";
import { SessionManager } from "../../sessions/sessions.ts";
import type { SlackAdder } from "../../sources/slack/slack-source.ts";
import { SlackImportRefused } from "../../sources/slack/slack-tracking.ts";
import { SourceRegistry } from "../../sources/sources.ts";
import { TerminalManager } from "../../sessions/terminals/terminals.ts";
import { createDaemonFixtureServer as createDaemonServer } from "../../testing/daemon-server.ts";
import { TrackedItemStore } from "../../sources/tracking/tracked-items.ts";
import { pauseParticipants } from "../../testing/pause-participants.ts";

export async function nativeIntakeFixture(
	options: { tracking?: boolean; nativeAuth?: boolean; projectSetup?: boolean; schedules?: boolean } = {},
) {
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
		url: `https://linear.app/fixture/issue/FAKE-${externalId === "one" ? 1 : externalId === "two" ? 2 : 3}`,
		status: "Todo",
		metadata: {},
		updatedAt: 10,
	});
	await items.commit(project.id, "linear", [input("one"), input("two")]);
	await items.commit(other.id, "linear", [input("foreign")]);
	let external = 0;
	let slackAdder: SlackAdder | undefined;
	const tracking = new SourceRegistry(
		projects,
		items,
		{
			async call() {
				external++;
				throw new Error("No external writes or reads");
			},
		},
		{
			slack: {
				adder: (context, link) => {
					if (!slackAdder) throw new SlackImportRefused("Adding Slack messages is unavailable");
					return slackAdder(context, link);
				},
			},
		},
	);
	const sessions = new SessionManager(home, projects);
	// Use real durable session metadata/admission but do not open a provider or worker.
	Object.defineProperty(sessions, "start", { value: async () => new Map() });
	sessions.selectTaskModel = async () => ({ model: "fake/model", thinking: "high" });
	const terminals = new TerminalManager();
	const store = new MissionStore(join(home, "missions.sqlite"));
	const args: Parameters<typeof createDaemonServer>[0] = {
		config: { home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		models: new ModelCatalog(home),
		terminals,
	};
	args.missions = {
		store,
		service: {
			setSchedules() {},
			reports: new MissionReports(store),
			controls: new MissionControls(
				store,
				pauseParticipants({
					checkpointMission: async () => {
						throw new Error("No mission work");
					},
					resumeMission: async () => {
						throw new Error("No mission work");
					},
				}),
			),
		} as unknown as MissionService,
	};
	args.tracking = options.tracking === false ? undefined : tracking;
	args.hello = hello;
	args.githubSetup = options.nativeAuth === false ? undefined : native;
	args.nativeAuthority = args.githubSetup?.nativeAuthority;
	const scheduleStore = options.schedules ? new ScheduleStore(join(home, "schedules.sqlite")) : undefined;
	const schedules = scheduleStore
		? new ScheduleService(scheduleStore, { sessions, projects, home: host, automationsEnabled: () => false })
		: undefined;
	await schedules?.load();
	args.schedules = schedules;
	const imports = options.projectSetup ? new GitHubImportService(native, projects) : undefined;
	args.githubImport = imports;
	const server = createDaemonServer(args);
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
		schedules,
		capability,
		/** Reads a pasted Slack message in place of Slack. */
		setSlackAdder(adder: SlackAdder) {
			slackAdder = adder;
		},
		stats: () => ({ external, sessions: sessions.list().length }),
		async close() {
			await schedules?.stop();
			server.closeAllConnections();
			await new Promise<void>((r) => server.close(() => r()));
			await server.closeServices();
			await scheduleStore?.close();
			await tracking.stop();
			await sessions.shutdown();
			terminals.shutdown();
			await native.close();
			await imports?.close();
			await items.close();
			store.close();
			await rm(home, { recursive: true, force: true });
		},
	};
}
