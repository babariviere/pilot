/** pilotd: background pi agents on durable sessions. */

import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { credentialEnvironment } from "@pilot/kernel/credential-client";
import { installCredentialBrokerHooks } from "@pilot/kernel/credential-hooks";
import { loadConfig } from "./config.ts";
import { ConnectivityService } from "./connectivity.ts";
import { CredentialBroker } from "./credential-broker.ts";
import { Conflict, NotFound } from "./errors.ts";
import { EventLoopWatchdog } from "./event-loop-watchdog.ts";
import { daemonHello } from "./hello.ts";
import { createLinearSizePoller } from "./linear-size.ts";
import { MissionLinearSource } from "./linear-source.ts";
import { McpStatusService, workerProbe } from "./mcp-status.ts";
import { MissionLinearPrChecks } from "./mission-linear-prs.ts";
import { MissionLinearSyncService } from "./mission-linear-sync.ts";
import { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import { ModelCatalog } from "./models.ts";
import { detectPlatformCapabilities } from "./platform.ts";
import { PowerService } from "./power.ts";
import { ProjectMemoryService } from "./project-memory.ts";
import { ProjectStore } from "./projects.ts";
import { RuntimeMaintenance } from "./runtime-maintenance.ts";
import { ScheduleDetection } from "./schedule-detection.ts";
import { ScheduleStore } from "./schedule-store.ts";
import { ScheduleService } from "./schedules.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { SetupService } from "./setup.ts";
import { SharedContextService } from "./shared-context.ts";
import { createSlackAdder, createSlackPoller } from "./slack-source.ts";
import { createSlackWaitingWatcher } from "./slack-waiting.ts";
import { PiSourceMcpClient } from "./source-mcp.ts";
import { SourceRegistry } from "./sources.ts";
import { SystemEventsDetection } from "./system-events-detection.ts";
import { TerminalManager } from "./terminals.ts";
import { TrackedItemStore } from "./tracked-items.ts";
import { TriageGroomer, workerTriage } from "./triage-grooming.ts";
import { untrackedStats } from "./untracked-stats.ts";

const config = loadConfig();
await mkdir(config.agentDir ?? getAgentDir(), { recursive: true, mode: 0o700 });
const credentials = new CredentialBroker(await realpath(config.agentDir ?? getAgentDir()));
await credentials.start();
Object.assign(process.env, credentialEnvironment(credentials.grant(true)));
await installCredentialBrokerHooks();
const capabilities = await detectPlatformCapabilities();
const hello = await daemonHello(config.home, capabilities);
if (!hello.lineageId) throw new Error("Storage lineage is required for sharing");
// Log long timer delays with context, without assuming sleep or descheduling is synchronous CPU work.
const watchdog = new EventLoopWatchdog({ histogram: true });
watchdog.start();
const projects = new ProjectStore(config.home);
await projects.load();
const trackedItems = new TrackedItemStore(join(config.home, "tracked-items.sqlite"));
await trackedItems.load(projects.list().map((project) => project.id));
const sourceMcp = new PiSourceMcpClient(config.agentDir);
const tracking = new SourceRegistry(projects, trackedItems, sourceMcp);
tracking.triage = new TriageGroomer(projects, trackedItems, workerTriage(config.agentDir));
// Shared MCP status for Settings and Needs you. Checks once now, then only when pi's MCP files change.
const mcpStatus = new McpStatusService({
	probe: workerProbe(config.agentDir),
	login: (server, options) => sourceMcp.signInServer(server, options),
	watchDir: config.agentDir ?? getAgentDir(),
});
mcpStatus.start();
tracking.register("linear", createLinearSizePoller(trackedItems, workerTriage(config.agentDir)));
tracking.startPolling("linear");
const models = new ModelCatalog(config.agentDir);
tracking.register("slack", createSlackPoller(trackedItems, models));
tracking.slackAdder = createSlackAdder(trackedItems, models);
tracking.startPolling("slack");
const memory = new ProjectMemoryService(
	config.home,
	(prompt, signal, observe) => models.summarizeMemory(prompt, signal, observe),
	30_000,
	{ hostId: "daemon", daemonId: hello.daemonId, lineageId: hello.lineageId },
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
		credentials,
	},
);
const maintenance = process.platform === "linux" ? new RuntimeMaintenance(config.home, hello, sessions) : undefined;
await maintenance?.load();
sessions.setProjectMemory(memory);
sessions.setMcpStatus(mcpStatus);
sessions.setPullRequestObserver((observation) => trackedItems.observeSlackPullRequests(observation));
sessions.setSlackStatus({
	call: (sessionId, args) => {
		const { status, reason } = args;
		if (status !== "waiting" && status !== "in_progress")
			throw new Error('status must be "waiting" or "in_progress"');
		if (reason !== undefined && typeof reason !== "string") throw new Error("reason must be a string");
		return trackedItems.agentSlackStatus(sessionId, status, reason);
	},
	linked: (projectId, sessionIds) => trackedItems.slackLinkedSessions(projectId, sessionIds),
});
// Linking a chat to a Slack message (or unlinking it) declares or withdraws its slack_status tool.
trackedItems.onChange((projectId) => sessions.refreshSlackLinks(projectId));
// Membership is read while sessions load (auto-archiving, worker specs), so the bridge comes first.
const missionStore = new MissionStore(join(config.home, "missions.sqlite"));
const missionLinear = new MissionLinearSource(missionStore, sourceMcp);
missionLinear.start();
const linearSync = new MissionLinearSyncService(missionStore, projects, sourceMcp);
linearSync.start();
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
// Mission reads use a change-driven snapshot, never SQL from a control tool call.
const controlMissions = new Map(missionStore.list().map((mission) => [mission.id, mission]));
const stopControlMissions = missionStore.onChange((id) => {
	const mission = missionStore.get(id);
	if (mission) controlMissions.set(id, mission);
	else controlMissions.delete(id);
});
const { ControlPilot } = await import("./control-pilot.ts");
sessions.setPilot(
	new ControlPilot({
		isControl: (id) => sessions.isControlSession(id),
		sessions,
		projects: () => projects.list(),
		missions: () => [...controlMissions.values()],
		linear: (id) => trackedItems.preview(id, "linear").items,
		mutations: {
			audit: () => sessions.controlAudit(),
			startProject: async (request) => {
				const project = projects.require(request.projectId!);
				const selection = await sessions.selectTaskModel(
					project.path,
					request.model ?? project.model,
					request.thinking,
				);
				return sessions.spawn({ ...request, ...selection });
			},
			startTask: (missionId, taskId, request) => missionService.startTask(missionId, taskId, request, "coordinator"),
			send: sessions.sendReported.bind(sessions),
		},
	}),
);
missionService.setLinearClosingGuard((missionId, resourceId) => linearSync.closingEligibility(missionId, resourceId));
missionService.setLinearReader(sourceMcp);
const linearPrChecks = new MissionLinearPrChecks(
	missionStore,
	(id, taskId) => missionService.prGuidance(id, taskId),
	(projectId) => projects.get(projectId)?.path,
);
linearPrChecks.start();
const sharing = new SharedContextService(
	{ hostId: "daemon", daemonId: hello.daemonId, lineageId: hello.lineageId },
	missionStore,
	memory,
	projects,
	sessions,
	missionService,
);
sessions.setSharedContext(sharing);
missionService.setSharedContext(sharing);
const power = capabilities.powerManagement ? new PowerService(config.home, sessions) : undefined;
const systemEventsDetection = capabilities.systemSleepEvents ? new SystemEventsDetection() : undefined;
const scheduleDetection = new ScheduleDetection({ power: systemEventsDetection });
const connectivity = new ConnectivityService(join(config.home, "connectivity.json"), scheduleDetection, (online) =>
	sessions.setConnectivity(online),
);
// Persist unknown (admitting) before interrupted work can reopen, even with no app or pending schedule.
await connectivity.start();
// macOS path loss pauses agents at once, and a returning path resumes them without waiting for a check.
power?.onNetworkPath((path) => connectivity.setPath(path));
// Recover global sleep overrides before any interrupted agent can reopen.
await power?.start();
await sessions.load(maintenance?.frozen);
await sessions.ensureControlChat();
// A reply in a waiting Slack thread resumes the message's latest chat with it, once chats are loaded.
tracking.slackWaiting = createSlackWaitingWatcher(trackedItems, async (sessionId, message, requestId) => {
	const chat = sessions.get(sessionId);
	if (!chat || chat.archivedAt !== undefined || chat.state === "failed") return false;
	try {
		await sessions.send(sessionId, message, "followUp", requestId);
		return true;
	} catch (error) {
		if (error instanceof Conflict || error instanceof NotFound) return false;
		throw error;
	}
});
if (!maintenance?.frozen) await sharing.recover();
power?.refresh();
if (!maintenance?.frozen) {
	missionService.notices.start();
	missionService.compaction.start();
}
const terminals = new TerminalManager();
const setup = new SetupService(credentials, { mcp: () => mcpStatus.status() });
const scheduleStore = new ScheduleStore(join(config.home, "schedules.sqlite"));
const schedules = new ScheduleService(scheduleStore, {
	sessions,
	projects,
	missions: missionStore,
	trackedItems,
	triggers: scheduleDetection,
});
await schedules.load();
sessions.setScheduledMessages(schedules);
if (!maintenance?.frozen) schedules.start();
maintenance?.onOpen(() => {
	void sharing.recover().catch((error) => console.warn("pilotd: sharing recovery", error));
	missionService.notices.start();
	missionService.compaction.start();
	schedules.start();
});
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
	hello,
	setup,
	sharing,
	maintenance,
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
	maintenance?.close();
	server.close();
	await sharing.stop();
	await schedules.stop();
	await connectivity.stop();
	systemEventsDetection?.stop();
	await scheduleStore.close();
	stopMemoryProjects();
	await mcpStatus.close();
	await missionLinear.stop();
	await linearPrChecks.stop();
	await linearSync.stop();
	await tracking.stop();
	await tracking.triage?.stop();
	await memory.stop();
	stopControlMissions();
	await missionService.notices.stop();
	await missionService.compaction.stop();
	await Promise.all([setup.close(), terminals.shutdown(), sessions.shutdown()]);
	await credentials.close();
	stopSlackCompletions();
	await Promise.all(completionWrites);
	await trackedItems.close();
	await power?.stop();
	await untrackedStats.close();
	missionStore.close();
	process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
