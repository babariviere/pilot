import { lstat, opendir, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { SessionPathCandidates } from "@pilot/protocol";
import { Conflict, ServiceUnavailable } from "./errors.ts";
import { scopedPath } from "./repository-browser.ts";

/** Only literal relative prefixes. No shell expansion, traversal, links or alternate roots. */
export function completionPrefix(prefix: string): { parent: string; name: string } {
	if (
		!prefix ||
		prefix.length > 1024 ||
		/[\x00-\x1f\x7f\\]/u.test(prefix) ||
		prefix.startsWith("/") ||
		prefix.startsWith("~") ||
		prefix.includes("://")
	)
		throw new Error("Invalid path prefix");
	const parts = prefix.split("/");
	const name = parts.pop()!;
	if (parts.some((p) => !p || p === "." || p === "..") || name === "." || name === "..")
		throw new Error("Invalid path prefix");
	return { parent: parts.join("/"), name };
}

export class PathCompletionReader {
	private active = 0;
	async read(cwd: string, prefix: string): Promise<Pick<SessionPathCandidates, "entries" | "truncated">> {
		if (!isAbsolute(cwd) || cwd.includes("\0")) throw new Conflict("Completion workspace is unavailable");
		const { parent, name } = completionPrefix(prefix);
		if (this.active >= 2) throw new ServiceUnavailable("Path completion reads are busy");
		this.active++;
		try {
			const rootPath = cwd.replace(/\/+$/u, "") || "/";
			const rootBefore = await lstat(rootPath);
			if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink())
				throw new Conflict("Completion workspace is not a directory");
			const path = await scopedPath(cwd, parent, true);
			const before = await stat(path);
			const dir = await opendir(path);
			const entries: SessionPathCandidates["entries"] = [];
			let scanned = 0;
			let truncated = false;
			for await (const entry of dir) {
				if (++scanned > 512) {
					truncated = true;
					break;
				}
				if (
					!entry.name.startsWith(name) ||
					(entry.name.startsWith(".") && !name.startsWith(".")) ||
					(!entry.isFile() && !entry.isDirectory()) ||
					entry.name.length > 255 ||
					/[\x00-\x1f\x7f\\]/u.test(entry.name)
				)
					continue;
				const candidate = (parent ? `${parent}/` : "") + entry.name;
				entries.push({ path: candidate, directory: entry.isDirectory() });
				if (entries.length === 8) {
					truncated = true;
					break;
				}
			}
			const afterPath = await scopedPath(cwd, parent, true);
			const after = await stat(afterPath);
			const rootAfter = await lstat(rootPath);
			if (
				path !== afterPath ||
				before.dev !== after.dev ||
				before.ino !== after.ino ||
				!rootAfter.isDirectory() ||
				rootBefore.dev !== rootAfter.dev ||
				rootBefore.ino !== rootAfter.ino
			)
				throw new Conflict("Completion directory changed during read");
			entries.sort((a, b) => a.path.localeCompare(b.path));
			return { entries, truncated };
		} finally {
			this.active--;
		}
	}
}
