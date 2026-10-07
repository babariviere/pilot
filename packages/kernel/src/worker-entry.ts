/**
 * Kernel worker process entry. Node strips the TypeScript natively (no loader hook), and the on-disk
 * compile cache must be enabled before the kernel's large module graph is imported.
 */
import { enableCompileCache } from "node:module";

enableCompileCache();
await import("./worker.ts");
