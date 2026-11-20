/** Test-only reader entry: posts Node's watch-mode notice before the real read result. */
import { parentPort } from "node:worker_threads";

parentPort?.postMessage({ "watch:import": ["file:///synthetic/module.ts"] });
parentPort?.postMessage({ view: { events: [] }, bytes: 24 });
