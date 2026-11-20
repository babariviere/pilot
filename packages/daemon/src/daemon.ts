/** pilotd: background pi agents on durable sessions. */

import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { credentialEnvironment } from "@pilot/kernel/credential-client";
import { installCredentialBrokerHooks } from "@pilot/kernel/credential-hooks";
import { configureNodeTelemetry, nodeTelemetry } from "@pilot/telemetry";
import { BackgroundJobDiagnostics } from "./runtime/diagnostics/background-job-diagnostics.ts";
import { BackgroundSubscription } from "./models/background/background-subscription.ts";
import { BackgroundUsage } from "./models/background/background-usage.ts";
import { ChatSettingsService } from "./day/chat/chat-settings.ts";
import { loadConfig } from "./config.ts";
import { ConnectivityService } from "./setup/connectivity.ts";
import { CredentialBroker } from "./setup/credential-broker.ts";
import { createDaemonServices } from "./daemon-services.ts";
import { EnvironmentService } from "./environment/environment.ts";
import { EnvironmentStateStore } from "./environment/environment-state.ts";
import { EventLoopWatchdog } from "./runtime/process/event-loop-watchdog.ts";
import { Funding } from "./models/funding/funding.ts";
import { fundingBackground } from "./models/funding/funding-background.ts";
import { fundingRequests } from "./models/funding/funding-requests.ts";
import { GitHubImportService } from "./sources/github/github-import.ts";
import { GitHubSetupService } from "./sources/github/github-setup.ts";
import { daemonHello } from "./transport/hello.ts";
import { linearPublishContext } from "./sources/linear/linear-publish-context.ts";
import { createLinearSizePoller } from "./sources/linear/sizing/linear-size.ts";
import { LiveUpdateService } from "./runtime/updates/live-update.ts";
import { daemonLogTail } from "./runtime/diagnostics/logging.ts";
import { McpStatusService, workerProbe } from "./setup/mcp/mcp-status.ts";
import { MissionLinearPrChecks } from "./missions/linear/mission-linear-prs.ts";
import { MissionLinearPublisher } from "./missions/linear/mission-linear-publisher.ts";
import { MissionLinearSource } from "./missions/linear/mission-linear-source.ts";
import { MissionLinearSyncService } from "./missions/linear/mission-linear-sync.ts";
import { MissionService } from "./missions/mission-service.ts";
import { MissionStore } from "./missions/missions.ts";
import { ModelCatalog } from "./models/models.ts";
import { PilotServiceJournal } from "./runtime/lifecycle/pilot-service-journal.ts";
import { detectPlatformCapabilities } from "./runtime/platform/platform.ts";
import { PowerService } from "./runtime/power/power.ts";
import { KnowledgeService } from "./projects/knowledge/project-knowledge.ts";
import { ProjectMemoryService } from "./projects/memory/project-memory.ts";
import { ProjectStore } from "./projects/projects.ts";
import { RuntimeBackground } from "./runtime/lifecycle/runtime-background.ts";
import { runtimeOwner } from "./runtime-bootstrap.ts";
import { ScheduleDetection } from "./schedules/schedule-detection.ts";
import { shutdownSchedules } from "./schedules/schedule-shutdown.ts";
import { ScheduleStore } from "./schedules/schedule-store.ts";
import { ScheduleService } from "./schedules/schedules.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions/sessions.ts";
import { SetupService } from "./setup/setup.ts";
import { slackClassifier } from "./sources/slack/slack-classifier.ts";
import { createSlackAdder, createSlackPoller } from "./sources/slack/slack-source.ts";
import { createSlackWaitingWatcher } from "./sources/slack/slack-waiting.ts";
import { PiSourceMcpClient } from "./sources/auth/source-mcp.ts";
import { SourceRegistry } from "./sources/sources.ts";
import { SubscriptionRefresh } from "./models/usage/subscription-refresh.ts";
import { SystemEventsDetection } from "./runtime/power/system-events-detection.ts";
import { TelemetrySettingsService } from "./runtime/telemetry/telemetry-settings.ts";
import { TerminalManager } from "./sessions/terminals/terminals.ts";
import { TrackedItemStore } from "./sources/tracking/tracked-items.ts";
import { TriageGroomer, workerTriage } from "./sources/triage/triage-grooming.ts";
import { untrackedStats } from "./workspaces/untracked-stats.ts";
import { UsageHistoryStore } from "./models/usage/usage-history.ts";

