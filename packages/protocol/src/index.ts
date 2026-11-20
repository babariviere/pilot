/** Shared HTTP and WebSocket contracts for Pilot clients. */
export type {
	AssistantMessage,
	BaseAgentEvent,
	EntryRecord,
	Message,
	MessageChange,
	QueuedItem,
	SnapshotEvent,
	ToolEventCall,
	ToolResultMessage,
	ToolSlot,
	UserMessage,
} from "./agent-events.ts";
export type * from "./artifacts.ts";
export type * from "./automations.ts";
export type * from "./chat-input.ts";
export type * from "./chat-settings.ts";
export type * from "./chat-stream.ts";
export type { CodingQueueView } from "./coding-queue.ts";
export type * from "./critical-review.ts";
export * from "./dashboard.ts";
export type * from "./day-insights.ts";
export type * from "./decision-assistance.ts";
export type {
	DeliveredArtifact,
	DeliveredArtifactRequest,
	ProjectArtifact,
	ProjectArtifactRequest,
	SavedArtifactContent,
} from "./delivered-artifact.ts";
export type * from "./diagnostic-context.ts";
export type * from "./diagnostic-logs.ts";
export type * from "./diagnostic-repair.ts";
export type * from "./diagnostics.ts";
export type * from "./diagnostics-controls.ts";
export type * from "./environment.ts";
export * from "./feature-events.ts";
export * from "./feature-usage.ts";
export type * from "./funding.ts";
export type * from "./github-actions.ts";
export type * from "./github-import.ts";
export type * from "./github-setup.ts";
export type { DaemonCapabilities, DaemonHello } from "./hello.ts";
export {
	DAEMON_PROTOCOL_VERSION,
	DEFAULT_PORT,
	MINIMUM_CLIENT_PROTOCOL_VERSION,
} from "./hello.ts";
export type * from "./human-review.ts";
export type * from "./inbox.ts";
export type * from "./insights.ts";
export type * from "./insights-workspace.ts";
export type * from "./knowledge.ts";
export type * from "./landed-changes.ts";
export type * from "./live-update.ts";
export type { MachineInformation } from "./machine.ts";
export type * from "./mcp.ts";
export type * from "./mcp-setup.ts";
export type * from "./memory.ts";
export type * from "./mission-catalog.ts";
export type * from "./mission-controls.ts";
export type * from "./mission-interview.ts";
export type * from "./mission-migration.ts";
export type * from "./mission-plan.ts";
export type * from "./mission-reports.ts";
export type * from "./mission-revision.ts";
export type * from "./mission-thread.ts";
export type * from "./missions.ts";
export type * from "./model-scope.ts";
export type * from "./models.ts";
export type * from "./native-attention.ts";
export type * from "./native-review.ts";
export * from "./operations.ts";
export type * from "./pi-reload.ts";
export type * from "./planning-activity.ts";
export type * from "./planning-inventory.ts";
export type { PowerSettings, PowerStatus } from "./power.ts";
export type * from "./project-preferences.ts";
export type * from "./projects.ts";
export type * from "./pull-requests.ts";
export type * from "./questions.ts";
export type * from "./refresh-health.ts";
export type * from "./repositories.ts";
export type * from "./result-review.ts";
export type * from "./review-requests.ts";
export type * from "./schedules.ts";
export type * from "./screen-agent.ts";
export type * from "./session.ts";
export type * from "./session-changes.ts";
export type * from "./setup.ts";
export type * from "./sockets.ts";
export type * from "./subscription-refresh.ts";
export type * from "./telemetry.ts";
export type * from "./tracking.ts";
export type * from "./transfers.ts";
export type * from "./usage.ts";
export type * from "./usage-history.ts";
export type * from "./user-feedback.ts";
export type {
	ChatReport,
	DeliveredWork,
	DeliveredWorkList,
	UserVerification,
	UserVerificationIntent,
	UserVerificationLookup,
	UserVerificationReceipt,
} from "./user-verification.ts";
export type { VerificationSubject } from "./verification-subject.ts";
export type * from "./work-profiles.ts";
export type * from "./workflow-confirmations.ts";
