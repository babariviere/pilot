#!/usr/bin/env node
/** pilotd entry. Enable Node's on-disk compile cache before importing the daemon's module graph. */
import { enableCompileCache } from "node:module";
import { runtimeEnvironment } from "@pilot/kernel/runtime-environment";
import { timestampConsole } from "./logging.ts";
import { bootstrapRuntime } from "./runtime-bootstrap.ts";

enableCompileCache();
timestampConsole();
Object.assign(process.env, runtimeEnvironment());
await bootstrapRuntime();
await import("./daemon.ts");
