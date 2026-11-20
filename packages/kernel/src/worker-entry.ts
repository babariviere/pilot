/**
 * Kernel worker process entry. Node strips the TypeScript natively (no loader hook), and the on-disk
 * compile cache must be enabled before the kernel's large module graph is imported.
 */
import { enableCompileCache } from "node:module";
import { runtimeEnvironment } from "./runtime/runtime-environment.ts";

enableCompileCache();
Object.assign(process.env, runtimeEnvironment());
const { installCredentialBrokerHooks } = await import("./credentials/credential-hooks.ts");
await installCredentialBrokerHooks();
const { configureBundledChildren } = await import("./runtime/bundled-extensions.ts");
configureBundledChildren();
const { runKernelWorker } = await import("./worker/worker.ts");
runKernelWorker();
