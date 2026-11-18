import { constants } from "node:fs";
import { lstat, open, opendir, rm } from "node:fs/promises";
import { join } from "node:path";

/** Caller must own this private tree and exclude live writers. Never follows links to repair permissions. */
export async function discardDirectory(path: string): Promise<void> {
	try {
		await rm(path, { recursive: true, force: true });
	} catch (error) {
		if (!["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
		await writableDirectories(path);
		await rm(path, { recursive: true, force: true });
	}
}

async function writableDirectories(path: string): Promise<void> {
	const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
		return undefined;
	});
	if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
	// chmod through a non-following descriptor, not a path that could resolve to a linked target.
	const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		const current = await directory.stat();
		if (current.dev !== stat.dev || current.ino !== stat.ino)
			throw new Error("Private directory changed during discard");
		if (current.uid !== process.getuid?.()) throw new Error("Private directory is owned by another user");
		await directory.chmod(current.mode | 0o700);
		for await (const entry of await opendir(path)) {
			if (entry.isDirectory() && !entry.isSymbolicLink()) await writableDirectories(join(path, entry.name));
		}
	} finally {
		await directory.close();
	}
}