const config = loadConfig();
await mkdir(config.agentDir ?? getAgentDir(), { recursive: true, mode: 0o700 });
const credentials = new CredentialBroker(await realpath(config.agentDir ?? getAgentDir()));
await credentials.start();
Object.assign(process.env, credentialEnvironment(credentials.grant(true)));
await installCredentialBrokerHooks();
const capabilities = await detectPlatformCapabilities();
const hello = await daemonHello(config.home, capabilities);
if (!hello.lineageId) throw new Error("Storage lineage is required");
const telemetry = await TelemetrySettingsService.open(config.home, hello);
const chatSettings = await ChatSettingsService.open(config.home);
configureNodeTelemetry(telemetry.nodeOptions("pilot.daemon"));
// Log long timer delays with context, without assuming sleep or descheduling is synchronous CPU work.
const watchdog = new EventLoopWatchdog({ histogram: true });
watchdog.start();
const projects = new ProjectStore(config.home);
await projects.load();
const trackedItems = new TrackedItemStore(join(config.home, "tracked-items.sqlite"));
await trackedItems.load(projects.list().map((project) => project.id));
const sourceMcp = new PiSourceMcpClient(config.agentDir);
const jobDiagnostics = new BackgroundJobDiagnostics();

const usageHistory = new UsageHistoryStore(config.home);
const funding = new Funding(join(config.home, "funding.sqlite"));
const backgroundUsage = new BackgroundUsage(config.home, usageHistory);
const triage = new TriageGroomer(
	projects,
	trackedItems,
	workerTriage(config.agentDir, backgroundUsage),
	Date.now,
	jobDiagnostics,
	true,
);
// Shared MCP status for Settings and Needs you. Checks once now, then only when pi's MCP files change.
const mcpStatus = new McpStatusService({
	probe: workerProbe(config.agentDir),
	login: (server, options) => sourceMcp.signInServer(server, options),
	watchDir: config.agentDir ?? getAgentDir(),
});
const models = new ModelCatalog(config.agentDir);
models.setBackgroundUsage(backgroundUsage);
const slack = slackClassifier(models);
const memory = new ProjectMemoryService(
	config.home,
	undefined, // Historical notes stay readable. New shared understanding belongs in Knowledge.
	30_000,
	{ hostId: "daemon", daemonId: hello.daemonId, lineageId: hello.lineageId },
);
let stopMemoryProjects = () => {};
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
		automationsEnabled: () => chatSettings.automationsEnabled(),
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
						dayAppRoot: join(homedir(), "Library", "Logs", "Pilot"),
						nextAppRoot: join(homedir(), "Library", "Application Support", "Pilot Next", "diagnostics"),
						nextAppControl: () => {
							const settings = telemetry.settings();
							return settings.nextDiagnostics
								? { localDiagnostics: settings.localDiagnostics, epoch: settings.nextDiagnostics.epoch }
								: undefined;
						},
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
sessions.funding = funding;
const backgroundSubscription = new BackgroundSubscription(config.home, () => sessions.subscriptionUsageSnapshot());
backgroundUsage.funding = fundingBackground(
	funding,
	credentials.catalog,
	(p) => backgroundSubscription.assert(p),
	(limit) => backgroundSubscription.limit(limit),
);
const sessionFunding = fundingRequests(funding, credentials.catalog, (id) => sessions.fundingRequestOwner(id));
credentials.fundingRequest = async (binding, request) => {
	if (typeof binding === "string")
		return sessions.dayInsights?.owns(binding)
			? sessions.dayInsights.fundingRequest(binding, request, credentials.catalog)
			: sessionFunding(binding, request);
	const p = request.value as { provider?: string } | undefined;
	if (request.op === "funding-reserve" && p?.provider) await backgroundSubscription.assert(p.provider);
	const value = await fundingRequests(funding, credentials.catalog, () => binding, "triage")("background", request);
	if (request.op === "funding-reserve" && p?.provider) await backgroundSubscription.assert(p.provider);
	return value;
};
backgroundUsage.credentialScope = (attribution) => {
	const owner = attribution?.mission
		? { kind: "mission" as const, id: attribution.mission.missionId, projectId: attribution.projectId }
		: { kind: "background" as const, id: "daily", projectId: attribution?.projectId };
	const endpoint = credentials.grant(false, undefined, owner);
	return { endpoint, release: () => credentials.revoke(endpoint) };
};
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
sessions.setProjectMemory(memory);
sessions.setMcpStatus(mcpStatus);
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
sessions.setTrackedSources((projectId) => trackedItems.sessionSources(projectId));
// Linking a chat to a Slack message (or unlinking it) declares or withdraws its slack_status tool, and changes the
// source the chat shows.
trackedItems.onChange((projectId) => {
	sessions.refreshSlackLinks(projectId);
	sessions.refreshTrackedSources(projectId);
});
// Membership is read while sessions load (auto-archiving, worker specs), so the bridge comes first.
const missionStore = new MissionStore(join(config.home, "missions.sqlite"));
const linearPublisher = new MissionLinearPublisher(
	missionStore.linearPublisher,
	(projectId, missionId) => linearPublishContext(missionStore, projects, projectId, missionId),
	sourceMcp,
);
const missionLinear = new MissionLinearSource(missionStore, sourceMcp);
const linearSync = new MissionLinearSyncService(
	missionStore,
	projects,
	sourceMcp,
	jobDiagnostics,
	(id, operationId) => sessions.linearLinkedBuild(id, operationId),
	(id) => sessions.linearReservationAbsent(id),
);
sessions.onChange((session) => {
	if (session.archivedAt !== undefined || session.continuedTo) missionStore.retireLinearChatManagement(session.id);
});

