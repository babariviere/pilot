export type { PilotContext, WorkspaceContext } from "./policy.ts";
export type { KernelCommand, KernelPacket, KernelSpec } from "./protocol.ts";

/** Absolute path of the worker entry, for `child_process.fork`. Plain Node runs it: no loader is needed. */
export const workerEntry = new URL("./worker-entry.ts", import.meta.url);
