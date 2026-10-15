/** pilotd: background pi agents on durable sessions. */
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { EventLoopWatchdog } from "./event-loop-watchdog.ts";
import { MissionLinearSource, pollLinear } from "./linear-source.ts";
import { McpStatusService, workerProbe } from "./mcp-status.ts";
import { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import { ModelCatalog } from "./models.ts";
import { PowerService } from "./power.ts";
import { ProjectMemoryService } from "./project-memory.ts";
import { ProjectStore } from "./projects.ts";
import { ScheduleDetection } from "./schedule-detection.ts";
import { ScheduleStore } from "./schedule-store.ts";
import { ScheduleService } from "./schedules.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { createSlackPoller } from "./slack-source.ts";
import { PiSourceMcpClient } from "./source-mcp.ts";
import { SourceRegistry } from "./sources.ts";
import { SystemEventsDetection } from "./system-events-detection.ts";
import { TerminalManager } from "./terminals.ts";
import { TrackedItemStore } from "./tracked-items.ts";
import { untrackedStats } from "./untracked-stats.ts";

const config = loadConfig();
// Log long timer delays with context, without assuming sleep or descheduling is synchronous CPU work.
const watchdog = new EventLoopWatchdog({ histogram: true });
watchdog.start();
const projects = new ProjectStore(config.home);
await projects.load();
const trackedItems = new TrackedItemStore(join(config.home, "tracked-items.sqlite"));
await trackedItems.load(projects.list().map((project) => project.id));
const sourceMcp = new PiSourceMcpClient(config.agentDir);
const tracking = new SourceRegistry(projects, trackedItems, sourceMcp);
// Shared MCP status for Settings and Needs you. Checks once now, then only when pi's MCP files change.
const mcpStatus = new McpStatusService({
	probe: workerProbe(config.agentDir),
	login: (server, options) => sourceMcp.signInServer(server, options),
	watchDir: config.agentDir ?? getAgentDir(),
});
mcpStatus.start();
tracking.register("linear", pollLinear);
tracking.startPolling("linear");
const models = new ModelCatalog(config.agentDir);
tracking.register("slack", createSlackPoller(trackedItems, models));
tracking.startPolling("slack");
const memory = new ProjectMemoryService(config.home, (prompt, signal, observe) =>
	models.summarizeMemory(prompt, signal, observe),
);
// Load metadata and resume pending compaction, but a damaged/busy memory store cannot stop pilotd.
const knownMemoryProjects = new Set<string>();
for (const project of projects.list()) {
	knownMemoryProjects.add(project.id);
	try {
		await memory.load(project.id);
	} catch (error) {
		console.warn(`pilotd: memory ${project.id}: ${error}`);
	}
}
const stopMemoryProjects = projects.onChange(() => {
	const current = new Set(projects.list().map((project) => project.id));
	for (const id of knownMemoryProjects)
		if (!current.has(id)) {
			knownMemoryProjects.delete(id);
			void memory.unload(id).catch((error) => console.warn(`pilotd: memory unload ${id}: ${error}`));
		}
	for (const project of projects.list()) {
		if (knownMemoryProjects.has(project.id)) continue;
		knownMemoryProjects.add(project.id);
		void memory.load(project.id).catch((error) => console.warn(`pilotd: memory ${project.id}: ${error}`));
	}
});
const sessions = new SessionManager(
	config.home,
	projects,
	config.agentDir,
	{},
	{},
	{
		idleParkMs: config.idleParkMs,
		workspaceRetentionMs: config.workspaceRetentionMs,
		models,
	},
);
sessions.setProjectMemory(memory);
sessions.setMcpStatus(mcpStatus);
sessions.setPullRequestObserver((observation) => trackedItems.observeSlackPullRequests(observation));
// Membership is read while sessions load (auto-archiving, worker specs), so the bridge comes first.
const missionStore = new MissionStore(join(config.home, "missions.sqlite"));
const missionLinear = new MissionLinearSource(missionStore, sourceMcp);
missionLinear.start();
const completionWrites = new Set<Promise<void>>();
const stopSlackCompletions = missionStore.onCompleted((projectId, missionId, at) => {
	const write = trackedItems
		.completeSlackMission(projectId, missionId, at)
		.catch((error: unknown) => console.warn(`pilotd: Slack completion failed: ${error}`))
		.finally(() => completionWrites.delete(write));
	completionWrites.add(write);
});
// Recover a completion committed just before a crash. Per-item events preserve later user reopens.
for (const mission of missionStore.list())
	if (mission.status === "done" && mission.completedAt !== undefined)
		await trackedItems.completeSlackMission(mission.projectId, mission.id, mission.completedAt);
const missionService = new MissionService(missionStore, sessions, projects);
const power = new PowerService(config.home, sessions);
// Recover global sleep overrides before any interrupted agent can reopen.
await power.start();
await sessions.load();
power.refresh();
missionService.notices.start();
missionService.compaction.start();
const terminals = new TerminalManager();
const scheduleStore = new ScheduleStore(join(config.home, "schedules.sqlite"));
const systemEventsDetection = new SystemEventsDetection();
const scheduleDetection = new ScheduleDetection({ power: systemEventsDetection });
const schedules = new ScheduleService(scheduleStore, {
	sessions,
	projects,
	missions: missionStore,
	trackedItems,
	triggers: scheduleDetection,
});
await schedules.load();
schedules.start();
const server = createDaemonServer(
	config,
	sessions,
	projects,
	models,
	terminals,
	{
		service: missionService,
		store: missionStore,
	},
	undefined,
	memory,
	schedules,
	tracking,
	power,
	mcpStatus,
);
server.listen(config.port, config.host, () => {
	console.log(`pilotd listening on http://${config.host}:${config.port} (data: ${config.home})`);
});

let stopping = false;
async function stop(): Promise<void> {
	if (stopping) return;
	stopping = true;
	console.log("pilotd: pausing sessions");
	watchdog.stop();
	server.close();
	await schedules.stop();
	systemEventsDetection.stop();
	await scheduleStore.close();
	stopMemoryProjects();
	await mcpStatus.close();
	await missionLinear.stop();
	await tracking.stop();
	await memory.stop();
	await missionService.notices.stop();
	await missionService.compaction.stop();
	await Promise.all([terminals.shutdown(), sessions.shutdown()]);
	stopSlackCompletions();
	await Promise.all(completionWrites);
	await trackedItems.close();
	await power.stop();
	await untrackedStats.close();
	missionStore.close();
	process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
