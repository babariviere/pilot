export { installBundledAnthropicAuth } from "./runtime/bundled-extensions.ts";
export type { ConnectivityState } from "./runtime/connectivity.ts";
export { connectivityHints, probeReachability, providerOrigin } from "./runtime/connectivity.ts";
export type { CoordinatorSources } from "./missions/coordinator-sources.ts";
export { ACTIVITY_ENTRY, PLANNING_INPUT_ENTRY, QUESTION_ENTRY } from "./history/entry-kinds.ts";
export { formatFailure, safeFailureText } from "./failure.ts";
export { inputOrigin } from "./session/input/input-origin.ts";
export { createMissionPlanTool, type NativePlanningPort } from "./missions/mission-plan-tool.ts";
export type { MissionAction } from "./missions/mission-tools.ts";
export { THREAD_ACTIONS } from "./missions/mission-tools.ts";
export type {
	PlanningInput,
	PlanningRound,
	PlanningWorkerBinding,
	PlanningWorkerReply,
	PlanningWorkerRequest,
} from "./missions/planning-worker.ts";
export { assertPlanningBinding, PLANNING_PROFILE } from "./missions/planning-worker.ts";
export type { AskContext, MissionContext, PilotContext, WorkspaceContext, WorkspaceReset } from "./runtime/policy.ts";
export type {
	ExecutionEvidence,
	HostCall,
	HostCallPacket,
	HostCalls,
	HostMethod,
	KernelCommand,
	KernelPacket,
	KernelSpec,
	KernelSubagent,
	KernelTelemetryConfiguration,
} from "./worker/protocol.ts";
export type { QuestionClarification } from "./tools/questions/question-clarifications.ts";
export type { ReferenceSource } from "./tools/sources/reference-sources.ts";
export type { EarlierEntriesRead, PersistedSessionView, SubagentTranscriptRead } from "./history/snapshot.ts";
export { subagentStorageSignature } from "./tools/jobs/subagent-watch.ts";
export type { ToolActivityRecord } from "./session/activity/tool-activity.ts";
export {
	MAX_TOOL_ACTIVITY_FILE_BYTES,
	parseToolActivityRecord,
	TOOL_ACTIVITY_FILE,
} from "./session/activity/tool-activity.ts";
export { type ExecutionPermission, inheritedExecutionPermission } from "./tools/codemode/tool-policy.ts";
export type { KernelUsage } from "./funding/usage.ts";

/** Absolute path of the worker entry, for `child_process.fork`. Plain Node runs it: no loader is needed. */
export const workerEntry = new URL("./worker-entry.ts", import.meta.url);

/** A one-shot cold reader with no agent initialization. */
export const snapshotWorkerEntry = new URL("./history/snapshot-worker.ts", import.meta.url);

/** Credential-free, writer-leased cancellation of failed child recovery. */
export const stopRecoveryWorkerEntry = new URL("./session/lifecycle/stop-recovery-worker.ts", import.meta.url);
export type { RecoveryStop } from "./session/lifecycle/stop-recovery.ts";

/** A long-lived, read-only watcher for one subagent transcript. */
export const subagentWatchWorkerEntry = new URL("./tools/jobs/subagent-watch-worker.ts", import.meta.url);
export type { SystemMessageStateEvent } from "./session/input/held-inputs-doc.ts";
export { DIAGNOSTIC_LOG_SOURCES, TARGET_LOG_SOURCES } from "./diagnostics/diagnostic-log-sources.ts";
