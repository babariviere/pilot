/** Read-only Git-compatible untracked numstat, with bounded buffers and metadata reuse. */
import {
	type BigIntStats,
	constants,
	closeSync,
	fstatSync,
	lstatSync,
	openSync,
	readlinkSync,
	readSync,
} from "node:fs";
import { resolve } from "node:path";
import { parentPort } from "node:worker_threads";
import type { LineStat, UntrackedFile } from "./untracked-stats.ts";

const buffer = Buffer.alloc(64 * 1024);
const cache = new Map<string, { version: string; stat: LineStat }>();
const MAX_ENTRIES = 1024;
const zero: LineStat = { additions: 0, deletions: 0 };
let bytesRead = 0;
const version = (info: BigIntStats) =>
	`${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;

function count(cwd: string, file: UntrackedFile): LineStat {
	const path = resolve(cwd, file.path);
	const info = lstatSync(path, { bigint: true });
	const key = `${file.binary}:${file.bigFileThreshold}:${path}`;
	const stamp = version(info);
	const cached = cache.get(key);
	if (cached?.version === stamp) {
		cache.delete(key);
		cache.set(key, cached);
		return cached.stat;
	}
	let stat: LineStat;
	if (info.isSymbolicLink()) {
		// Git diffs the link's text, not its destination (including broken or external links).
		const target = readlinkSync(path, { encoding: "buffer" });
		stat = { additions: target.filter((byte) => byte === 10).length + (target.at(-1) === 10 ? 0 : 1), deletions: 0 };
	} else {
		if (!info.isFile()) throw new Error(`Untracked path is not a regular file: ${file.path}`);
		const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			if (version(fstatSync(fd, { bigint: true })) !== stamp)
				throw new Error(`Untracked file changed: ${file.path}`);
			let lines = 0;
			let offset = 0;
			let last = 10;
			let binary = file.binary === "binary" || (file.binary === "auto" && info.size > BigInt(file.bigFileThreshold));
			while (!binary && offset < Number(info.size)) {
				const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, Number(info.size) - offset), offset);
				if (!bytes) break;
				bytesRead += bytes;
				// Git's automatic binary test checks only the first 8,000 bytes for NUL.
				if (
					file.binary === "auto" &&
					offset < 8000 &&
					buffer.subarray(0, Math.min(bytes, 8000 - offset)).includes(0)
				) {
					binary = true;
					break;
				}
				for (let i = 0; i < bytes; i++) if (buffer[i] === 10) lines++;
				last = buffer[bytes - 1]!;
				offset += bytes;
			}
			stat = binary ? zero : { additions: lines + (last === 10 ? 0 : 1), deletions: 0 };
			if (version(fstatSync(fd, { bigint: true })) !== stamp)
				throw new Error(`Untracked file changed: ${file.path}`);
		} finally {
			closeSync(fd);
		}
	}
	// Do not cache data from a write/rename that raced the scan.
	if (version(lstatSync(path, { bigint: true })) !== stamp) throw new Error(`Untracked file changed: ${file.path}`);
	cache.delete(key);
	cache.set(key, { version: stamp, stat });
	while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
	return stat;
}

parentPort!.on("message", ({ id, cwd, files }: { id: number; cwd: string; files: UntrackedFile[] }) => {
	const before = bytesRead;
	try {
		const stats = files.map((file) => count(cwd, file));
		parentPort!.postMessage({ id, stats, bytesRead: bytesRead - before });
	} catch (error) {
		parentPort!.postMessage({
			id,
			bytesRead: bytesRead - before,
			error: error instanceof Error ? error.message : String(error),
		});
	}
});
