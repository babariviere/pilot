/** Read canonical executable configuration without the SDK's adjacent write lock.
 * Never reads through a live writer lock or accepts a torn/replaced file. Writes are denied.
 */

import { closeSync, constants, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, SettingsManager, type SettingsManagerCreateOptions } from "@earendil-works/pi-coding-agent";

const LIMIT = 4 * 1024 * 1024;
const unavailable = () =>
	new Error("Read-only settings unavailable or changing. Retry after the configuration update finishes.");
function read(path: string): string | undefined {
	if (existsSync(`${path}.lock`)) throw unavailable();
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" && !existsSync(`${path}.lock`)) return undefined;
		throw unavailable();
	}
	try {
		const before = fstatSync(fd, { bigint: true });
		if (!before.isFile() || before.size > BigInt(LIMIT)) throw unavailable();
		const bytes = Buffer.alloc(Number(before.size) + 1);
		const count = readSync(fd, bytes, 0, bytes.length, 0);
		const after = statSync(path, { bigint: true });
		if (
			count !== Number(before.size) ||
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.size !== after.size ||
			before.mtimeNs !== after.mtimeNs ||
			before.ctimeNs !== after.ctimeNs ||
			existsSync(`${path}.lock`)
		)
			throw unavailable();
		const value = bytes.subarray(0, count).toString("utf8");
		const parsed = JSON.parse(value.replace(/^\uFEFF/, ""));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw unavailable();
		return value;
	} finally {
		closeSync(fd);
	}
}

export function readonlySettings(
	cwd: string,
	agentDir: string,
	options: SettingsManagerCreateOptions = {},
): SettingsManager {
	let readFailed = false;
	const storage: Parameters<typeof SettingsManager.fromStorage>[0] = {
		withLock(scope, fn) {
			let next: string | undefined;
			try {
				next = fn(read(join(scope === "global" ? agentDir : join(cwd, CONFIG_DIR_NAME), "settings.json")));
			} catch {
				readFailed = true;
				throw unavailable();
			}
			if (next !== undefined) throw new Error("Executable settings are read-only in this worker");
		},
	};
	const manager = SettingsManager.fromStorage(storage, options);
	if (manager.drainErrors().length) throw unavailable();
	const reload = manager.reload.bind(manager);
	manager.reload = async () => {
		await manager.flush();
		readFailed = false;
		await reload();
		if (readFailed) throw unavailable();
	};
	return manager;
}