const missionService = new MissionService(missionStore, sessions, projects, undefined, undefined, {
	hostId: "daemon",
	daemonId: hello.daemonId,
	lineageId: hello.lineageId,
});
const knowledge = new KnowledgeService(missionStore, projects, sessions);
sessions.setKnowledge(knowledge);
missionService.setLinearClosingGuard((missionId, resourceId) => linearSync.closingEligibility(missionId, resourceId));
missionService.setLinearReader(sourceMcp);
const linearPrChecks = new MissionLinearPrChecks(
	missionStore,
	(id, taskId) => missionService.prGuidance(id, taskId),
	(projectId) => projects.get(projectId)?.path,
);
const power = capabilities.powerManagement ? new PowerService(config.home, sessions) : undefined;
const systemEventsDetection = capabilities.systemSleepEvents ? new SystemEventsDetection() : undefined;
const scheduleDetection = new ScheduleDetection({ power: systemEventsDetection });
const connectivity = new ConnectivityService(join(config.home, "connectivity.json"), scheduleDetection, (online) =>
	sessions.setConnectivity(online),
);
const tracking = new SourceRegistry(projects, trackedItems, sourceMcp, {
	deferStart: true,
	jobDiagnostics,
	triage,
	pollers: {
		linear: createLinearSizePoller(trackedItems, workerTriage(config.agentDir, backgroundUsage)),
		slack: createSlackPoller(trackedItems, slack),
	},
	slack: {
		adder: createSlackAdder(trackedItems, slack),
		// A reply in a waiting Slack thread resumes the message's latest chat with it.
		waiting: createSlackWaitingWatcher(trackedItems, (sessionId, message, requestId, guard) =>
			sessions.resumeSlackReply(sessionId, message, requestId, guard),
		),
	},
	linear: { managedMissions: (projectId, issueIds) => missionStore.managedLinearMissions(projectId, issueIds) },
});
tracking.setDiagnosticsEnabled(telemetry.settings().localDiagnostics);
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
	automationsEnabled: () => chatSettings.automationsEnabled(),
	home: { daemonId: hello.daemonId, lineageId: hello.lineageId! },
	paused: () => !!sessions.powerPause,
	subscribeAdmission: (listener) => {
		const stopSettings = chatSettings.onChange(listener);
		const stopPower = power?.onChange(listener);
		return () => {
			stopSettings();
			stopPower?.();
		};
	},
});
sessions.setScheduledMessages(schedules);
missionService.controls.setScheduleDrain((missionId) => schedules.drainMission(missionId));

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
let backgroundStarted = false;
let backgroundInitialized = false;
let memoryObserverStarted = false;
let stopping = false;
const knownMemoryProjects = new Set<string>();
let memorySync: Promise<void> | undefined;
let memorySyncDirty = false;
const startupWork = new RuntimeBackground("daemon-recovery", () => {
	if (!backgroundStarted || stopping) return;
	void syncMemoryProjects().catch((error) => console.warn(`pilotd: memory recovery: ${error}`));
});
function syncMemoryProjects(): Promise<void> {
	if (stopping || !backgroundStarted || startupWork.frozen) return Promise.resolve();
	if (memorySync) {
		memorySyncDirty = true;
		return memorySync;
	}
	memorySync = startupWork
		.run("memory-projects", async () => {
			do {
				memorySyncDirty = false;
				const current = new Set(projects.list().map((project) => project.id));
				for (const id of knownMemoryProjects)
					if (!current.has(id)) {
						await memory.unload(id);
						knownMemoryProjects.delete(id);
					}
				for (const project of projects.list()) {
					if (knownMemoryProjects.has(project.id)) continue;
					try {
						await memory.load(project.id);
						knownMemoryProjects.add(project.id);
					} catch (error) {
						console.warn(`pilotd: memory ${project.id}: ${error}`);
					}
				}
			} while (memorySyncDirty && !startupWork.frozen && !stopping);
		})
		.finally(() => {
			memorySync = undefined;
		});
	return memorySync;
}
async function resumeRuntime(): Promise<void> {
	if (stopping || server.runtimeFrozen()) return;
	await sessions.resumeMaintenance();
	if (!backgroundInitialized) {
		backgroundStarted = true;
		mcpStatus.start();
		triage.start();
		tracking.startPolling("linear");
		tracking.startPolling("slack");
		missionLinear.start();
		linearSync.start();
		knowledge.maintenance.start();
		linearPrChecks.start();
		await startupWork.run("usage-recovery", () => backgroundUsage.ready());
		await tracking.retainDiagnosticEvidence(join(config.home, "diagnostics", "refresh"), {
			hostId: "daemon",
			daemonId: hello.daemonId,
			lineageId: hello.lineageId!,
		});
		await syncMemoryProjects();
		if (!memoryObserverStarted) {
			stopMemoryProjects = projects.onChange(() => {
				void syncMemoryProjects().catch((error) => console.warn(`pilotd: memory projects: ${error}`));
			});
			memoryObserverStarted = true;
		}

		await missionService.readProjectRepositories();
		missionService.notices.start();
		missionService.continuations.start();
		schedules.start();
		backgroundInitialized = true;
	}
	daemonServices.recoverOperations();
}
const identity = runtimeOwner?.identity();
const liveUpdate = new LiveUpdateService(config.home, projects, () => sessions.freezeAdmissions(), resumeRuntime, {
	runtime:
		identity?.build && identity.runtimeRoot
			? {
					boot: identity.boot,
					source: identity.build.source,
					build: identity.build,
					runtimeRoot: identity.runtimeRoot,
				}
			: undefined,
	pauseForUpdate: () => sessions.pauseForUpdate(),
});
sessions.setLiveUpdate(liveUpdate);
const subscriptions = new SubscriptionRefresh((provider) => models.refreshSubscription(provider));
const daemonServices = createDaemonServices({
	config,
	sessions,
	projects,
	models,
	terminals,
	missions: {
		service: missionService,
		store: missionStore,
		knowledge,
	},
	memory,
	schedules,
	tracking,
	power,
	mcp: mcpStatus,
	hello,
	setup,
	telemetry,
	githubSetup,
	nativeAuthority: githubSetup.nativeAuthority,
	linearPublisher,
	backgroundSubscription,
	githubImport,
	environment,
	bootstrap: runtimeOwner,
	subscriptions,
	chatSettings,
	liveUpdate: {
		service: liveUpdate,
		contributors: [
			startupWork,
			models.maintenance,
			memory.runtime,
			sourceMcp.runtime,
			tracking.runtime,
			triage.runtime,
			subscriptions.runtime,
			schedules.runtime,
			missionService.notices.runtime,
			missionService.continuations.runtime,
			knowledge.maintenance.runtime,
			mcpStatus.runtime,
			missionLinear.runtime,
			linearSync.runtime,
			linearPrChecks.runtime,
		],
	},
});
const server = createDaemonServer(daemonServices);
await server.runtimeReady;
// Persist unknown (admitting) before interrupted work can reopen, even with no app or pending schedule.
await connectivity.start();
// macOS path loss pauses agents at once, and a returning path resumes them without waiting for a check.
power?.onNetworkPath((path) => connectivity.setPath(path));
// Recover global sleep overrides before any interrupted agent can reopen.
await power?.start();
await schedules.load();
await sessions.load(server.runtimeFrozen());
for (const project of projects.list()) sessions.refreshTrackedSources(project.id);
// Chats started from Slack or Linear before job chats existed get the chat_report tool too.
void trackedItems
	.startedChats()
	.then((chats) => sessions.markJobChats(chats))
	.catch((error: unknown) => console.warn(`pilotd: could not mark job chats: ${error}`));
