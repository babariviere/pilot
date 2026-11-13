#!/usr/bin/env node
/** Explicit user-run recovery for the pre-global-update daemon. Never replays native apply. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, rename } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { inspectRuntime, type RuntimeBuild } from "../packages/daemon/src/runtime-owner.ts";
import { digest, nativeAction, type Selection, verifyApp } from "./day-install.ts";

const legacySource = "bf005fd7d6ee1d0c1c5feabd102a9a6296b6d0dd";
const legacyServerHash = "3e21e0e96ca8816cf8c2dc9f763d8674e21fb3c29339844e15194e006871f809";
const label = "com.babariviere.pilot.daemon";
const run = (command: string, args: string[]) =>
	execFileSync(command, args, { encoding: "utf8", timeout: 130_000, stdio: ["ignore", "pipe", "pipe"] });
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));

async function privateBytes(path: string) {
	const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const st = await f.stat();
		assert.ok(st.isFile() && st.uid === process.getuid?.() && !(st.mode & 0o077) && st.size <= 1024 * 1024);
		return await f.readFile("utf8");
	} finally {
		await f.close();
	}
}
const privateJSON = async (path: string) => JSON.parse(await privateBytes(path));
async function durableNew(path: string, bytes: string) {
	const f = await open(path, "wx", 0o600);
	try {
		await f.writeFile(bytes);
		await f.sync();
	} finally {
		await f.close();
	}
	const dir = await open(resolve(path, ".."), "r");
	try {
		await dir.sync();
	} finally {
		await dir.close();
	}
}
async function exists(path: string) {
	try {
		await lstat(path);
		return true;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw e;
	}
}
async function until(check: () => Promise<boolean>, ms: number) {
	const end = Date.now() + ms;
	while (!(await check())) {
		assert.ok(Date.now() < end, "Timed out. Keep all files; inspect recovery, never repeat stop/start.");
		await delay(250);
	}
}

/** Test seam for the actual one-shot order. Evidence is separate from the original handoff. */
export async function recoverOnce(
	directory: string,
	host: {
		prepare(): Promise<unknown>;
		stop(): Promise<void>;
		stopped(): Promise<void>;
		replace(): Promise<void>;
		start(): Promise<void>;
		verify(): Promise<unknown>;
	},
) {
	const entry = join(directory, "legacy-recovery-entered.json");
	if (await exists(entry)) {
		return {
			state: "observed",
			entered: await privateJSON(entry),
			complete: (await exists(join(directory, "legacy-recovery-complete.json")))
				? await privateJSON(join(directory, "legacy-recovery-complete.json"))
				: null,
			replayed: false,
		};
	}
	const evidence = await host.prepare();
	await durableNew(entry, JSON.stringify(evidence)); // Exclusive before any shutdown; repeats only observe.
	await host.stop();
	await host.stopped();
	await durableNew(join(directory, "legacy-recovery-stopped.json"), JSON.stringify({ evidence }));
	await host.replace();
	await durableNew(join(directory, "legacy-recovery-starting.json"), JSON.stringify({ evidence }));
	await host.start(); // Exactly once. No retry, automatic rollback, resume or retirement.
	const successor = await host.verify();
	const result = { state: "successor-verified", evidence, successor, originalHandoff: "not-completed" };
	await durableNew(join(directory, "legacy-recovery-complete.json"), JSON.stringify(result));
	return result;
}

