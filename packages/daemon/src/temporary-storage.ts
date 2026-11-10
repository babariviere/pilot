/** Exact abandoned atomic-write files only. No recursive deletion or generic *.tmp matching. */
import { lstat, opendir, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

export const TEMPORARY_RETENTION_MS = 7 * 86_400_000;
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const sessionTemporary = new RegExp(`^(?:meta|ai-usage)\\.json\\.${uuid}\\.tmp$`, "i");
const homeTemporary = new RegExp(
	`^(?:projects|chat-settings|connectivity|power-pause|power-settings|reviews)\\.json\\.${uuid}\\.tmp$`,
	"i",
);

async function canonicalDirectory(path: string): Promise<boolean> {
	try {
		return (await lstat(path)).isDirectory() && (await realpath(path)) === resolve(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export async function abandonedAtomicFiles(
	directory: string,
	scope: "home" | "session",
	now: number,
): Promise<string[]> {
	if (!(await canonicalDirectory(directory))) return [];
	const pattern = scope === "home" ? homeTemporary : sessionTemporary;
	const paths: string[] = [];
	let visited = 0;
	for await (const entry of await opendir(directory)) {
		if (++visited > 10_000 || paths.length >= 64) break;
		if (!entry.isFile() || !pattern.test(entry.name)) continue;
		const path = join(directory, entry.name);
		const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
		if (info?.isFile() && info.nlink === 1 && Math.max(info.mtimeMs, info.ctimeMs) <= now - TEMPORARY_RETENTION_MS)
			paths.push(path);
	}
	return paths;
}

/** Call only under the session's maintenance hold, after worker/child exit. */
export async function cleanTemporaryStorage(
	directory: string,
	scope: "home" | "session",
	now: number,
	assertSafe: () => void,
): Promise<void> {
	for (const path of await abandonedAtomicFiles(directory, scope, now)) {
		if (!(await canonicalDirectory(directory))) return;
		const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
		assertSafe();
		if (info?.isFile() && info.nlink === 1 && Math.max(info.mtimeMs, info.ctimeMs) <= now - TEMPORARY_RETENTION_MS)
			await unlink(path);
	}
}
