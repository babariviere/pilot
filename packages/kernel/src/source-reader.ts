/** Shared source-only reads for Ask and first-party exploration. Never loads repository code/config. */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { MAX_REDACT_CHARS, redactHistoryText } from "./history-privacy.ts";
import type { AskContext } from "./policy.ts";

const run = promisify(execFile);
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export class ReadLimitError extends Error {}

function expandHome(path: string): string {
	return path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path;
}

export function contained(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Reject traversal even when normalizing it would land back inside the source. */
export function sourcePath(source: string, path: string): string {
	if (path.length > 4096) throw new Error("Ask path exceeds the 4096 character limit");
	if (path.includes("\0") || path.split(/[\\/]/).includes("..")) throw new Error("Ask path traversal denied");
	const absolute = resolve(source, path);
	if (!contained(source, absolute)) throw new Error("Ask paths must stay inside the source");
	return relative(source, absolute).split(sep).join("/");
}

/** Source content only, never control metadata (including case-insensitive filesystem aliases). */
export function sourceContentPath(root: string, path: string): string {
	const rel = sourcePath(root, path);
	if (rel.split("/").some((part) => [".git", ".jj"].includes(part.toLowerCase())))
		throw new Error("Coordinator source inspection does not grant repository metadata access");
	return rel;
}

/** Path preflight, not descriptor-anchored traversal. Final opens use O_NOFOLLOW; ancestors can still race. */
async function checkedPath(
	root: string,
	path: string,
	signal?: AbortSignal,
	canonicalRootRequired = false,
): Promise<string> {
	signal?.throwIfAborted();
	const rel = sourcePath(root, path);
	const canonicalRoot = await realpath(root);
	if (canonicalRootRequired && canonicalRoot !== resolve(root))
		throw new Error("Coordinator source root alias denied");
	let current = canonicalRoot;
	for (const part of rel.split("/").filter(Boolean)) {
		signal?.throwIfAborted();
		current = join(current, part);
		if ((await lstat(current)).isSymbolicLink()) throw new Error("Ask does not follow symlinks");
	}
	if (!contained(canonicalRoot, await realpath(current))) throw new Error("Ask symlink escape denied");
	return current;
}

export async function readLocal(
	root: string,
	path: string,
	signal?: AbortSignal,
	maxBytes = MAX_FILE_BYTES,
	sourceOnly = false,
): Promise<Buffer> {
	const absolute = await checkedPath(root, path, signal, sourceOnly);
	const expected = sourceOnly ? await lstat(absolute) : undefined;
	const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = await file.stat();
		if (!stat.isFile()) throw new Error("Ask can only read regular files");
		if (expected && (expected.dev !== stat.dev || expected.ino !== stat.ino))
			throw new Error("Coordinator source path changed during open; retry");
		if (sourceOnly && stat.nlink !== 1) throw new Error("Coordinator source hardlink alias denied");
		if (stat.size > maxBytes)
			throw new ReadLimitError(`Ask file exceeds the ${maxBytes} byte read limit (default 16 MiB)`);
		// Bounded reads even if another process grows the file after stat().
		const buffer = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
		let length = 0;
		while (length < buffer.length) {
			signal?.throwIfAborted();
			const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
			if (!bytesRead) break;
			length += bytesRead;
		}
		signal?.throwIfAborted();
		if (length > maxBytes)
			throw new ReadLimitError(`Ask file exceeds the ${maxBytes} byte read limit (default 16 MiB)`);
		const after = await file.stat();
		if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
			throw new Error("Source changed during read; retry");
		if (sourceOnly) {
			const current = await lstat(await checkedPath(root, path, signal, true));
			if (current.dev !== stat.dev || current.ino !== stat.ino)
				throw new Error("Coordinator source path changed during read; retry");
		}
		return buffer.subarray(0, length);
	} finally {
		await file.close();
	}
}

type Entry = { name: string; kind: "file" | "directory" | "symlink" | "submodule"; oid?: string };