async function recovery(s: Selection, inspectOnly: boolean) {
	assert.equal(process.platform, "darwin");
	assert.equal(s.sourceProfile, s.targetProfile, "Keep the same profile");
	assert.equal(await realpath(s.targetProfile), s.targetProfile);
	assert.deepEqual(await privateJSON(join(s.installDirectory, "handoff-entered.json")), s);
	assert.deepEqual(await privateJSON(join(s.installDirectory, "selection.json")), s);
	const app = join(s.installDirectory, "Pilot Next.app");
	await verifyApp(s, app);
	const originalPath = join(s.targetProfile, `.day-daemon-handoff-${s.operationId}.json`);
	const originalHash = await digest(originalPath);
	const observation = nativeAction(s, "inspect", app);
	const record = observation.record as Record<string, any>;
	assert.equal(observation.state, "observed");
	assert.equal(record.state, "entered");
	assert.equal(record.operation.operationId, s.operationId);
	assert.equal(
		record.preflight.previousBuild.source,
		legacySource,
		"This recovery supports only the diagnosed legacy runtime",
	);
	for (const key of ["complete", "release", "releaseReceipt", "service"]) assert.equal(observation[key], null);
	assert.deepEqual(observation.retirement, {});
	const plist = join(process.env.HOME!, "Library/LaunchAgents", `${label}.plist`);
	const service = `gui/${process.getuid!()}/${label}`;
	const originalBytes = await readFile(plist, "utf8");
	const definition = JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist]));
	const old = record.preflight;
	const runtime = join(app, "Contents/Resources/runtime");
	const build: RuntimeBuild = await json(join(runtime, "runtime-build.json"));
	const oldOwner = await privateJSON(join(s.targetProfile, ".daemon-owner.json"));
	const lease = await lstat(join(s.targetProfile, ".daemon-owner.sqlite"));
	const unchanged = async () => {
		assert.equal(await digest(originalPath), originalHash, "Original handoff changed");
		assert.deepEqual(await privateJSON(join(s.installDirectory, "handoff-entered.json")), s);
		assert.equal((await readFile(join(s.targetProfile, "daemon-id"), "utf8")).trim(), s.daemonId);
		assert.equal((await readFile(join(s.targetProfile, "storage-lineage"), "utf8")).trim(), s.lineageId);
		const now = await lstat(join(s.targetProfile, ".daemon-owner.sqlite"));
		assert.equal(now.ino, lease.ino, "Permanent lease changed");
		assert.equal(now.dev, lease.dev);
	};
	const servicePID = (node: string) => {
		const text = run("/bin/launchctl", ["print", service]);
		assert.ok(
			text.split("\n").some((l) => l.trim() === `program = ${node}`),
			"Loaded executable differs",
		);
		assert.ok(
			text.split("\n").some((l) => l.trim() === `path = ${plist}`),
			"Loaded definition differs",
		);
		const pid = /^\s*pid = (\d+)\s*$/m.exec(text)?.[1];
		assert.ok(pid, "Missing service PID");
		return Number(pid);
	};
	const owner = () => privateJSON(join(s.targetProfile, ".daemon-owner.json"));
	const host = {
		async prepare() {
			assert.ok(!inspectOnly, "Inspection never enters recovery");
			assert.equal(await digest(join(old.previousRuntime, "packages/daemon/src/server.ts")), legacyServerHash);
			assert.equal(oldOwner.pid, old.pid);
			assert.equal(oldOwner.boot, old.boot);
			assert.equal(oldOwner.runtimeRoot, old.previousRuntime);
			assert.deepEqual(oldOwner.build, old.previousBuild);
			assert.equal(definition.Label, label);
			assert.equal(definition.PilotNextManaged, true);
			assert.equal(
				definition.EnvironmentVariables.PILOT_HOME ?? join(process.env.HOME!, ".local/share/pilot"),
				s.targetProfile,
			);
			assert.equal(definition.EnvironmentVariables.PILOT_PORT, String(s.port));
			assert.deepEqual(definition.ProgramArguments, [
				join(old.previousRuntime, "node/bin/node"),
				join(old.previousRuntime, "packages/daemon/src/main.ts"),
			]);
			assert.deepEqual(await privateJSON(`${plist}.next-owner`), {
				schema: 1,
				profile: s.targetProfile,
				port: s.port,
			});
			assert.equal(servicePID(definition.ProgramArguments[0]), old.pid);
			assert.equal(await inspectRuntime(s.targetProfile, s.port, old.previousBuild, old.previousRuntime), "ready");
			// A later normal save belongs to this recovery, not a rewritten original capture.
			const saved = await privateBytes(s.savedState);
			const savedHash = await digest(s.savedState);
			await unchanged();
			await durableNew(join(s.installDirectory, "legacy-recovery-original.plist"), originalBytes);
			await durableNew(join(s.installDirectory, "legacy-recovery-saved-state.json"), saved);
			return {
				operationId: s.operationId,
				payloadHash: record.operation.payloadHash,
				originalHash,
				originalCaptureHash: record.captureHash,
				savedHash,
				profile: s.targetProfile,
				port: s.port,
				previous: { pid: old.pid, boot: old.boot, runtime: old.previousRuntime },
				target: { runtime, build },
				shutdown: "ordinary-launchd-SIGTERM",
				descendantExit: "unproven",
			};
		},
		async stop() {
			await unchanged();
			assert.equal(await readFile(plist, "utf8"), originalBytes);
			assert.equal(servicePID(definition.ProgramArguments[0]), old.pid);
			assert.ok(isDeepStrictEqual(await owner(), oldOwner), "Daemon owner changed");
			run("/bin/launchctl", ["bootout", service]);
		},
		async stopped() {
			await until(async () => {
				try {
					process.kill(old.pid, 0);
					return false;
				} catch (e) {
					if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
					return true;
				}
			}, 120_000);
			try {
				run("/bin/launchctl", ["print", service]);
				assert.fail("Service remains loaded");
			} catch (e) {
				assert.equal((e as { status?: number }).status, 113, "Service absence unconfirmed");
			}
			await unchanged();
			assert.equal(
				await inspectRuntime(s.targetProfile, s.port, old.previousBuild, old.previousRuntime),
				"idle",
				"Profile lease not released",
			);
			const listener = createServer();
			await new Promise<void>((accept, reject) => {
				listener.once("error", reject);
				listener.listen(s.port, "127.0.0.1", () => listener.close((e) => (e ? reject(e) : accept())));
			});
		},
		async replace() {
			await unchanged();
			await verifyApp(s, app);
			assert.equal(await readFile(plist, "utf8"), originalBytes);
			const next = structuredClone(definition);
			next.ProgramArguments = [join(runtime, "node/bin/node"), join(runtime, "packages/daemon/src/main.ts")];
			next.EnvironmentVariables.PILOT_HOME = s.targetProfile;
			next.EnvironmentVariables.PATH = [
				join(runtime, "node/bin"),
				...String(next.EnvironmentVariables.PATH)
					.split(":")
					.filter((p) => !p.endsWith("/Contents/Resources/runtime/node/bin")),
			].join(":");
			const staged = join(s.installDirectory, "legacy-recovery-next.plist");
			await durableNew(staged, JSON.stringify(next));
			run("/usr/bin/plutil", ["-convert", "xml1", staged]);
			const f = await open(staged, "r");
			try {
				await f.sync();
			} finally {
				await f.close();
			}
			// Same home volume. Keep the byte-exact old definition in the private backup.
			await rename(staged, plist);
			const dir = await open(resolve(plist, ".."), "r");
			try {
				await dir.sync();
			} finally {
				await dir.close();
			}
		},
		async start() {
			await unchanged();
			run("/bin/launchctl", ["bootstrap", `gui/${process.getuid!()}`, plist]);
		},
		async verify() {
			await until(async () => {
				try {
					return (await inspectRuntime(s.targetProfile, s.port, build, runtime)) === "ready";
				} catch {
					return false;
				}
			}, 30_000);
			const current = await owner();
			assert.notEqual(current.boot, old.boot);
			assert.equal(current.pid, servicePID(join(runtime, "node/bin/node")));
			assert.equal(current.runtimeRoot, runtime);
			assert.deepEqual(current.build, build);
			await unchanged();
			return {
				pid: current.pid,
				boot: current.boot,
				runtimeRoot: runtime,
				build,
				daemonId: s.daemonId,
				lineageId: s.lineageId,
			};
		},
	};
	const entry = join(s.installDirectory, "legacy-recovery-entered.json");
	if (inspectOnly && !(await exists(entry)))
		return { state: "not-entered", originalHandoff: observation, replayed: false };
	return recoverOnce(s.installDirectory, host);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	const [mode, path, acknowledgement] = process.argv.slice(2);
	try {
		assert.ok(
			(mode === "inspect" && !acknowledgement) ||
				(mode === "recover" && acknowledgement === "--gui-saved-and-closed"),
			"Usage: day-recover-legacy.ts inspect|recover selection.json [--gui-saved-and-closed]",
		);
		console.log(JSON.stringify(await recovery(await privateJSON(path!), mode === "inspect")));
	} catch (e) {
		console.error(
			`Recovery stopped: ${e instanceof Error ? e.message : "Unknown"}. Keep every file. Inspect only; do not rerun effects or use the old installer.`,
		);
		process.exitCode = 1;
	}
}
