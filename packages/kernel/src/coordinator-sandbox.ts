/** Loaded by Pi's TS loader. Keep the bundled sandbox's policy, shell service and ownership checks. */

import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assertCoordinatorScratchWrite, createCoordinatorSourceTools } from "./coordinator-source-tools.ts";
import { COORDINATOR_SOURCES_EVENT, type CoordinatorSourcesRequest } from "./coordinator-sources.ts";
import { contained, sourcePath } from "./source-reader.ts";

export default async function coordinatorSandbox(pi: ExtensionAPI): Promise<void> {
	// Like child-profile, load pinned extension TS through Pi's loader, not Node's erasable-TS loader.
	const path = import.meta.resolve("@babariviere/pi-extensions/extensions/sandbox");
	const { SandboxSession } = await import(path);
	const sandbox: {
		initialize(ctx: ExtensionContext): Promise<void>;
		current(): { readGuard(): (path: string) => void; enforcing: boolean; policy: { denyRead: string[] } };
		close(): Promise<void>;
	} = new SandboxSession(pi);
	const owners = new Map<string, string>();
	const readScope = (signal?: AbortSignal) => {
		const request: CoordinatorSourcesRequest = { signal };
		pi.events.emit(COORDINATOR_SOURCES_EVENT, request);
		return request.result ?? Promise.reject(new Error("Coordinator source admission is unavailable"));
	};
	let removeGuard: (() => void) | undefined;
	let guardScratchWrite = (_path: string): void => {
		throw new Error("Coordinator scratch is not initialized");
	};
	pi.on("session_start", async (_event, ctx) => {
		await sandbox.initialize(ctx);
		const scratch = realpathSync(ctx.cwd);
		guardScratchWrite = (path) => {
			if (realpathSync(ctx.cwd) !== scratch) throw new Error("Coordinator scratch root alias denied");
			const target = contained(ctx.cwd, path) ? resolve(scratch, sourcePath(ctx.cwd, path)) : path;
			assertCoordinatorScratchWrite(scratch, target);
		};
		const canonical = (path: string) => {
			let existing = path;
			while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
			return resolve(realpathSync(existing), path.slice(existing.length).replace(/^\//, ""));
		};
		for (const definition of await createCoordinatorSourceTools(readScope, ctx.cwd, (path, recursive) => {
			const controller = sandbox.current();
			controller.readGuard()(path);
			if (
				controller.enforcing &&
				recursive &&
				controller.policy.denyRead.some((denied) => contained(canonical(path), canonical(denied)))
			)
				throw new Error("Coordinator search could include a configured denied read root; choose a narrower path");
		})) {
			const previous = pi.getAllTools().find((tool) => tool.name === definition.name);
			if (previous && previous.sourceInfo.path !== fileURLToPath(import.meta.url))
				throw new Error(`Coordinator source tool ${definition.name} has a sibling override`);
			// Register through the SAME first-party owner as the bundled native overrides.
			// Its sibling-override refusal and configured read denials still apply.
			pi.registerTool({ ...definition, defaultActive: false, exposure: "codemode" });
			owners.set(definition.name, pi.getAllTools().find((tool) => tool.name === definition.name)!.sourceInfo.path);
		}
		removeGuard = pi.events.on("sandbox:guard-write", (value) => {
			const request = value as { path: string; error?: Error };
			try {
				guardScratchWrite(request.path);
			} catch (error) {
				request.error ??= error as Error;
			}
		});
	});
	pi.on("tool_call", async (event, ctx) => {
		const owner = owners.get(event.toolName);
		if (owner && pi.getAllTools().find((tool) => tool.name === event.toolName)?.sourceInfo.path !== owner)
			return { block: true, reason: "Coordinator source tool has a sibling override; refusing unchecked execution" };
		if (["write", "edit", "applyPatch"].includes(event.toolName)) {
			try {
				const scope = await readScope(ctx.signal);
				if (scope.scratch !== realpathSync(ctx.cwd)) throw new Error("Coordinator scratch role changed");
				if (event.toolName !== "applyPatch") {
					const input = event.input as Record<string, unknown>;
					if (typeof input.path !== "string") throw new Error("Coordinator write needs a scratch path");
					guardScratchWrite(input.path);
				}
			} catch (error) {
				return { block: true, reason: (error as Error).message };
			}
		}
	});
	pi.on("session_shutdown", async () => {
		removeGuard?.();
		removeGuard = undefined;
		owners.clear();
		await sandbox.close();
	});
}
