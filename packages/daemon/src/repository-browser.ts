import { constants } from "node:fs";
import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { RepositoryDirectoryPage, RepositorySelection, SessionFileContent } from "@pilot/protocol";
import { ServiceUnavailable } from "./errors.ts";
import type { ProjectStore } from "./projects.ts";

const MAX_FILE = 512 * 1024;
const SCAN_LIMIT = 4096;
const PAGE_SIZE = 100;

/** Strict lexical paths plus no symlink components, anchored to a server-owned canonical root. */
export async function scopedPath(root: string, path: string, allowRoot = false): Promise<string> {
	if (
		typeof path !== "string" ||
		path.length > 4096 ||
		path.includes("\0") ||
		path.includes("\\") ||
		isAbsolute(path) ||
		(path !== "" && path.split("/").some((part) => !part || part === "." || part === "..")) ||
		(!allowRoot && path === "")
	)
		throw new Error("Invalid relative path");
	const canonicalRoot = await realpath(root);
	let current = canonicalRoot;
	for (const part of path.split("/").filter(Boolean)) {
		current = join(current, part);
		const info = await lstat(current);
		if (info.isSymbolicLink()) throw new Error("Symlinks are outside the readable scope");
	}
	const canonical = await realpath(current);
	const rel = relative(canonicalRoot, canonical);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Path escaped its scope");
	return canonical;
}

/** One shared bounded reader for all clients. No unbounded filesystem queue or recursive walking. */
export class RepositoryBrowser {
	private active = 0;
	private readonly projects: ProjectStore;
	private readonly home: string;
	constructor(projects: ProjectStore, home = homedir()) {
		this.projects = projects;
		this.home = home;
	}
	private async admitted<T>(read: () => Promise<T>): Promise<T> {
		if (this.active >= 4) throw new ServiceUnavailable("Repository reads are busy");
		this.active++;
		try {
			return await read();
		} finally {
			this.active--;
		}
	}
	private root(rootId: string): string {
		if (rootId === "home") return this.home;
		return this.projects.require(rootId).path;
	}
	async directory(selection: RepositorySelection, offset = 0): Promise<RepositoryDirectoryPage> {
		return this.admitted(async () => {
			if (!Number.isSafeInteger(offset) || offset < 0 || offset >= SCAN_LIMIT)
				throw new Error("Invalid directory offset");
			const root = this.root(selection.rootId);
			const path = await scopedPath(root, selection.path, true);
			const dir = await opendir(path);
			const entries: { name: string; path: string }[] = [];
			let seen = 0;
			let truncated = false;
			for await (const entry of dir) {
				if (++seen > SCAN_LIMIT) {
					truncated = true;
					break;
				}
				if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
				entries.push({ name: entry.name, path: selection.path ? `${selection.path}/${entry.name}` : entry.name });
			}
			// Fail closed if an agent replaced a directory with a symlink during enumeration.
			if ((await scopedPath(root, selection.path, true)) !== path)
				throw new Error("Directory changed while reading");
			entries.sort((a, b) => a.name.localeCompare(b.name));
			const page = entries.slice(offset, offset + PAGE_SIZE);
			return {
				rootId: selection.rootId,
				path: selection.path,
				entries: page,
				truncated,
				...(offset + PAGE_SIZE < entries.length ? { nextOffset: offset + PAGE_SIZE } : {}),
			};
		});
	}
	async selection(selection: RepositorySelection): Promise<string> {
		return this.admitted(async () => {
			const path = await scopedPath(this.root(selection.rootId), selection.path, true);
			if (!(await stat(path)).isDirectory()) throw new Error("Select a directory");
			return path;
		});
	}
	async file(root: string, path: string): Promise<SessionFileContent> {
		return this.admitted(async () => {
			const canonical = await scopedPath(root, path);
			const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			try {
				const opened = await handle.stat();
				if (!opened.isFile()) throw new Error("Only regular files can be viewed");
				const verify = async () => {
					if ((await scopedPath(root, path)) !== canonical) throw new Error("File scope changed");
					const current = await stat(canonical);
					if (opened.dev !== current.dev || opened.ino !== current.ino)
						throw new Error("File changed while opening");
				};
				await verify();
				const bytes = Buffer.alloc(Math.min(opened.size, MAX_FILE) + 1);
				const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
				await verify();
				const content = bytes.subarray(0, Math.min(bytesRead, MAX_FILE));
				const binary = content.includes(0);
				return {
					path,
					text: binary ? "" : content.toString("utf8"),
					binary,
					truncated: opened.size > MAX_FILE || bytesRead > MAX_FILE,
				};
			} finally {
				await handle.close();
			}
		});
	}
}
