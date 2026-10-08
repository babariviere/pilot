/** Read-only SDK settings snapshots. Lock waits and file I/O must never busy-spin the daemon. */
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, SettingsManager } from "@earendil-works/pi-coding-agent";

// Use the SDK's own lock implementation/version, matching FileSettingsStorage's lock paths and stale handling.
const lockfile = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("proper-lockfile") as {
	lock(path: string, options: { realpath: false }): Promise<() => Promise<void>>;
};

function settingsPath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
	return resolve(path.startsWith("file://") ? fileURLToPath(path) : path);
}

async function snapshot(path: string, signal?: AbortSignal): Promise<string | undefined | Error> {
	try {
		try {
			await stat(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		let release: (() => Promise<void>) | undefined;
		// Exactly the SDK's ten lock attempts, but replace its 20 ms spin with an abortable async wait.
		for (let attempt = 1; attempt <= 10; attempt++) {
			signal?.throwIfAborted();
			try {
				release = await lockfile.lock(path, { realpath: false });
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || attempt === 10) throw error;
				await delay(20, undefined, { signal });
			}
		}
		try {
			return await readFile(path, { encoding: "utf8", signal });
		} finally {
			await release?.();
		}
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
}

export async function readModelSettings(cwd: string, agentDir: string, signal?: AbortSignal): Promise<SettingsManager> {
	signal?.throwIfAborted();
	const [global, project] = await Promise.all([
		snapshot(join(settingsPath(agentDir), "settings.json"), signal),
		snapshot(join(settingsPath(cwd), CONFIG_DIR_NAME, "settings.json"), signal),
	]);
	signal?.throwIfAborted();
	// The SDK still owns BOM handling, migrations, per-scope errors and merging. This storage cannot write.
	return SettingsManager.fromStorage({
		withLock(scope, read) {
			const current = scope === "global" ? global : project;
			if (current instanceof Error) throw current;
			if (read(current) !== undefined) throw new Error("Model settings snapshots are read-only");
		},
	});
}
