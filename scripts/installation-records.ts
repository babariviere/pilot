import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, dirname } from "node:path";

export async function exists(path: string) {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/** Reads a regular file that only this user owns and can read, without following a link. */
export async function readPrivateFile(path: string, limit: number) {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const st = await file.stat();
		if (!(st.isFile() && st.uid === process.getuid?.() && !(st.mode & 0o077) && st.size <= limit))
			throw new Error(`Unsafe native identity file: ${basename(path)}`);
		return await file.readFile("utf8");
	} finally {
		await file.close();
	}
}

/** Create-only evidence. Keep partial files on failure: their presence prevents replay. */
export async function writeNewDurableFile(path: string, bytes: string): Promise<void> {
	const file = await open(path, "wx", 0o600);
	try {
		await file.writeFile(bytes);
		await file.sync();
	} finally {
		await file.close();
	}
	const parent = await open(dirname(path), "r");
	try {
		await parent.sync();
	} finally {
		await parent.close();
	}
}
