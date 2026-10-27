/** Short-lived packaged launcher. No credential/package/extension loading; no PID-based signals. */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "./config.ts";
import { runtimeBuild } from "./runtime-bootstrap.ts";
import { inspectRuntime, type RuntimeBuild, RuntimeFailure } from "./runtime-owner.ts";

export type CleanupDisposition = "no-owned-child" | "preactivation-reaped" | "activation-possible" | "unconfirmed";

export async function launchRuntime(options: {
	home: string;
	port: number;
	build: RuntimeBuild;
	/** Packaged CLI pins the actual immutable module root, not only its source tuple. */
	runtimeRoot?: string;
	entry: string;
	signal?: AbortSignal;
	timeout?: number;
	env?: NodeJS.ProcessEnv;
	/** Synthetic fixtures retain the actual owned child handle, never a PID from disk. */
	onSpawn?: (child: ChildProcess) => void;
	onCleanup?: (disposition: CleanupDisposition) => void;
}): Promise<"reused" | "started"> {
	const { home, port, build, signal } = options;
	options.onCleanup?.("no-owned-child");
	const deadline = Date.now() + (options.timeout ?? 20_000);
	if (signal?.aborted) throw new RuntimeFailure("runtime_startup_canceled");
	if (existsSync(home)) {
		const status = await inspectRuntime(home, port, build, options.runtimeRoot);
		if (status === "ready") return "reused";
		if (status === "starting") {
			while (Date.now() < deadline && !signal?.aborted) {
				await delay(100, undefined, { signal });
				if ((await inspectRuntime(home, port, build, options.runtimeRoot)) === "ready") return "reused";
			}
			throw new RuntimeFailure("runtime_owner_still_starting");
		}
	}
	options.onCleanup?.("unconfirmed");
	const child = spawn(process.execPath, [options.entry, "--bundled-runtime"], {
		cwd: dirname(options.entry),
		env: { ...options.env, PILOT_HOME: home, PILOT_PORT: String(port) },
		detached: true,
		stdio: ["ignore", "ignore", "ignore", "ipc"],
	});
	let committed = false,
		exited = false,
		spawnFailed = false;
	const lost = () => {
		exited = true;
	};
	child.once("exit", lost);
	child.once("error", () => {
		spawnFailed = true;
		exited = true;
	});
	try {
		options.onSpawn?.(child);
		await new Promise<void>((ok, reject) => {
			let settled = false;
			const timer = setTimeout(
				() => finish(new RuntimeFailure("runtime_ownership_timeout")),
				Math.min(10_000, Math.max(1, deadline - Date.now())),
			);
			const abort = () => finish(new RuntimeFailure("runtime_startup_canceled"));
			const died = () => finish(new RuntimeFailure("runtime_launch_failed"));
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				child.removeListener("exit", died);
				child.removeListener("error", died);
				if (error) reject(error);
				else ok();
			};
			signal?.addEventListener("abort", abort, { once: true });
			child.once("exit", died);
			child.once("error", died);
			child.once("message", (message) => {
				if (settled) return;
				if (message !== "owned" || signal?.aborted) {
					finish(new RuntimeFailure("runtime_ownership_invalid"));
					return;
				}
				// Once activation might have reached the child, cancellation must NOT kill a
				// daemon that may already be restoring active durable work.
				committed = true;
				child.send("activate", (error) =>
					finish(error ? new RuntimeFailure("runtime_activation_unconfirmed") : undefined),
				);
			});
		});
		while (Date.now() < deadline && !signal?.aborted) {
			if (exited) throw new RuntimeFailure("runtime_launch_failed");
			const status = await inspectRuntime(home, port, build, options.runtimeRoot);
			if (status === "ready") return "started";
			await delay(100, undefined, { signal });
		}
		throw new RuntimeFailure(signal?.aborted ? "runtime_startup_canceled" : "runtime_startup_unconfirmed");
	} catch (error) {
		if (signal?.aborted) throw new RuntimeFailure("runtime_startup_canceled");
		if (spawnFailed) throw new RuntimeFailure("runtime_launch_failed");
		throw error;
	} finally {
		if (child.connected) child.disconnect();
		if (!committed && !exited) {
			// Exact ChildProcess handle only, and only before migration/restore activation.
			child.kill("SIGKILL");
			await new Promise<void>((ok) => child.once("exit", () => ok()));
		}
		child.unref();
		options.onCleanup?.(committed ? "activation-possible" : spawnFailed ? "no-owned-child" : "preactivation-reaped");
	}
}

/** Actual CLI lifetime protocol, also used by isolated nested-child fixtures. */
export async function serveLauncher(options: Parameters<typeof launchRuntime>[0]): Promise<void> {
	const controller = new AbortController();
	let cleanup: CleanupDisposition = "no-owned-child";
	const abort = () => controller.abort();
	process.once("SIGTERM", abort);
	process.once("SIGINT", abort);
	// The app owns this input pipe. App exit/worker cancellation closes it, even
	// when the app cannot run destructors. Never activate after an observed EOF.
	process.stdin.once("end", abort);
	process.stdin.on("data", abort);
	process.stdin.resume();
	try {
		const result = await launchRuntime({
			...options,
			signal: controller.signal,
			onCleanup: (value) => {
				cleanup = value;
				options.onCleanup?.(value);
			},
		});
		process.stdout.write(`${JSON.stringify({ schema: 1, result, cleanup })}\n`);
	} catch (error) {
		process.stdout.write(
			`${JSON.stringify({ schema: 1, error: error instanceof RuntimeFailure ? error.reason : "runtime_startup_failed", cleanup })}\n`,
		);
		process.exitCode = 1;
	} finally {
		process.removeListener("SIGTERM", abort);
		process.removeListener("SIGINT", abort);
		process.stdin.removeListener("end", abort);
		process.stdin.removeListener("data", abort);
		process.stdin.destroy();
	}
}
async function main(): Promise<void> {
	const build = await runtimeBuild();
	if (!build) throw new RuntimeFailure("runtime_build_missing");
	const config = loadConfig();
	const entry = join(dirname(fileURLToPath(import.meta.url)), "main.ts");
	await serveLauncher({
		home: config.home,
		port: config.port,
		build,
		entry,
		runtimeRoot: await realpath(fileURLToPath(new URL("../../../", import.meta.url))),
		env: process.env,
	});
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	main().catch((error) => {
		process.stdin.destroy();
		// No daemon output, profile paths, environment, credentials or raw exception text.
		process.stdout.write(
			`${JSON.stringify({
				schema: 1,
				error: error instanceof RuntimeFailure ? error.reason : "runtime_startup_failed",
				cleanup: "unconfirmed",
			})}\n`,
		);
		process.exitCode = 1;
	});
}
