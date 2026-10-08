/**
 * Kernel worker process entry. Node strips the TypeScript natively (no loader hook), and the on-disk
 * compile cache must be enabled before the kernel's large module graph is imported.
 */
import { enableCompileCache } from "node:module";
import { lowerWorkerPriority } from "./worker-priority.ts";

enableCompileCache();
lowerWorkerPriority();
const { runKernelWorker } = await import("./worker.ts");
runKernelWorker();
