export { installBundledAnthropicAuth } from "./bundled-extensions.ts";
export type { ConnectivityState } from "./connectivity.ts";
export { probeReachability, providerOrigin } from "./connectivity.ts";
export { parseControlPreparationRecord } from "./control-preparation.ts";
export type { ControlTurnOrigin } from "./control-turn-origin.ts";
export { formatFailure, safeFailureText } from "./failure.ts";
export { inputOrigin } from "./input-origin.ts";
export type { MissionAction } from "./mission-tools.ts";
export type { AskContext, MissionContext, PilotContext, WorkspaceContext, WorkspaceReset } from "./policy.ts";
export type {
	DiagnosticLogExcerpt,
	DiagnosticLogPage,
	DiagnosticLogRecord,
	DiagnosticLogRequest,
	DiagnosticLogResult,
	DiagnosticLogSourceId,
	DiagnosticLogSourceInventory,
	ExecutionEvidence,
	KernelCommand,
	KernelPacket,
	KernelSpec,
	KernelSubagent,
	KernelTelemetryConfiguration,
	KernelUsage,
} from "./protocol.ts";
export type { EarlierEntriesRead, PersistedSessionView, SubagentTranscriptRead } from "./snapshot.ts";
export { subagentStorageSignature } from "./subagent-watch.ts";
export type { ToolActivityRecord } from "./tool-activity.ts";
export {
	MAX_TOOL_ACTIVITY_FILE_BYTES,
	parseToolActivityRecord,
	TOOL_ACTIVITY_FILE,
} from "./tool-activity.ts";
export type { ControlPermission } from "./tool-policy.ts";

/** Absolute path of the worker entry, for `child_process.fork`. Plain Node runs it: no loader is needed. */
export const workerEntry = new URL("./worker-entry.ts", import.meta.url);

/** A one-shot cold reader with no agent initialization. */
export const snapshotWorkerEntry = new URL("./snapshot-worker.ts", import.meta.url);

/** Credential-free, writer-leased cancellation of failed child recovery. */
export const stopRecoveryWorkerEntry = new URL("./stop-recovery-worker.ts", import.meta.url);
export type { RecoveryStop } from "./stop-recovery.ts";

/** A long-lived, read-only watcher for one subagent transcript. */
export const subagentWatchWorkerEntry = new URL("./subagent-watch-worker.ts", import.meta.url);
export type { SystemMessageStateEvent } from "./held-inputs.ts";
