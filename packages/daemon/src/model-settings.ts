/** SDK settings snapshots. Lock waits and file I/O must never busy-spin the daemon. */
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, SettingsManager } from "@earendil-works/pi-coding-agent";

// Use the SDK's own lock implementation/version, matching FileSettingsStorage's lock paths and stale handling.
const lockfile = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("proper-lockfile") as {
	lock(
		path: string,
		options: { realpath: false; onCompromised: (error: Error) => void },
	): Promise<() => Promise<void>>;
};

/**
 * proper-lockfile's default throws from a timer, which crashes pilotd whenever the event loop stalls past the
 * stale threshold. This lock only guards a read snapshot, so losing it is harmless: log and continue.
 */
function onCompromised(error: Error): void {
	console.warn(`pilotd: settings lock compromised during read: ${error.message}`);
}

export function settingsPath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
	return resolve(path.startsWith("file://") ? fileURLToPath(path) : path);
}

/** Same lock path/version/retry policy as FileSettingsStorage, without its synchronous busy wait. */
export async function withModelSettingsLock<T>(
	path: string,
	work: (assertOwned: () => void) => Promise<T>,
	signal?: AbortSignal,
	write = false,
): Promise<T> {
	let release: (() => Promise<void>) | undefined;
	let compromised: Error | undefined;
	for (let attempt = 1; attempt <= 10; attempt++) {
		signal?.throwIfAborted();
		try {
			release = await lockfile.lock(path, {
				realpath: false,
				onCompromised: (error) => {
					compromised = error;
					if (!write) onCompromised(error);
				},
			});
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || attempt === 10) throw error;
			await delay(20, undefined, { signal });
		}
	}
	const assertOwned = () => {
		signal?.throwIfAborted();
		if (write && compromised) throw new Error("Settings write lock was lost");
	};
	try {
		return await work(assertOwned);
	} finally {
		await release?.().catch(() => undefined);
	}
}

async function snapshot(path: string, signal?: AbortSignal): Promise<string | undefined> {
	try {
		try {
			await stat(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		return await withModelSettingsLock(path, () => readFile(path, { encoding: "utf8", signal }), signal);
	} catch (error) {
		// Do not let the SDK's per-scope fallback turn transient I/O/lock failures into
		// empty settings, which would silently expand the user's enabled model scope.
		throw error instanceof Error ? error : new Error(String(error));
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
			if (read(current) !== undefined) throw new Error("Model settings snapshots are read-only");
		},
	});
}
