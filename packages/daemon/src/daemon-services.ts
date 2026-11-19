import { join } from "node:path";
import type { AttachmentChatPayload, DaemonHello, DurableOperation, SendRequest, SpawnRequest } from "@pilot/protocol";
import type { TraceCarrier } from "@pilot/telemetry";
import { AttachmentStore } from "./attachment-store.ts";
import type { ReadOnlyAttentionExecutor } from "./attention-executor.ts";
import { RepositoryChanges } from "./changes.ts";
import type { ChatSettingsService } from "./chat-settings.ts";
import type { DaemonConfig } from "./config.ts";
import { CONNECTION_CONTROLS, ConnectionControls } from "./connection-controls.ts";
import { DayInsights } from "./day-insights.ts";
import { DayInsightsExecution } from "./day-insights-execution.ts";
import { DeliveredArtifacts } from "./delivered-artifact.ts";
import { diagnosticContextResponse } from "./diagnostic-context.ts";
import { DIAGNOSTICS_CONTROLS, DiagnosticsControls } from "./diagnostics-controls.ts";
import { Conflict, NotFound, ServiceUnavailable } from "./errors.ts";
import type { GitHubImportService } from "./github-import.ts";
import type { GitHubSetupService } from "./github-setup.ts";
import { GlobalUpdatePreparation } from "./global-update-preparation.ts";
import { HumanReviews } from "./human-reviews.ts";
import { InsightsApply } from "./insights-apply.ts";
import { InsightsEnable } from "./insights-enable.ts";
import { InsightsLegacy } from "./insights-legacy.ts";
import { admitInsightsOperation, isInsightsOperation } from "./insights-native.ts";
import { InsightsOwner, isInsightsOwnerOperation } from "./insights-owner.ts";
import { InsightsReplacement } from "./insights-replacement.ts";
import { InsightsTransition } from "./insights-transition.ts";
import { InsightsWorkspace, isInsightsWorkspaceOperation } from "./insights-workspace.ts";
import type { LiveUpdateService, LiveUpdateTarget } from "./live-update.ts";
import { MachineInformationReader } from "./machine.ts";
import { McpSetupStore } from "./mcp-setup.ts";
import type { McpStatusService } from "./mcp-status.ts";
import type { MissionCatalogSources } from "./mission-catalog.ts";
import type { MissionService } from "./mission-service.ts";
import { isThreadOperation, MissionThreads } from "./mission-threads.ts";
import type { MissionStore } from "./missions.ts";
import { MODEL_CONTROLS, ModelControls } from "./model-controls.ts";
import type { ModelCatalog } from "./models.ts";
import { NativeAttention } from "./native-attention.ts";
import { CHAT_CONTINUE, CHAT_DISMISS, CHAT_REPLY, NativeChat } from "./native-chat.ts";
import { isIntakeOperation, NativeIntake } from "./native-intake.ts";
import { isNativePlanningOperation, NativeMissionPlanning } from "./native-mission-planning.ts";
import { NativeProjects, PROJECT_ACTION } from "./native-projects.ts";
import { canonicalJSON, durableJSON, OperationJournal, OperationRejected, payloadHash } from "./operation-journal.ts";
import { PathCompletionReader } from "./path-completion.ts";
import { PlanningWorkers } from "./planning-workers.ts";
import type { PowerService } from "./power.ts";
import { type DashboardProviders, ProjectDashboardService } from "./project-dashboard.ts";
import type { KnowledgeService } from "./project-knowledge.ts";
import type { ProjectMemoryService } from "./project-memory.ts";
import type { ProjectStore } from "./projects.ts";
import { RepositoryBrowser } from "./repository-browser.ts";
import { isRetiredDevboxOperation } from "./retired-devboxes.ts";
import { optionalReviewRequests, retainedFeedbackReader } from "./review-request-access.ts";
import { ReviewStore } from "./reviews.ts";
import type { RuntimeContributor } from "./runtime-admission.ts";
import { RuntimeAdmission, RuntimeResources } from "./runtime-admission.ts";
import { SCHEDULE_CONTROLS, ScheduleControls } from "./schedule-controls.ts";
import type { ScheduleService } from "./schedules.ts";
import { ScreenBroker } from "./screen-broker.ts";
import { CommandRejected, type SessionManager } from "./sessions.ts";
import type { SetupService } from "./setup.ts";
import { SLACK_CONTROLS, SlackControls } from "./slack-controls.ts";
import type { SourceRegistry } from "./sources.ts";
import type { TelemetrySettingsService } from "./telemetry-settings.ts";
import type { TerminalManager } from "./terminals.ts";
import { type ReservationReceipt, UpdateReservation } from "./update-reservation.ts";
import { UserFeedbackService } from "./user-feedback.ts";
import { FEEDBACK_WORK, UserFeedbackWorkService } from "./user-feedback-work.ts";
import { UserVerifications } from "./user-verification.ts";
import { isWorkflowOperation, WorkflowConfirmations } from "./workflow-confirmations.ts";

