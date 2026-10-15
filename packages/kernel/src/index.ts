export { installBundledAnthropicAuth } from "./bundled-extensions.ts";
export type { ConnectivityState } from "./connectivity.ts";
export { probeReachability } from "./connectivity.ts";
export { formatFailure, safeFailureText } from "./failure.ts";
export { inputOrigin } from "./input-origin.ts";
export type { MissionAction } from "./mission-tools.ts";
export type { AskContext, MissionContext, PilotContext, WorkspaceContext, WorkspaceReset } from "./policy.ts";
export type { KernelCommand, KernelPacket, KernelSpec, KernelSubagent, KernelUsage } from "./protocol.ts";
export type { EarlierEntriesRead, PersistedSessionView, SubagentTranscriptRead } from "./snapshot.ts";
export { subagentStorageSignature } from "./subagent-watch.ts";

/** Absolute path of the worker entry, for `child_process.fork`. Plain Node runs it: no loader is needed. */
export const workerEntry = new URL("./worker-entry.ts", import.meta.url);

/** A one-shot cold reader with no agent initialization. */
export const snapshotWorkerEntry = new URL("./snapshot-worker.ts", import.meta.url);

/** A long-lived, read-only watcher for one subagent transcript. */
export const subagentWatchWorkerEntry = new URL("./subagent-watch-worker.ts", import.meta.url);
export type { SystemMessageStateEvent } from "./held-inputs.ts";
