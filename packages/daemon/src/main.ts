#!/usr/bin/env node
/** pilotd entry. Enable Node's on-disk compile cache before importing the daemon's module graph. */
import { enableCompileCache } from "node:module";

enableCompileCache();
await import("./daemon.ts");
