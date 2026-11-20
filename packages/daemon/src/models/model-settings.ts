/** SDK settings snapshots and Pilot's edits of Pi's global settings.json. Lock waits and file I/O must never busy-spin the daemon. */
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

export function agentSettingsFile(agentDir: string): string {
	return join(settingsPath(agentDir), "settings.json");
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
		snapshot(agentSettingsFile(agentDir), signal),
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

/** The settings text, or undefined when the file is absent. A dangling settings symlink is unreadable, not absent. */
export async function readSettingsFile(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const link = await lstat(path).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
		if (link) throw new Error("Unreadable settings");
		return undefined;
	}
}

/** The rename of an edit started, so settings.json may hold the new text. */
export class SettingsMayHaveChanged extends Error {
	constructor(cause: unknown) {
		super("Settings write could not be confirmed", { cause });
	}
}

/**
 * Edits Pi's global settings.json under the SDK's write lock. `change` gets the current text ("{}\n" when absent) and
 * returns the next text, or undefined to leave the file alone. The file keeps its mode, and an existing settings
 * symlink keeps pointing at its target, which is replaced atomically like the SDK does.
 */
export async function editAgentSettings(agentDir: string, change: (text: string) => string | undefined): Promise<void> {
	const path = agentSettingsFile(agentDir);
	let mayHaveWritten = false;
	try {
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		await withModelSettingsLock(
			path,
			async (assertOwned) => {
				const before = (await readSettingsFile(path)) ?? "{}\n";
				assertOwned();
				const next = change(before);
				if (next === undefined) return;
				let destination = path;
				try {
					destination = await realpath(path);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					const link = await lstat(path).catch((error: NodeJS.ErrnoException) => {
						if (error.code !== "ENOENT") throw error;
					});
					if (link) throw new Error("Cannot edit unresolved global settings symlink");
				}
				const mode = await stat(destination).then(
					(info) => info.mode & 0o777,
					() => 0o600,
				);
				const temporary = `${destination}.${randomUUID()}.tmp`;
				try {
					const file = await open(temporary, "wx", mode);
					try {
						await file.writeFile(next);
						await file.sync();
					} finally {
						await file.close();
					}
					await chmod(temporary, mode);
					assertOwned();
					mayHaveWritten = true;
					await rename(temporary, destination);
					const directory = await open(dirname(destination), "r");
					try {
						await directory.sync();
					} finally {
						await directory.close();
					}
				} finally {
					await rm(temporary, { force: true });
				}
			},
			undefined,
			true,
		);
	} catch (error) {
		if (mayHaveWritten) throw new SettingsMayHaveChanged(error);
		throw error;
	}
}

/** Valid JSON has already been checked. Locate root member spans without reserializing other settings. */
function members(text: string): Array<{ key: string; start: number; end: number; comma?: number }> {
	const result: ReturnType<typeof members> = [];
	const tokens = /"(?:[^"\\]|\\.)*"|[{}[\],:]|[^\s{}[\],:]+/g;
	let depth = 0;
	let member: (typeof result)[number] | undefined;
	let key = true;
	for (const token of text.matchAll(tokens)) {
		const value = token[0];
		if (depth === 1 && key && value.startsWith('"')) {
			member = { key: JSON.parse(value), start: token.index, end: token.index + value.length };
			result.push(member);
			key = false;
		}
		if (depth === 1 && value === ",") {
			if (member) member.comma = token.index;
			key = true;
		} else if (member && !(depth === 1 && value === "}")) member.end = token.index + value.length;
		if (value === "{" || value === "[") depth++;
		if (value === "}" || value === "]") depth--;
	}
	return result;
}

/** Sets (or, for null, deletes) one root key and keeps every other byte of the settings text. */
export function editModelSetting(text: string, key: string, value: unknown): string {
	const entries = members(text);
	// Work backwards so duplicate keys are handled too, without invalidating earlier offsets.
	const found = entries.filter((entry) => entry.key === key);
	if (value !== null && !found.length) {
		const end = text.lastIndexOf("}");
		return `${text.slice(0, end)}${entries.length ? "," : ""}\n  ${JSON.stringify(key)}: ${JSON.stringify(value)}\n${text.slice(end)}`;
	}
	if (value === null) {
		// Delete one at a time and re-scan: adjacent duplicate keys may share their separating comma.
		const entry = found.at(-1);
		if (!entry) return text;
		const previous = entries[entries.indexOf(entry) - 1];
		const start = entry.comma === undefined && previous?.comma !== undefined ? previous.comma : entry.start;
		const end = entry.comma === undefined ? entry.end : entry.comma + 1;
		return editModelSetting(text.slice(0, start) + text.slice(end), key, null);
	}
	for (const entry of found.reverse()) {
		const colon = text.indexOf(":", entry.start + JSON.stringify(entry.key).length);
		const start = colon + 1 + (text.slice(colon + 1).match(/^\s*/)?.[0].length ?? 0);
		text = text.slice(0, start) + JSON.stringify(value) + text.slice(entry.end);
	}
	return text;
}