export class SourceReader {
	readonly root: string;
	readonly ask: AskContext;
	readonly trees = new Map<string, Entry[]>();
	#cachedEntries = 0;
	constructor(ask: AskContext) {
		this.ask = ask.feedbackDeniedPaths ? { ...ask, sourceOnly: true } : ask;
		this.root = resolve(ask.source);
		if (!!ask.gitDir !== !!ask.commit) throw new Error("Ask branch snapshots require both gitDir and commit");
		if (ask.commit && !SHA.test(ask.commit)) throw new Error("Ask requires a pinned full commit ID");
	}
	/** Select only an exact host-qualified root. Relative paths still mean the project source. */
	private async feedbackSource(
		path: string,
		signal?: AbortSignal,
	): Promise<{ reader: SourceReader; path: string; displayRoot: string } | undefined> {
		if (!this.ask.feedbackSources && !this.ask.feedbackDeniedPaths) return undefined;
		if (path.includes("\0") || path.length > 4096 || path.split(/[\\/]/).includes(".."))
			throw new Error("Ask path traversal denied");
		const absolute = resolve(this.root, path);
		const primary = contained(this.root, absolute);
		const source =
			!primary && isAbsolute(path)
				? this.ask.feedbackSources?.find((s) =>
						s.kind === "file" ? s.path === absolute : contained(s.path, absolute),
					)
				: undefined;
		// Refuse unrelated paths without probing their filesystem metadata.
		if (!primary && !source) return undefined;
		if (this.ask.feedbackDeniedPaths) {
			signal?.throwIfAborted();
			const target = resolve(this.root, path);
			const canonical = await realpath(target).catch(() => target);
			for (const denied of this.ask.feedbackDeniedPaths) {
				const protectedPath = resolve(denied);
				const protectedCanonical = await realpath(protectedPath).catch(() => protectedPath);
				if ([target, canonical].some((p) => contained(protectedPath, p) || contained(protectedCanonical, p)))
					throw new Error("Feedback cannot read a protected credential store");
			}
			if (contained(this.root, target)) sourceContentPath(this.root, path);
		}
		if (!source) return undefined;
		signal?.throwIfAborted();
		// Identity is checked on every operation, not just at admission or directory discovery.
		const stat = await lstat(source.path);
		if (
			stat.isSymbolicLink() ||
			stat.dev !== source.dev ||
			stat.ino !== source.ino ||
			(source.kind === "file" ? !stat.isFile() : !stat.isDirectory())
		)
			throw new Error("The selected feedback path changed; access is no longer valid");
		const root = source.kind === "file" ? resolve(source.path, "..") : source.path;
		const rel = sourceContentPath(root, absolute);
		const canonicalRoot = await realpath(root);
		return {
			reader: new SourceReader({
				source: canonicalRoot,
				sourceOnly: true,
				feedbackDeniedPaths: this.ask.feedbackDeniedPaths,
			}),
			path: resolve(canonicalRoot, rel),
			displayRoot: root,
		};
	}
	async git(args: string[], signal?: AbortSignal, maxBuffer = 2 * 1024 * 1024): Promise<Buffer> {
		signal?.throwIfAborted();
		// No shell, hooks, replacement objects, global configuration, inherited Git overrides or locks.
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
		const { stdout } = await run(
			"/usr/bin/git",
			["--no-optional-locks", "--no-replace-objects", `--git-dir=${resolve(this.ask.gitDir!)}`, ...args],
			{
				encoding: "buffer",
				maxBuffer,
				signal,
				timeout: 10_000,
				env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
			},
		);
		return stdout;
	}
	async tree(oid: string, signal?: AbortSignal): Promise<Entry[]> {
		signal?.throwIfAborted();
		const cached = this.trees.get(oid);
		if (cached) return cached;
		const bytes = await this.git(["ls-tree", "-z", oid], signal);
		const lines = bytes.toString("utf8").split("\0").filter(Boolean);
		if (lines.length > MAX_ENTRIES) throw new Error("Ask tree exceeds the 10000 entry limit");
		const entries: Entry[] = lines.map((line) => {
			const match = /^(\d+) (blob|tree|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(line);
			if (!match || !SHA.test(match[3]!)) throw new Error("Invalid Ask Git tree entry");
			const [, mode, type, id, name] = match;
			if (name === "." || name === ".." || name!.includes("/") || name!.length > 4096)
				throw new Error("Unsafe Ask Git tree path");
			return {
				name: name!,
				oid: id!,
				kind:
					mode === "120000" ? "symlink" : type === "tree" ? "directory" : type === "commit" ? "submodule" : "file",
			};
		});
		// Bounded cache of immutable tree listings. Root and parent reads usually hit it during grep.
		while (this.trees.size >= 256 || this.#cachedEntries + entries.length > 20_000) {
			const oldest = this.trees.keys().next().value!;
			this.#cachedEntries -= this.trees.get(oldest)!.length;
			this.trees.delete(oldest);
		}
		this.trees.set(oid, entries);
		this.#cachedEntries += entries.length;
		return entries;
	}
	async object(path: string, signal?: AbortSignal): Promise<Entry> {
		let entry: Entry = { name: "", kind: "directory", oid: this.ask.commit! };
		for (const part of sourcePath(this.root, path).split("/").filter(Boolean)) {
			signal?.throwIfAborted();
			if (entry.kind !== "directory") throw new Error("Ask does not follow symlinks or submodules");
			const next = (await this.tree(entry.oid!, signal)).find((item) => item.name === part);
			if (!next) throw new Error(`Ask path not found in pinned tree: ${path}`);
			entry = next;
		}
		return entry;
	}
	async list(path: string, signal?: AbortSignal): Promise<Entry[]> {
		path = expandHome(path);
		const feedback = await this.feedbackSource(path, signal);
		if (feedback) return feedback.reader.list(feedback.path, signal);
		this.assertSourceOnly(path);
		if (this.ask.commit) {
			const entry = await this.object(path, signal);
			if (entry.kind !== "directory") throw new Error("Ask ls requires a directory");
			return this.tree(entry.oid!, signal);
		}
		const absolute = await checkedPath(this.root, path, signal, this.ask.sourceOnly);
		const expected = this.ask.sourceOnly ? await lstat(absolute) : undefined;
		const dir = await opendir(absolute);
		const entries: Entry[] = [];
		for await (const entry of dir) {
			signal?.throwIfAborted();
			if (entries.length >= MAX_ENTRIES) throw new Error("Ask directory exceeds the 10000 entry limit");
			entries.push({
				name: entry.name,
				kind: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file",
			});
		}
		if (expected) {
			const current = await lstat(await checkedPath(this.root, path, signal, true));
			if (current.dev !== expected.dev || current.ino !== expected.ino)
				throw new Error("Coordinator source directory changed during listing; retry");
		}
		return entries.sort((a, b) => a.name.localeCompare(b.name));
	}
	async read(path: string, signal?: AbortSignal, maxBytes = MAX_FILE_BYTES): Promise<Buffer> {
		path = expandHome(path);
		const feedback = await this.feedbackSource(path, signal);
		if (feedback) {
			const bytes = await feedback.reader.read(feedback.path, signal, maxBytes);
			// Images remain images. Extra text sources are sanitized before search or output.
			const image =
				bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
				(bytes[0] === 255 && bytes[1] === 216) ||
				bytes.subarray(0, 3).toString() === "GIF" ||
				(bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP");
			if (image && bytes.includes(0)) return bytes;
			if (bytes.includes(0)) throw new Error("Feedback source is not supported text or an image");
			if (bytes.length > MAX_REDACT_CHARS)
				throw new ReadLimitError(
					`Named feedback text exceeds the ${MAX_REDACT_CHARS} byte sanitization limit; use protected log excerpts for large logs`,
				);
			return Buffer.from(redactHistoryText(bytes.toString("utf8")));
		}
		this.assertSourceOnly(path);
		if (!this.ask.commit) return readLocal(this.root, path, signal, maxBytes, this.ask.sourceOnly);
		const entry = await this.object(path, signal);
		if (entry.kind !== "file") throw new Error("Ask can only read regular blobs, not symlinks or submodules");
		const size = Number((await this.git(["cat-file", "-s", entry.oid!], signal)).toString());
		if (!Number.isSafeInteger(size) || size > maxBytes)
			throw new ReadLimitError(`Ask blob exceeds the ${maxBytes} byte read limit (default 16 MiB)`);
		return this.git(["cat-file", "blob", entry.oid!], signal, maxBytes);
	}
	async *walk(path: string, signal?: AbortSignal): AsyncGenerator<string> {
		path = expandHome(path);
		const feedback = await this.feedbackSource(path, signal);
		if (feedback) {
			for await (const name of feedback.reader.walk(feedback.path, signal)) yield join(feedback.displayRoot, name);
			return;
		}
		const pending = [sourcePath(this.root, path)];
		let visited = 0;
		while (pending.length) {
			const dir = pending.pop()!;
			for (const entry of await this.list(dir, signal)) {
				signal?.throwIfAborted();
				if (++visited > MAX_ENTRIES)
					throw new Error("Ask search exceeds the 10000 entry limit; choose a narrower path");
				if ([".git", ".jj", "node_modules"].includes(entry.name)) continue;
				const name = dir ? `${dir}/${entry.name}` : entry.name;
				if (entry.kind === "directory") pending.push(name);
				else if (entry.kind === "file") yield name;
			}
		}
	}
	async kind(path: string, signal?: AbortSignal): Promise<Entry["kind"]> {
		path = expandHome(path);
		const feedback = await this.feedbackSource(path, signal);
		if (feedback) return feedback.reader.kind(feedback.path, signal);
		this.assertSourceOnly(path);
		if (this.ask.commit) return (await this.object(path, signal)).kind;
		const stat = await lstat(await checkedPath(this.root, path, signal, this.ask.sourceOnly));
		if (stat.isFile()) return "file";
		if (stat.isDirectory()) return "directory";
		throw new Error("Ask only explores regular files and directories");
	}
	async *files(path: string, signal?: AbortSignal): AsyncGenerator<string> {
		path = expandHome(path);
		const feedback = await this.feedbackSource(path, signal);
		if (feedback) {
			for await (const name of feedback.reader.files(feedback.path, signal)) yield join(feedback.displayRoot, name);
			return;
		}
		const rel = sourcePath(this.root, path);
		const kind = await this.kind(rel, signal);
		if (kind === "file") yield rel;
		else yield* this.walk(rel, signal);
	}

	private assertSourceOnly(path: string): void {
		if (this.ask.sourceOnly) sourceContentPath(this.root, path);
	}
}