power?.refresh();
if (!server.runtimeFrozen()) await resumeRuntime();
if (runtimeOwner) {
	runtimeOwner.ready(hello);
	console.log(`pilotd listening on http://${config.host}:${config.port} (data: ${config.home})`);
} else throw new Error("Daemon profile owner is required");

async function stop(): Promise<void> {
	if (stopping) return;
	stopping = true;
	console.log("pilotd: pausing sessions");
	// A worker that is starting while this daemon goes away must not leave its chat broken.
	sessions.beginClosing();
	server.runtimeResources.freezeAdmissions();
	await liveUpdate.close();
	watchdog.stop();
	server.close();
	await shutdownSchedules(
		{ schedules, connectivity, systemEvents: systemEventsDetection, store: scheduleStore },
		async () => {
			stopMemoryProjects();
			await mcpStatus.close();
			await missionLinear.stop();
			await knowledge.maintenance.stop();
			await linearPrChecks.stop();
			await linearSync.stop();
			await tracking.stop();
			await triage.stop();
			await tracking
				.closeDiagnosticEvidence()
				.catch(() => console.warn("pilotd: retained refresh evidence could not be drained"));
			await memory.stop();
			await missionService.notices.stop();
			await missionService.continuations.stop();
			await githubImport.close();
			await Promise.all([
				daemonServices.close(),
				setup.close(),
				githubSetup.close(),
				terminals.shutdown(),
				sessions.shutdown(),
			]);
			missionService.dispose();
			await telemetry.featureUsage.close();
			await credentials.close();
			await funding.close();
			await backgroundSubscription.close();
			await trackedItems.close();
			await power?.stop();
			await untrackedStats.close();
			await environment?.close();
			await nodeTelemetry().shutdown();
			missionStore.close();
		},
	);
	process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
