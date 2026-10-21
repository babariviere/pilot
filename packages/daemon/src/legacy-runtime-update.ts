import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";

/** Read-only safety fence. Never repair, resume, clear or replace a former updater's ownership. */
export async function legacyRuntimeUpdateFrozen(home: string): Promise<boolean> {
	const directory = join(home, "runtime-update");
	const path = join(directory, "current.json");
	let file: Awaited<ReturnType<typeof open>>;
	try {
		const parent = await lstat(directory);
		if (!parent.isDirectory() || parent.uid !== process.getuid?.() || parent.mode & 0o077) return true;
		file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
	try {
		const info = await file.stat();
		if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077 || info.size > 128 * 1024) return true;
		const buffer = Buffer.alloc(128 * 1024 + 1);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		const current = await lstat(path);
		if (
			bytesRead !== info.size ||
			current.ino !== info.ino ||
			current.dev !== info.dev ||
			current.size !== info.size ||
			current.mtimeMs !== info.mtimeMs ||
			current.ctimeMs !== info.ctimeMs
		)
			return true;
		const record = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
		return (
			record?.schema !== 1 ||
			!/^[a-f0-9-]{36}$/.test(record.id) ||
			!Number.isSafeInteger(record.revision) ||
			record.revision < 1 ||
			!Array.isArray(record.blockers) ||
			record.blockers.length > 1024 ||
			!["completed", "cancelled"].includes(record.phase) ||
			![
				"daemonId",
				"lineageId",
				"version",
				"from",
				"to",
				"oldUnit",
				"newUnit",
				"archive",
				"manifest",
				"signature",
				"publicKey",
			].every((key) => typeof record[key] === "string" && record[key].length > 0)
		);
	} catch {
		return true;
	} finally {
		await file.close();
	}
}