/** Native host capability authenticates locally verified updater checkpoints, not agent assertions.
 * The capability holder must validate the signed staged candidate and measured source/GUI build,
 * retain its exact immutable runtime target, and observe the old GUI exit plus the replacement
 * executable/receipt before reporting gui-ready. The daemon validates the durable transaction and
 * process-captured daemon identity. It does not claim to verify native signatures from JSON.
 * Never pass this capability to workers or expose these transitions through session IPC.
 */
export interface RuntimeUpdateIntegration {
	service: LiveUpdateService;
	contributors?: readonly RuntimeContributor[];
}

export interface DaemonServiceDependencies {
	config: DaemonConfig;
	sessions: SessionManager;
	projects: ProjectStore;
	models: ModelCatalog;
	terminals: TerminalManager;
	missions?: { service: MissionService; store: MissionStore; knowledge?: KnowledgeService };
	dashboardProviders?: DashboardProviders;
	memory?: ProjectMemoryService;
	schedules?: ScheduleService;
	tracking?: SourceRegistry;
	power?: PowerService;
	mcp?: McpStatusService;
	hello?: DaemonHello;
	setup?: SetupService;
	legacyAdmissionFrozen?: boolean;
	telemetry?: TelemetrySettingsService;
	githubSetup?: GitHubSetupService;
	githubImport?: GitHubImportService;
	catalog?: MissionCatalogSources;
	environment?: import("./environment.ts").EnvironmentService;
	bootstrap?: import("./runtime-owner.ts").RuntimeOwner;
	subscriptions?: import("./subscription-refresh.ts").SubscriptionRefresh;
	chatSettings?: ChatSettingsService;
	liveUpdate?: RuntimeUpdateIntegration;
	attentionExecutor?: ReadOnlyAttentionExecutor;
	nativeAuthority?: Pick<import("./native-app-capability.ts").NativeAppCapability, "authenticate">;
	linearPublisher?: import("./mission-linear-publisher.ts").MissionLinearPublisher;
}

