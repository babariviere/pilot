/** pilotd: background pi agents on durable sessions. */

import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { credentialEnvironment } from "@pilot/kernel/credential-client";
import { installCredentialBrokerHooks } from "@pilot/kernel/credential-hooks";
import { configureNodeTelemetry, nodeTelemetry } from "@pilot/telemetry";
import { BackgroundUsage } from "./background-usage.ts";
import { loadConfig } from "./config.ts";
import { migratePilotConfig } from "./config-migration.ts";
import { ConnectivityService } from "./connectivity.ts";
import { CredentialBroker } from "./credential-broker.ts";
import { EnvironmentService } from "./environment.ts";
import { EnvironmentStateStore } from "./environment-state.ts";
import { Conflict, NotFound } from "./errors.ts";
import { EventLoopWatchdog } from "./event-loop-watchdog.ts";
import { GitHubImportService } from "./github-import.ts";
import { GitHubSetupService } from "./github-setup.ts";
import { daemonHello } from "./hello.ts";
import { legacyRuntimeUpdateFrozen } from "./legacy-runtime-update.ts";
import { createLinearSizePoller } from "./linear-size.ts";
import { MissionLinearSource } from "./linear-source.ts";
import { daemonLogTail } from "./logging.ts";
import { McpStatusService, workerProbe } from "./mcp-status.ts";
import { MissionLinearPrChecks } from "./mission-linear-prs.ts";
import { MissionLinearSyncService } from "./mission-linear-sync.ts";
import { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import { ModelCatalog } from "./models.ts";
import { PilotServiceJournal } from "./pilot-service-journal.ts";
import { detectPlatformCapabilities } from "./platform.ts";
import { PowerService } from "./power.ts";
import { ProjectMemoryService } from "./project-memory.ts";
import { ProjectStore } from "./projects.ts";
import { RetiredDevboxes } from "./retired-devboxes.ts";
import { runtimeOwner } from "./runtime-bootstrap.ts";
import { ScheduleDetection } from "./schedule-detection.ts";
import { ScheduleStore } from "./schedule-store.ts";
import { ScheduleService } from "./schedules.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { SetupService } from "./setup.ts";
import { createSlackAdder, createSlackPoller } from "./slack-source.ts";
import { createSlackWaitingWatcher } from "./slack-waiting.ts";
import { PiSourceMcpClient } from "./source-mcp.ts";
import { SourceRegistry } from "./sources.ts";
import { SystemEventsDetection } from "./system-events-detection.ts";
import { TelemetrySettingsService } from "./telemetry-settings.ts";
import { TerminalManager } from "./terminals.ts";
import { TrackedItemStore } from "./tracked-items.ts";
import { TriageGroomer, workerTriage } from "./triage-grooming.ts";
import { untrackedStats } from "./untracked-stats.ts";
import { UsageHistoryStore } from "./usage-history.ts";

const config = loadConfig();
await migratePilotConfig(config.agentDir ?? getAgentDir());
await mkdir(config.agentDir ?? getAgentDir(), { recursive: true, mode: 0o700 });
const credentials = new CredentialBroker(await realpath(config.agentDir ?? getAgentDir()));
await credentials.start();
Object.assign(process.env, credentialEnvironment(credentials.grant(true)));
await installCredentialBrokerHooks();
const capabilities = await detectPlatformCapabilities();
const hello = await daemonHello(config.home, capabilities);
if (!hello.lineageId) throw new Error("Storage lineage is required for sharing");
const telemetry = await TelemetrySettingsService.open(config.home, hello);
configureNodeTelemetry(telemetry.nodeOptions("pilot.daemon"));
// Log long timer delays with context, without assuming sleep or descheduling is synchronous CPU work.
const watchdog = new EventLoopWatchdog({ histogram: true });
watchdog.start();
const projects = new ProjectStore(config.home);
await projects.load();
const trackedItems = new TrackedItemStore(join(config.home, "tracked-items.sqlite"));
await trackedItems.load(projects.list().map((project) => project.id));
const sourceMcp = new PiSourceMcpClient(config.agentDir);
const tracking = new SourceRegistry(projects, trackedItems, sourceMcp);
tracking.setDiagnosticsEnabled(telemetry.settings().localDiagnostics);
await tracking.retainDiagnosticEvidence(join(config.home, "diagnostics", "refresh"), {
	hostId: "daemon",
	daemonId: hello.daemonId,
	lineageId: hello.lineageId,
});
const usageHistory = new UsageHistoryStore(config.home);
const backgroundUsage = new BackgroundUsage(config.home, usageHistory);
void backgroundUsage.ready();
tracking.triage = new TriageGroomer(
	projects,
	trackedItems,
	workerTriage(config.agentDir, backgroundUsage),
	Date.now,
	tracking.jobDiagnostics,
);
// Shared MCP status for Settings and Needs you. Checks once now, then only when pi's MCP files change.
const mcpStatus = new McpStatusService({
	probe: workerProbe(config.agentDir),
	login: (server, options) => sourceMcp.signInServer(server, options),
	watchDir: config.agentDir ?? getAgentDir(),
});
mcpStatus.start();
tracking.register("linear", createLinearSizePoller(trackedItems, workerTriage(config.agentDir, backgroundUsage)));
tracking.startPolling("linear");
const models = new ModelCatalog(config.agentDir);
models.setBackgroundUsage(backgroundUsage);
tracking.register("slack", createSlackPoller(trackedItems, models));
tracking.slackAdder = createSlackAdder(trackedItems, models);
tracking.startPolling("slack");
const memory = new ProjectMemoryService(
	config.home,
	(prompt, signal, observe, projectId) => models.summarizeMemory(prompt, signal, observe, { projectId }),
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
const serviceJournal = new PilotServiceJournal({
	home: homedir(),
	dataHome: config.home,
	root: fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, ""),
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
		usageHistory,
		credentials,
		diagnosticHost: { hostId: "daemon", daemonId: hello.daemonId, lineageId: hello.lineageId },
		diagnosticLogs: {
			...(process.platform === "linux"
				? { serviceJournal: (signal?: AbortSignal) => serviceJournal.read(signal) }
				: {}),
			...(process.platform === "darwin"
				? {
						daemonLog: join(homedir(), "Library", "Logs", "Pilot", "pilotd.log"),
						appLog: join(homedir(), "Library", "Logs", "Pilot", "App", "app.jsonl"),
						diagnosticReports: join(homedir(), "Library", "Logs", "DiagnosticReports"),
					}
				: {}),
			daemonTail: daemonLogTail,
			platform: process.platform,
		},
		telemetry: telemetry.kernelSettings(),
	},
);
let appliedTelemetry = telemetry.settings();
sessions.configureTelemetry(telemetry.kernelSettings(), appliedTelemetry.aiUsageBudget);
telemetry.onChange((settings) => {
	const exportChanged =
		settings.remoteOperational !== appliedTelemetry.remoteOperational ||
		settings.endpoint !== appliedTelemetry.endpoint;
	appliedTelemetry = settings;
	if (exportChanged) configureNodeTelemetry(telemetry.nodeOptions("pilot.daemon"));
	sessions.configureTelemetry(telemetry.kernelSettings(), settings.aiUsageBudget);
	tracking.setDiagnosticsEnabled(settings.localDiagnostics);
});
const legacyUpdateFrozen = process.platform === "linux" && (await legacyRuntimeUpdateFrozen(config.home));
sessions.setProjectMemory(memory);
sessions.setMcpStatus(mcpStatus);
sessions.setPullRequestObserver((observation) => trackedItems.observeSlackPullRequests(observation));
sessions.setSlackStatus({
	call: (sessionId, args) => {
		const { status, reason } = args;
		if (status !== "waiting" && status !== "in_progress" && status !== "done")
			throw new Error('status must be "waiting", "in_progress" or "done"');
		if (reason !== undefined && typeof reason !== "string") throw new Error("reason must be a string");
		return trackedItems.agentSlackStatus(sessionId, status, reason);
	},
	linked: (projectId, sessionIds) => trackedItems.slackLinkedSessions(projectId, sessionIds),
});
sessions.setTrackedSources((projectId) => trackedItems.sessionSources(projectId));
// Linking a chat to a Slack message (or unlinking it) declares or withdraws its slack_status tool, and changes the
// source the chat shows.
trackedItems.onChange((projectId) => {
	sessions.refreshSlackLinks(projectId);
	sessions.refreshTrackedSources(projectId);
});
// Membership is read while sessions load (auto-archiving, worker specs), so the bridge comes first.
const missionStore = new MissionStore(join(config.home, "missions.sqlite"));
const missionLinear = new MissionLinearSource(missionStore, sourceMcp);
missionLinear.start();
const linearSync = new MissionLinearSyncService(missionStore, projects, sourceMcp, tracking.jobDiagnostics);
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
// Keep legacy grants occupied and delegated sessions fenced, without loading any live
// sharing service, observers, replica recovery or courier endpoints.
const sharing = new RetiredDevboxes(
	{ hostId: "daemon", daemonId: hello.daemonId, lineageId: hello.lineageId },
	missionStore,
);
sessions.setSharedContext(sharing);
missionService.setSharedContext(sharing);
missionService.setLinearClosingGuard((missionId, resourceId) => linearSync.closingEligibility(missionId, resourceId));
missionService.setLinearReader(sourceMcp);
const linearPrChecks = new MissionLinearPrChecks(
	missionStore,
	(id, taskId) => missionService.prGuidance(id, taskId),
	(projectId) => projects.get(projectId)?.path,
);
linearPrChecks.start();
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
await sessions.load(legacyUpdateFrozen);
for (const project of projects.list()) sessions.refreshTrackedSources(project.id);
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
power?.refresh();
if (!legacyUpdateFrozen) {
	missionService.notices.start();
	missionService.compaction.start();
}
const terminals = new TerminalManager();
const setup = new SetupService(credentials, { mcp: () => mcpStatus.status() });
const githubSetup = new GitHubSetupService(config.home, {
	hostId: "daemon",
	daemonId: hello.daemonId,
	lineageId: hello.lineageId,
});
await githubSetup.status().catch(() => {
	console.warn("pilotd: GitHub setup unavailable; private storage needs attention");
});
const githubImport = new GitHubImportService(githubSetup, projects);
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
if (!legacyUpdateFrozen) schedules.start();

// Environment setup stays off until its user-facing parts ship (hello.capabilities.environmentSetup).
const environment = hello.capabilities.environmentSetup
	? await (async () => {
			const state = new EnvironmentStateStore(config.home);
			await state.load();
			await state.retain(projects.list().map((project) => project.id));
			projects.onChange((list) => void state.retain(list.map((project) => project.id)).catch(() => undefined));
			return new EnvironmentService(projects, {
				home: config.home,
				host: { daemonId: hello.daemonId, lineageId: hello.lineageId, platform: hello.platform, arch: hello.arch },
				state,
			});
		})()
	: undefined;
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
	legacyUpdateFrozen,
	undefined,
	telemetry,
	githubSetup,
	githubImport,
	undefined,
	environment,
	runtimeOwner,
);
if (runtimeOwner) {
	runtimeOwner.ready(hello);
	console.log(`pilotd listening on http://${config.host}:${config.port} (data: ${config.home})`);
} else throw new Error("Daemon profile owner is required");

let stopping = false;
async function stop(): Promise<void> {
	if (stopping) return;
	stopping = true;
	console.log("pilotd: pausing sessions");
	watchdog.stop();
	server.close();
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
	await tracking
		.closeDiagnosticEvidence()
		.catch(() => console.warn("pilotd: retained refresh evidence could not be drained"));
	await memory.stop();
	await missionService.notices.stop();
	await missionService.compaction.stop();
	await githubImport.close();
	await Promise.all([setup.close(), githubSetup.close(), terminals.shutdown(), sessions.shutdown()]);
	await telemetry.featureUsage.close();
	await credentials.close();
	stopSlackCompletions();
	await Promise.all(completionWrites);
	await trackedItems.close();
	await power?.stop();
	await untrackedStats.close();
	await environment?.close();
	await nodeTelemetry().shutdown();
	missionStore.close();
	process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
