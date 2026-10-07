export type { PilotContext, WorkspaceContext } from "./policy.ts";
export type { KernelCommand, KernelPacket, KernelSpec } from "./protocol.ts";

/** Absolute path of the worker entry, for `child_process.fork`. */
export const workerEntry = new URL("./worker.ts", import.meta.url);