/** Explicit boot composition. Installs execution bridges before session restoration and HTTP admission. */
export function createDaemonServices(options: DaemonServiceDependencies) {
	const {
		config: _config,
		sessions,
		projects,
		models,
		terminals,
		missions,
		dashboardProviders,
		memory,
		schedules,
		tracking,
		mcp,
		hello,
		setup,
		legacyAdmissionFrozen = false,
		telemetry,
		githubSetup,
		githubImport,
		bootstrap,
		liveUpdate,
		attentionExecutor,
	} = options;
	sessions.setWorkspaceProcessGuard((id) => terminals.isRunning(id));
	sessions.diagnosticFeatureUsage = telemetry ? (host) => telemetry.featureUsage.snapshot(host) : undefined;
	sessions.diagnosticDomainRead = async (request) => {
		const host = request.host!;
		const limit = request.limit ?? 8,
			offset = request.before ?? 0;
		const response = (data: unknown, count: number, more: boolean) =>
			diagnosticContextResponse(host, data, { scanned: count, more, ...(more ? { before: offset + count } : {}) });
		if (request.action === "refresh_health" && tracking) {
			const snapshot = tracking.refreshHealth({
				projectId: request.projectId,
				kind: request.query as "slack" | "linear" | undefined,
				offset,
				limit,
				channelOffset: request.channelOffset,
			});
			return response(snapshot, snapshot.scanned, snapshot.more);
		}
		if (request.action === "features" && telemetry) {
			const snapshot = telemetry.featureUsage.snapshot(host);
			const cells = snapshot.cells.filter(
				(cell) =>
					(!request.query || cell.feature === request.query) &&
					(!request.since || cell.day >= request.since) &&
					(!request.until || cell.day <= request.until),
			);
			const rows = cells.slice(offset, offset + limit);
			return response(
				{
					...snapshot,
					cells: rows,
					requestedWindow: { since: request.since, until: request.until },
					coverage: "partial_native_ui_observations_only_missing_cells_are_unknown_not_zero",
				},
				rows.length,
				offset + rows.length < cells.length,
			);
		}
		if (request.action === "projects") {
			const list = projects.list();
			const rows = list.slice(offset, offset + limit).map((p) => ({ id: p.id, name: p.name }));
			return response({ projects: rows }, rows.length, offset + rows.length < list.length);
		}
		if (request.action === "missions" && missions) {
			const list = missions.store.list(request.projectId);
			const rows = list.slice(offset, offset + limit);
			return response({ missions: rows }, rows.length, offset + rows.length < list.length);
		}
		if (request.action === "mission" && missions) {
			if (!missions.store.get(request.missionId!))
				return { ...response(null, 0, false), status: "missing", reason: "deleted" };
			const tasks = missions.store.tasks(request.missionId!);
			const rows = tasks.slice(offset, offset + limit);
			const linearSync = missions.store.linearSyncDiagnostics(request.missionId!, offset, limit);
			const more = offset + rows.length < tasks.length || linearSync.more;
			return response(
				{
					mission: missions.store.get(request.missionId!),
					brief: missions.store.brief(request.missionId!),
					tasks: rows,
					// Why planning moves, waits or is stuck, read-only. Null without a planning agent.
					planning: planningWorkers?.diagnosticPlanning(request.missionId!) ?? null,
					linearSync: { ...linearSync, coverage: "Persisted mission sync only, no network fetch" },
				},
				Math.max(rows.length, linearSync.tickets.length),
				more,
			);
		}
		if (request.action === "issues" && tracking) {
			projects.require(request.projectId!);
			const items = await tracking.listItems({ projectId: request.projectId!, limit, offset, dismissed: false });
			return response(
				{ ...items, coverage: "retained_current_integration_binding_only_no_network_fetch" },
				items.items.length,
				items.items.length === limit,
			);
		}
		return { ...response(null, 0, false), status: "unavailable", reason: "unsupported" };
	};
	const machine = new MachineInformationReader(_config.home, hello?.daemonVersion ?? "unknown");
	const reviews = new ReviewStore(_config.home);
	const mcpSetup = new McpSetupStore(_config.agentDir);
	const dashboards = new ProjectDashboardService({
		sessions,
		projects,
		reviews,
		...(missions ? { missions: missions.store } : {}),
		providers: {
			...dashboardProviders,
			...(tracking ? { tracked: (id: string) => tracking.dashboard(id) } : {}),
			...(tracking ? { inbox: (id: string) => tracking.inboxCount(id) } : {}),
			...(memory ? { memory: (id: string) => memory.summary(id) } : {}),
			...(schedules
				? {
						scheduled: (id: string) => schedules.dashboard(id),
						scheduledProjects: () => schedules.noticeProjects(),
					}
				: {}),
			onChange(listener) {
				const stops = [
					dashboardProviders?.onChange?.(listener),
					memory?.onChange(listener),
					schedules?.onChange(listener),
					tracking?.onChange(listener),
				];
				return () => {
					for (const stop of stops) stop?.();
				};
			},
		},
	});
	const repositoryChanges = new RepositoryChanges();
	const pathCompletion = new PathCompletionReader();
	const repositories = new RepositoryBrowser(projects);
	const attachments = new AttachmentStore(_config.home);
	const transfers = new RuntimeAdmission();
	const mutations = new RuntimeAdmission();
	const runtimeSources = [
		terminals,
		attachments,
		sessions,
		transfers,
		mutations,
		...(githubSetup ? [githubSetup] : []),
		...(githubImport ? [githubImport] : []),
		...(setup ? [setup] : []),
		...(attentionExecutor ? [attentionExecutor.maintenance] : []),
	];
	const runtimeResources = new RuntimeResources([...runtimeSources, ...(liveUpdate?.contributors ?? [])]);
	if (bootstrap)
		sessions.bindLifecycleRuntime({
			...bootstrap.identity(),
			...(hello?.lineageId ? { host: { daemonId: hello.daemonId, lineageId: hello.lineageId } } : {}),
		});
	liveUpdate?.service.attach(runtimeResources);
	// Freeze synchronously before loading retained maintenance, before any recovery is admitted.
	const globalUpdate =
		bootstrap && hello?.lineageId
			? new GlobalUpdatePreparation(
					new OperationJournal(join(_config.home, "global-update-operations"), {
						hostId: "daemon",
						daemonId: hello.daemonId,
						lineageId: hello.lineageId,
					}),
					runtimeResources,
					sessions,
				)
			: undefined;
	const runtimeReady = Promise.all([liveUpdate?.service.load(), globalUpdate?.load()]).then(() => undefined);
	// Startup restore is allowed under maintenance, but work and recovery are not.
	const runtimeFrozen = () => legacyAdmissionFrozen || !!liveUpdate?.service.frozen || !!globalUpdate?.frozen;
	let lifecycleInterrupted = false;
	const reservations = new UpdateReservation(
		new RuntimeResources(
			// An app update keeps pilotd running, so paused agents and open terminals need not block it.
			runtimeSources.map((source) =>
				source === sessions
					? {
							freezeAdmissions: () => sessions.freezeAdmissions(),
							blockers: () => sessions.updateReservationBlockers(),
						}
					: source === terminals
						? {
								freezeAdmissions: () => terminals.freezeAdmissions(),
								blockers: () => terminals.admissionBlockers(),
							}
						: source,
			),
		),
		undefined,
		undefined,
		{
			freezeAdmissions: () => {
				const release = runtimeResources.freezeAdmissions();
				return () => {
					release();
					if (lifecycleInterrupted) {
						lifecycleInterrupted = false;
						void sessions.resumeMaintenance().catch((error) => console.warn("pilotd: lifecycle recovery", error));
					}
				};
			},
			blockers: () => runtimeResources.blockers(),
		},
		// Stop/Restart cannot interrupt an unfinished run merely because it paused.
		() => sessions.prepareUpdate().ready,
		async (operationId, purpose, replacement) => {
			// Intent is on disk before the first interrupted tool/job. The native
			// handoff journal separately owns service stop/start and runtime identity.
			await durableJSON(join(_config.home, ".daemon-lifecycle.json"), {
				schema: 1,
				operationId,
				purpose,
				phase: "checkpointing",
			});
			lifecycleInterrupted = true;
			const checkpoints = await Promise.allSettled([
				sessions.checkpointLifecycle(operationId, purpose, replacement),
				terminals.checkpointLifecycle(),
			]);
			const failed = checkpoints.find((result) => result.status === "rejected");
			if (failed?.status === "rejected") {
				// Exact failed attempt evidence, not a quiescence/resume receipt.
				await durableJSON(join(_config.home, ".daemon-lifecycle.json"), {
					schema: 1,
					operationId,
					purpose,
					phase: "refused",
					affectedSessions: sessions.lifecycleManifest(operationId),
				});
				throw failed.reason;
			}
			await durableJSON(join(_config.home, ".daemon-lifecycle.json"), {
				schema: 1,
				operationId,
				purpose,
				phase: "checkpointed",
				affectedSessions: sessions.lifecycleManifest(operationId),
			});
		},
	);
	let coordinatedReservation: { operationId: string; binding: string } | undefined;
	bootstrap?.updates(async (action, value) => {
		await runtimeReady;
		if (!value || typeof value !== "object") throw new Error("update_receipt_invalid");
		if ("globalUpdate" in value) {
			// Existing native owner proof only. Never an agent/session or TSX route.
			// A preparation receipt is not signature/process/replacement authority.
			if (!globalUpdate) throw new Conflict("Invalid global update");
			const input = value as { globalUpdate: DurableOperation; release?: DurableOperation; runtime?: unknown };
			const operation = input.globalUpdate;
			if (action === "release") {
				if (Object.keys(value).sort().join() !== "globalUpdate,release,runtime" || !input.release)
					throw new Conflict("Invalid global release");
				// The native service owner verifies the signed app and exact successor
				// (or rollback) before sending. Compare process-captured identity here,
				// never a mutable owner file, public hello or a matching version alone.
				const verifyRuntime = async () => {
					const current = bootstrap?.identity();
					if (
						!current?.build ||
						!current.runtimeRoot ||
						canonicalJSON(input.runtime) !==
							canonicalJSON({ boot: current.boot, build: current.build, runtimeRoot: current.runtimeRoot })
					)
						throw new Conflict("Global release runtime changed");
				};
				await verifyRuntime();
				return globalUpdate.release(input.release, operation, verifyRuntime);
			}
			if (Object.keys(value).join() !== "globalUpdate") throw new Conflict("Invalid global update");
			if (action === "inspect") return (await globalUpdate.lookup(operation)) ?? null;
			if (action === "prepare") return globalUpdate.prepare(operation);
			if (action === "verify") return globalUpdate.verify(operation);
			throw new Conflict("Native verified global update release is not configured");
		}
		if (globalUpdate?.frozen) throw new Conflict("Global update owns admissions; inspect the original operation");
		const receipt = value as ReservationReceipt & {
			liveUpdate?: LiveUpdateTarget & { id: string; guiBuild: string };
		};
		const coordinated = receipt.liveUpdate;
		let binding: string | undefined;
		if (liveUpdate?.service.frozen || coordinated) {
			const update = liveUpdate?.service.snapshot();
			const target = update?.target as (LiveUpdateTarget & { guiBuild: string }) | undefined;
			if (
				!update ||
				!target ||
				!coordinated ||
				Object.keys(coordinated).sort().join(",") !== "build,guiBuild,id,runtimeRoot,source" ||
				coordinated.id !== update.id ||
				coordinated.guiBuild !== update.build ||
				coordinated.guiBuild !== target.guiBuild ||
				coordinated.source !== target.source ||
				coordinated.runtimeRoot !== target.runtimeRoot ||
				!coordinated.build ||
				Object.keys(coordinated.build).sort().join(",") !== Object.keys(target.build).sort().join(",") ||
				Object.entries(target.build).some(
					([key, v]) => coordinated.build[key as keyof typeof target.build] !== v,
				) ||
				!(
					(update.phase === "gui-installing" && receipt.purpose === undefined) ||
					(update.phase === "daemon-installing" && receipt.purpose === "daemon-upgrade")
				)
			)
				throw new Conflict("Coordinated live update reservation does not match durable intent");
			binding = JSON.stringify([update.id, target.source, target.guiBuild, target.runtimeRoot, target.build]);
			if (
				action !== "prepare" &&
				action !== "inspect" &&
				(coordinatedReservation?.operationId !== receipt.operationId || coordinatedReservation.binding !== binding)
			)
				throw new Conflict("Coordinated live update reservation changed");
		}
		if (action === "inspect") return receipt;
		if (action === "prepare") {
			const prepared = await reservations.prepare(
				receipt.operationId,
				receipt.purpose,
				receipt.interrupt,
				receipt.replacement,
			);
			coordinatedReservation = binding ? { operationId: receipt.operationId, binding } : undefined;
			return coordinated ? { ...prepared, liveUpdate: structuredClone(coordinated) } : prepared;
		}
		if (action === "cancel") {
			reservations.cancel(receipt);
			coordinatedReservation = undefined;
			return receipt;
		}
		const verified = reservations.verify(receipt);
		return coordinated ? { ...verified, liveUpdate: structuredClone(coordinated) } : verified;
	});
	if (legacyAdmissionFrozen) runtimeResources.freezeAdmissions();
	const journal = hello?.lineageId
		? new OperationJournal(join(_config.home, "operations"), {
				hostId: "daemon",
				daemonId: hello.daemonId,
				lineageId: hello.lineageId,
			})
		: undefined;
	const feedbackReader = (
		target: Pick<import("@pilot/protocol").ReviewDispositionTarget, "projectId" | "sessionId" | "snapshotId">,
	) => {
		if (!missions) throw new ServiceUnavailable("Retained feedback unavailable");
		return retainedFeedbackReader(missions.store, sessions, projects, target);
	};
	sessions.feedbackMetricsScope = (operationId, sessionId) =>
		missions?.store.feedback.metricsScope(operationId, sessionId);
	sessions.feedbackFixAdmission = (sessionId, projectId) =>
		!!missions?.store.feedback.resultPage({ kind: "fix", id: sessionId, projectId }, Number.MAX_SAFE_INTEGER, 1).items
			.length;
	const reviewRequests = missions ? optionalReviewRequests(missions.store, sessions, projects) : undefined;
	const humanReviews = missions
		? new HumanReviews({
				store: missions.store.humanReviews,
				qualify: (target) => feedbackReader(target).qualify(target),
				requirement: (target) => missions.store.reviewRequests.requirement(target),
				// Real required-check/fresh-review producers remain absent. Approve refuses.
			})
		: undefined;
	const workflowConfirmations =
		journal && missions
			? new WorkflowConfirmations({
					store: missions.store,
					journal,
					authorize: (projectId, coordinatorSessionId) => {
						const project = projects.require(projectId);
						const coordinator = sessions.get(coordinatorSessionId);
						if (!coordinator || coordinator.projectId !== projectId || coordinator.archivedAt)
							throw new Conflict("Workflow coordinator project or availability changed");
						return payloadHash(
							canonicalJSON({
								project,
								coordinator: {
									id: coordinatorSessionId,
									projectId: coordinator.projectId,
									mode: coordinator.mode,
									role: coordinator.role,
								},
							}),
						);
					},
					dispositions: humanReviews,
					// No consent configuration, provider executor or review prerequisite producer is installed here.
				})
			: undefined;
	const planningWorkers =
		journal && missions && workflowConfirmations
			? new PlanningWorkers({
					home: _config.home,
					store: missions.store,
					journal,
					projects,
					sessions,
					confirmations: workflowConfirmations,
					...(missions.knowledge ? { knowledge: missions.knowledge } : {}),
					...(tracking ? { tracking } : {}),
					// Read when a mission is planned from feedback; feedbackWork is set up below.
					feedbackProposal: (sessionId: string, prototype: boolean) =>
						feedbackWork ? feedbackWork.proposal(sessionId, prototype) : Promise.resolve(undefined),
				})
			: undefined;
	const nativePlanning =
		journal && missions && workflowConfirmations
			? new NativeMissionPlanning({
					store: missions.store,
					journal,
					projects,
					sessions,
					confirmations: workflowConfirmations,
					workers: planningWorkers,
				})
			: undefined;
	// Ready research questions start read-only research chats (D28), within existing limits.
	planningWorkers?.startResearch();
	// Builders whose turn ended with no result and no question before this start get their one reminder.
	missions?.service.nudgeWaitingBuilders?.();
	const missionThreads =
		journal && missions
			? new MissionThreads({ store: missions.store, journal, projects, sessions, workers: planningWorkers })
			: undefined;
	// Thread messages that still wait for a planning agent go to their thread chats instead.
	void missionThreads?.migrate().catch((error: unknown) => console.warn(`pilotd: thread migration failed: ${error}`));
	const nativeIntake =
		journal && tracking
			? new NativeIntake({ journal, tracking, projects, sessions, missions: missions?.store })
			: undefined;
	const nativeChat = journal ? new NativeChat({ journal, projects, sessions }) : undefined;
	// Screen agent chats and the Day windows that answer them. Memory only.
	const screen = new ScreenBroker({
		requireScreenChat: (id) => {
			const chat = sessions.get(id);
			if (!chat) throw new NotFound("Unknown chat");
			if (chat.role !== "screen") throw new Conflict("Only a screen agent chat can use a window");
		},
		readPicture: (ref) => attachments.read(ref),
	});
	sessions.screenCall = (sessionId, operation, signal) => screen.call(sessionId, operation, signal);
	const nativeProjects =
		journal && githubSetup && githubImport
			? new NativeProjects({
					journal,
					projects,
					setup: githubSetup,
					imports: githubImport,
					profiles: () => models.workProfiles(),
				})
			: undefined;
	const userVerifications =
		journal && missions ? new UserVerifications({ journal, store: missions.store, projects, sessions }) : undefined;
	const feedbackWork =
		missions && nativeChat
			? new UserFeedbackWorkService({ store: missions.store, chats: nativeChat, sessions, attachments })
			: undefined;
	const userFeedback = missions
		? new UserFeedbackService({ store: missions.store, projects, sessions, work: feedbackWork, attachments })
		: undefined;
	const deliveredArtifacts =
		userVerifications && missions
			? new DeliveredArtifacts({ store: missions.store, projects, sessions, verifications: userVerifications })
			: undefined;
	const nativeAttention =
		journal && missions
			? new NativeAttention({
					home: journal.destination,
					store: missions.store,
					projects,
					sessions,
					journal,
					executor: attentionExecutor,
					// Startup supplies no executor. Dependent-work consumers remain separate adapters.
				})
			: undefined;
	const dayInsights =
		journal && missions?.store.dayInsights && sessions.insightsAdmissionEpoch
			? new DayInsights({
					home: _config.home,
					host: journal.destination,
					projects,
					models,
					store: missions.store.dayInsights,
					owners: missions.store.insightsOwner,
					workspace: missions.store.insightsWorkspace,
					admissionEpoch: sessions.insightsAdmissionEpoch,
					allowance: missions.store.dayInsightsAllowance,
					sessions,
					runtime: schedules
						? new DayInsightsExecution({
								sessions,
								owners: missions.store.insightsOwner,
								store: missions.store.dayInsights,
								schedules,
								journal,
								models,
							})
						: undefined,
				})
			: undefined;
	sessions.dayInsights = dayInsights;
	const insightsWorkspace =
		journal && missions && schedules
			? new InsightsWorkspace({
					home: _config.home,
					host: journal.destination,
					projects,
					models,
					store: missions.store.insightsWorkspace,
					journal,
					legacyGuard: () => {
						sessions.assertNoLegacyInsights();
						schedules.assertNoLegacyInsights(journal.destination);
					},
				})
			: undefined;
	const insightsTransition =
		journal &&
		missions?.store.insightsTransition &&
		missions.store.insightsWorkspace &&
		sessions.insightsAdmissionEpoch &&
		schedules
			? new InsightsTransition({
					home: _config.home,
					projects,
					mission: (id) => {
						const m = missions.store.require(id);
						return { projectId: m.projectId, status: m.status };
					},
					workspace: missions.store.insightsWorkspace,
					store: missions.store.insightsTransition,
					journal,
					sessions,
					schedules,
				})
			: undefined;
	const insightsOwner =
		journal && missions?.store.insightsOwner && sessions.insightsAdmissionEpoch && schedules
			? new InsightsOwner({
					home: _config.home,
					projects,
					models,
					workspace: missions.store.insightsWorkspace,
					store: missions.store.insightsOwner,
					transition: insightsTransition,
					sessions,
					schedules,
					journal,
				})
			: undefined;
	const insightsLegacy =
		journal && missions?.store.insightsLegacy
			? new InsightsLegacy({
					home: _config.home,
					host: journal.destination,
					projects,
					sessions,
					journal,
					records: missions.store.insightsLegacy,
					mission: (id) => {
						const m = missions.store.require(id);
						return { projectId: m.projectId, status: m.status };
					},
				})
			: undefined;
	const insightsEnable =
		journal && missions && schedules
			? new InsightsEnable({
					home: _config.home,
					host: journal.destination,
					projects,
					missions: missions.store,
					models,
					sessions,
					schedules,
					journal,
				})
			: undefined;
	const insightsApply =
		journal && missions && schedules && insightsEnable
			? new InsightsApply(
					{
						home: _config.home,
						host: journal.destination,
						projects,
						missions: missions.store,
						models,
						sessions,
						schedules,
						journal,
					},
					insightsEnable,
				)
			: undefined;
	const insightsReplacement =
		journal && missions && schedules
			? new InsightsReplacement({
					home: _config.home,
					host: journal.destination,
					projects,
					missions: missions.store,
					models,
					sessions,
					schedules,
					journal,
				})
			: undefined;
	const connectionControls = new ConnectionControls(mcpSetup, mcp, _config.mcpSetupReadOnly);
	const scheduleControls =
		schedules && journal ? new ScheduleControls(schedules, sessions, projects, journal.destination) : undefined;
	if (schedules) missions?.service.setSchedules?.(schedules);
	const slackControls = tracking ? new SlackControls(projects, tracking) : undefined;
	const modelControls = new ModelControls(models, projects, setup, sessions, _config.modelScopeReadOnly);
	const diagnosticsControls =
		telemetry && journal
			? new DiagnosticsControls(
					telemetry,
					models,
					sessions,
					_config.home,
					journal.destination,
					async () => {
						await tracking?.flushDiagnosticEvidence?.();
					},
					async () => {
						await tracking?.clearDiagnosticEvidence?.();
					},
				)
			: undefined;
	const admitOperation = async (op: DurableOperation, trace?: TraceCarrier): Promise<unknown> => {
		const end = mutations.begin({ kind: "operation", id: op.operationId });
		try {
			return await admitOperationHeld(op, trace);
		} finally {
			end();
		}
	};
	const admitOperationHeld = async (op: DurableOperation, trace?: TraceCarrier): Promise<unknown> => {
		if (op.kind === CONNECTION_CONTROLS) throw new Error("Connection outcome unknown; lookup only");
		if (op.kind === SLACK_CONTROLS) throw new Error("Slack outcome unknown; lookup only");
		// The database feature is removed. Its saved operations stay lookup only.
		if (op.kind === "database-controls") throw new Error("Database outcome unknown; lookup only");
		if (op.kind === DIAGNOSTICS_CONTROLS) throw new Error("Diagnostics outcome unknown; lookup only");
		if (op.kind === SCHEDULE_CONTROLS) throw new Error("Schedule outcome unknown; lookup only");
		if (op.kind === MODEL_CONTROLS) throw new Error("Model settings outcome unknown; lookup only");
		if (isThreadOperation(op.kind)) {
			if (!missionThreads) throw new Error("Topic lookup unavailable");
			return missionThreads.admit(op, false);
		}
		if (op.kind === "project-preferences-update") throw new Error("Preference outcome is unknown; Check only");
		if (op.kind === PROJECT_ACTION) {
			if (!nativeProjects) throw new Error("Project setup outcome is unknown; Check only");
			return nativeProjects.recover(op);
		}
		if (op.kind === "user-feedback") throw new Error("Feedback outcome is unknown; Check only");
		if (op.kind === FEEDBACK_WORK) {
			// Only an answer settles, by exact accepted-input lookup; nothing is sent again.
			if (!feedbackWork) throw new Error("Feedback step outcome is unknown; Check only");
			return feedbackWork.recover(op);
		}
		if (op.kind === "user-verification") throw new Error("Verification outcome is unknown; Check only");
		if (op.kind === "attention-answer") {
			if (!nativeAttention) throw new OperationRejected("Native attention unavailable");
			return nativeAttention.answer(op, false);
		}
		if (planningWorkers?.owns(op)) return planningWorkers.recover(op);
		if (op.kind === "native-chat-create") {
			throw new Error("Chat creation outcome is unknown; check its saved receipt");
		}
		if (op.kind === CHAT_CONTINUE) {
			if (!nativeChat) throw new Error("Continue outcome is unknown; Check only");
			return nativeChat.continueChat(op, false);
		}
		if (op.kind === CHAT_REPLY) {
			if (!nativeChat) throw new Error("Reply outcome is unknown; Check only");
			return nativeChat.replyChat(op, false);
		}
		if (op.kind === CHAT_DISMISS) {
			if (!nativeChat) throw new Error("Dismiss outcome is unknown; Check only");
			return nativeChat.dismissChat(op, false);
		}
		if (isIntakeOperation(op.kind)) {
			// Recovery is lookup-only; pending intake effects never enter again.
			throw new Error("Intake outcome is unknown; check its saved receipt");
		}
		if (isNativePlanningOperation(op.kind)) {
			if (!nativePlanning) throw new OperationRejected("Native planning unavailable");
			return nativePlanning.admit(op, false);
		}
		if (op.kind === "insights-workspace-transfer") {
			if (!insightsTransition) throw new OperationRejected("Insights transition unavailable");
			return insightsTransition.admit(op, false);
		}
		if (isInsightsOwnerOperation(op.kind)) {
			if (!insightsOwner) throw new OperationRejected("Owner Insights execution unavailable");
			return insightsOwner.admit(op);
		}
		if (op.kind === "day-insights") {
			if (!dayInsights) throw new OperationRejected("Day Insights unavailable");
			return dayInsights.admit(op, false);
		}
		if (isInsightsWorkspaceOperation(op.kind)) {
			if (!insightsWorkspace) throw new OperationRejected("App-owned Insights workspace unavailable");
			return insightsWorkspace.admit(op);
		}
		if (isInsightsOperation(op.kind)) insightsWorkspace?.assertLegacyAllowed();
		if (isWorkflowOperation(op.kind)) {
			if (!workflowConfirmations) throw new OperationRejected("Workflow confirmations are unavailable");
			return workflowConfirmations.admit(op);
		}
		let payload: unknown;
		try {
			payload = JSON.parse(op.payload);
		} catch {
			throw new OperationRejected("Invalid payload JSON");
		}
		if (!payload || typeof payload !== "object" || Array.isArray(payload))
			throw new OperationRejected("Expected operation object");
		if (op.kind === "insights-replace") {
			if (!insightsReplacement) throw new OperationRejected("Insights replacement is unavailable");
			return insightsReplacement.replace(op, payload as import("@pilot/protocol").InsightsReplacementPayload);
		}
		if (op.kind === "insights-apply") {
			if (!insightsApply) throw new OperationRejected("Insights Apply is unavailable");
			return insightsApply.apply(op, payload as import("@pilot/protocol").InsightsApplyPayload);
		}
		if (op.kind === "insights-settings") {
			if (!insightsEnable) throw new OperationRejected("Insights settings are unavailable");
			return insightsEnable.saveSettings(op, payload as import("@pilot/protocol").InsightsSettingsPayload);
		}
		if (op.kind === "insights-enable") {
			if (!insightsEnable) throw new OperationRejected("Weekly Insights is unavailable");
			return insightsEnable.enable(op, payload as import("@pilot/protocol").InsightsEnablePayload);
		}
		if (isInsightsOperation(op.kind)) {
			if (!missions) throw new OperationRejected("Insights is unavailable");
			return admitInsightsOperation(sessions, missions.store.insights, op, payload as Record<string, unknown>);
		}
		const attached = op.kind === "chat-create-attached" || op.kind === "chat-send-attached";
		if (attached) {
			const body = payload as AttachmentChatPayload<SpawnRequest | SendRequest>;
			if (!body.request || typeof body.request.message !== "string")
				throw new OperationRejected("Invalid attached message");
			const paths = await attachments.adopt(op, body.attachments);
			const suffix = paths.length
				? "\n\nAttached images (use the read tool to view these files):\n" +
					paths.map((path) => `- \`${path}\``).join("\n")
				: "";
			payload = { ...body.request, message: body.request.message + suffix };
		}
		if (
			op.kind === "chat-create" ||
			op.kind === "chat-create-attached" ||
			op.kind === "diagnostics-create" ||
			op.kind === "repair-create"
		) {
			const request = payload as SpawnRequest;
			if (typeof request.message !== "string" || !request.message.trim())
				throw new OperationRejected("message is required");
			if (op.kind === "diagnostics-create" && request.role !== "diagnostics")
				throw new OperationRejected("diagnostics-create requires a diagnostics specialist");
			if (
				op.kind === "repair-create" &&
				(request.role !== undefined || request.mode !== "build" || request.diagnosticRepair === undefined)
			)
				throw new OperationRejected("repair-create requires an ordinary Build chat");
			if (op.kind !== "repair-create" && request.diagnosticRepair !== undefined)
				throw new OperationRejected("diagnostic repair authority requires repair-create");
			const session = await sessions.spawnDurable(request, op.targetId, op.operationId);
			return { sessionId: session.id };
		}
		if (op.kind === "chat-send" || op.kind === "chat-send-attached") {
			const request = payload as SendRequest & { questionReplyId?: number; inputGeneration?: number };
			if (
				typeof request.message !== "string" ||
				!request.message.trim() ||
				(request.mode !== undefined && request.mode !== "steer" && request.mode !== "followUp") ||
				(request.questionReplyId !== undefined &&
					(!Number.isSafeInteger(request.questionReplyId) || request.questionReplyId <= 0)) ||
				(request.inputGeneration !== undefined &&
					(!Number.isSafeInteger(request.inputGeneration) || request.inputGeneration < 0))
			)
				throw new OperationRejected("Invalid message");
			try {
				await sessions.sendDurable(op.targetId, request.message, request.mode ?? "followUp", op.operationId, {
					explicitModelRecovery: true,
					trace,
					questionReplyId: request.questionReplyId,
					inputGeneration: request.inputGeneration,
				});
			} catch (error) {
				if (
					error instanceof CommandRejected &&
					(error.code === "stale_question" || (error.code === "stopped" && request.inputGeneration !== undefined))
				)
					throw new OperationRejected(error.message);
				throw error;
			}
			return { sessionId: op.targetId };
		}
		throw new OperationRejected("Unsupported operation kind");
	};
	// Only registered idempotent handlers resume. An interrupted handler always retains the same target.
	let operationRecovery: Promise<void> | undefined;
	const recoverOperations = () => {
		if (journal && !operationRecovery && !runtimeFrozen())
			operationRecovery = journal
				.recover(admitOperation, (op) => !isRetiredDevboxOperation(op.kind))
				.catch((error) => console.warn("pilotd: operation recovery", error))
				.finally(() => {
					operationRecovery = undefined;
				});
	};
	let closing: Promise<void> | undefined;
	const close = (): Promise<void> => {
		if (!closing) {
			reservations.close();
			closing = Promise.all([planningWorkers?.close(), nativeAttention?.close()]).then(() => undefined);
		}
		return closing;
	};
	return {
		dependencies: options,
		admitOperation,
		recoverOperations,
		machine,
		reviews,
		mcpSetup,
		dashboards,
		repositoryChanges,
		pathCompletion,
		repositories,
		attachments,
		transfers,
		mutations,
		runtimeSources,
		runtimeResources,
		globalUpdate,
		runtimeReady,
		runtimeFrozen,
		reservations,
		journal,
		feedbackReader,
		reviewRequests,
		humanReviews,
		workflowConfirmations,
		planningWorkers,
		nativePlanning,
		missionThreads,
		nativeIntake,
		linearPublisher: options.linearPublisher,
		nativeChat,
		nativeProjects,
		userVerifications,
		feedbackWork,
		userFeedback,
		deliveredArtifacts,
		nativeAttention,
		insightsWorkspace,
		dayInsights,
		insightsTransition,
		insightsOwner,
		insightsLegacy,
		insightsEnable,
		insightsApply,
		insightsReplacement,
		connectionControls,
		slackControls,
		modelControls,
		diagnosticsControls,
		scheduleControls,
		screen,
		close,
	};
}

export type DaemonServices = ReturnType<typeof createDaemonServices>;
