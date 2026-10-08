export type { AskContext, PilotContext, WorkspaceContext } from "./policy.ts";
export type { KernelCommand, KernelPacket, KernelSpec, KernelSubagent } from "./protocol.ts";
export type { PersistedSessionView, SubagentTranscriptRead } from "./snapshot.ts";
export { subagentStorageSignature } from "./subagent-watch.ts";

/** Absolute path of the worker entry, for `child_process.fork`. Plain Node runs it: no loader is needed. */
export const workerEntry = new URL("./worker-entry.ts", import.meta.url);

/** A one-shot cold reader with no native SDK or agent initialization. */
export const snapshotWorkerEntry = new URL("./snapshot-worker.ts", import.meta.url);

/** A long-lived, read-only watcher for one subagent transcript. */
export const subagentWatchWorkerEntry = new URL("./subagent-watch-worker.ts", import.meta.url);
