/** Host-owned Ask tools. No model-supplied command, executable, revision or Git pathspec is accepted. */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, opendir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { createReadToolDefinition, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AskContext } from "./policy.ts";
import { ARTIFACT_SKILL_PATH } from "./artifact-skill.ts";

const run = promisify(execFile);
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_SEARCH_BYTES = 32 * 1024 * 1024;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const UUID_PNG = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.png$/i;
class ReadLimitError extends Error {}
export const ASK_ATTACHMENTS = join(homedir(), "Library", "Application Support", "Pilot", "Attachments");
export const ASK_TOOL_NAMES = ["read", "find", "grep", "ls", "codemode", "artifact", "mission"];
const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function contained(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Reject traversal even when normalizing it would land back inside the source. */
function sourcePath(source: string, path: string): string {
	if (path.length > 4096) throw new Error("Ask path exceeds the 4096 character limit");
	if (path.includes("\0") || path.split(/[\\/]/).includes("..")) throw new Error("Ask path traversal denied");
	const absolute = resolve(source, path);
	if (!contained(source, absolute)) throw new Error("Ask paths must stay inside the source");
	return relative(source, absolute).split(sep).join("/");
}

/** No symlinks, including directory symlinks. The final open also uses O_NOFOLLOW. */
async function checkedPath(root: string, path: string, signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted();
	const rel = sourcePath(root, path);
	const canonicalRoot = await realpath(root);
	let current = canonicalRoot;
	for (const part of rel.split("/").filter(Boolean)) {
		signal?.throwIfAborted();
		current = join(current, part);
		if ((await lstat(current)).isSymbolicLink()) throw new Error("Ask does not follow symlinks");
	}
	if (!contained(canonicalRoot, await realpath(current))) throw new Error("Ask symlink escape denied");
	return current;
}

async function readLocal(root: string, path: string, signal?: AbortSignal): Promise<Buffer> {
	const absolute = await checkedPath(root, path, signal);
	const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = await file.stat();
		if (!stat.isFile()) throw new Error("Ask can only read regular files");
		if (stat.size > MAX_FILE_BYTES) throw new ReadLimitError("Ask file exceeds the 16 MiB read limit");
		// Bounded reads even if another process grows the file after stat().
		const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_FILE_BYTES + 1));
		let length = 0;
		while (length < buffer.length) {
			signal?.throwIfAborted();
			const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
			if (!bytesRead) break;
			length += bytesRead;
		}
		signal?.throwIfAborted();
		if (length > MAX_FILE_BYTES) throw new ReadLimitError("Ask file exceeds the 16 MiB read limit");
		return buffer.subarray(0, length);
	} finally {
		await file.close();
	}
}

type Entry = { name: string; kind: "file" | "directory" | "symlink" | "submodule"; oid?: string };

class SourceReader {
	readonly root: string;
	readonly ask: AskContext;
	readonly trees = new Map<string, Entry[]>();
	#cachedEntries = 0;
	constructor(ask: AskContext) {
		this.ask = ask;
		this.root = resolve(ask.source);
		if (!!ask.gitDir !== !!ask.commit) throw new Error("Ask branch snapshots require both gitDir and commit");
		if (ask.commit && !SHA.test(ask.commit)) throw new Error("Ask requires a pinned full commit ID");
	}
	async git(args: string[], signal?: AbortSignal, maxBuffer = 2 * 1024 * 1024): Promise<Buffer> {
		signal?.throwIfAborted();
		// No shell, hooks, replacement objects, global configuration, inherited Git overrides or locks.
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
		const { stdout } = await run(
			"git",
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
		if (this.ask.commit) {
			const entry = await this.object(path, signal);
			if (entry.kind !== "directory") throw new Error("Ask ls requires a directory");
			return this.tree(entry.oid!, signal);
		}
		const dir = await opendir(await checkedPath(this.root, path, signal));
		const entries: Entry[] = [];
		for await (const entry of dir) {
			signal?.throwIfAborted();
			if (entries.length >= MAX_ENTRIES) throw new Error("Ask directory exceeds the 10000 entry limit");
			entries.push({
				name: entry.name,
				kind: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file",
			});
		}
		return entries.sort((a, b) => a.name.localeCompare(b.name));
	}
	async read(path: string, signal?: AbortSignal): Promise<Buffer> {
		if (!this.ask.commit) return readLocal(this.root, path, signal);
		const entry = await this.object(path, signal);
		if (entry.kind !== "file") throw new Error("Ask can only read regular blobs, not symlinks or submodules");
		const size = Number((await this.git(["cat-file", "-s", entry.oid!], signal)).toString());
		if (!Number.isSafeInteger(size) || size > MAX_FILE_BYTES)
			throw new ReadLimitError("Ask blob exceeds the 16 MiB read limit");
		return this.git(["cat-file", "blob", entry.oid!], signal, MAX_FILE_BYTES);
	}
	async *walk(path: string, signal?: AbortSignal): AsyncGenerator<string> {
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
	async *files(path: string, signal?: AbortSignal): AsyncGenerator<string> {
		const rel = sourcePath(this.root, path);
		const kind = this.ask.commit
			? (await this.object(rel, signal)).kind
			: (await lstat(await checkedPath(this.root, rel, signal))).isFile()
				? "file"
				: "directory";
		if (kind === "file") yield rel;
		else yield* this.walk(rel, signal);
	}
}

function result(value: string) {
	const truncated = Buffer.byteLength(value) > MAX_OUTPUT_BYTES;
	const text = truncated
		? `${Buffer.from(value).subarray(0, MAX_OUTPUT_BYTES).toString("utf8")}\n[Output truncated; narrow the query.]`
		: value;
	return { content: [{ type: "text" as const, text }], details: undefined, structuredContent: text };
}

/** find uses a small glob matcher, grep uses literal strings, never user-controlled regex execution. */
function glob(pattern: string): (path: string) => boolean {
	if (pattern.length > 512) throw new Error("Ask find pattern is too long");
	const tokens = pattern.match(/\*\*|[\s\S]/g) ?? [];
	// Dynamic programming, O(pattern * path). No regex backtracking from adversarial wildcard chains.
	return (path) => {
		let previous = new Uint8Array(path.length + 1);
		previous[0] = 1;
		for (const token of tokens) {
			const next = new Uint8Array(path.length + 1);
			if (token === "*" || token === "**") next[0] = previous[0]!;
			for (let index = 1; index <= path.length; index++) {
				const char = path[index - 1];
				next[index] =
					token === "*" || token === "**"
						? Number(!!previous[index] || (!!next[index - 1] && (token === "**" || char !== "/")))
						: Number(!!previous[index - 1] && (token === "?" ? char !== "/" : token === char));
			}
			previous = next;
		}
		return previous[path.length] === 1;
	};
}

export async function createAskTools(
	ask: AskContext,
	options: { artifactSkill?: boolean } = {},
): Promise<ToolDefinition[]> {
	const reader = new SourceReader(ask);
	if (ask.commit && (await reader.git(["cat-file", "-t", ask.commit])).toString().trim() !== "commit")
		throw new Error("Ask snapshot must pin a commit object");
	const path = Type.Optional(
		Type.String({ maxLength: 4096, description: "Source-relative directory, defaults to source root." }),
	);
	const limit = Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 }));
	return [
		defineTool({
			name: "read",
			annotations: readOnlyAnnotations,
			label: "read",
			description:
				"Read source text or images, a Pilot pasted UUID.png attachment, or the exact bundled pilot-artifacts skill path when enabled. Source paths are rooted and symlinks are denied. Maximum file size 16 MiB, text output 50 KiB / 2000 lines. Use offset and limit to page text.",
			parameters: Type.Object({
				path: Type.String({ maxLength: 4096 }),
				offset: Type.Optional(Type.Integer({ minimum: 1 })),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
			}),
			outputSchema: Type.Union([
				Type.String(),
				Type.Object({
					type: Type.Literal("image"),
					data: Type.String(),
					mimeType: Type.String(),
					note: Type.String(),
				}),
			]),
			async execute(id, args, signal, onUpdate, ctx) {
				signal?.throwIfAborted();
				let bytes: Buffer;
				const absolute = resolve(reader.root, args.path);
				if (options.artifactSkill && args.path === ARTIFACT_SKILL_PATH) {
					// Exact host-owned document only. Never grant access to its parent directory,
					// siblings, aliases, or model-supplied skill paths (including pinned-tree Ask).
					bytes = await readFile(ARTIFACT_SKILL_PATH, { signal });
				} else if (
					isAbsolute(args.path) &&
					contained(ASK_ATTACHMENTS, absolute) &&
					UUID_PNG.test(basename(absolute)) &&
					relative(ASK_ATTACHMENTS, absolute) === basename(absolute)
				)
					bytes = await readLocal(ASK_ATTACHMENTS, args.path, signal);
				else bytes = await reader.read(args.path, signal);
				const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
					? "image/png"
					: bytes[0] === 255 && bytes[1] === 216
						? "image/jpeg"
						: bytes.subarray(0, 3).toString() === "GIF"
							? "image/gif"
							: bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP"
								? "image/webp"
								: undefined;
				if (mime) {
					// Reuse the SDK image encoder with only already-validated bytes, never its filesystem operations.
					const tool = createReadToolDefinition(reader.root, {
						operations: {
							access: async () => {},
							readFile: async () => bytes,
							detectImageMimeType: async () => mime,
						},
					});
					return tool.execute(id, args, signal, onUpdate, ctx);
				}
				if (bytes.includes(0)) throw new Error("Ask read does not render binary files");
				const lines = bytes.toString("utf8").split("\n");
				const start = (args.offset ?? 1) - 1;
				const end = Math.min(start + (args.limit ?? 2000), lines.length);
				return result(
					lines.slice(start, end).join("\n") +
						(end < lines.length ? `\n[More lines available; use offset=${end + 1}.]` : ""),
				);
			},
		}),
		defineTool({
			name: "ls",
			annotations: readOnlyAnnotations,
			label: "ls",
			description:
				"List source directory entries, marking directories and unfollowed symlinks/submodules. Output is bounded.",
			parameters: Type.Object({ path, limit }),
			outputSchema: Type.String(),
			async execute(_id, args, signal) {
				const entries = await reader.list(args.path ?? ".", signal);
				const count = args.limit ?? 1000;
				return result(
					entries
						.slice(0, count)
						.map(
							(entry) =>
								`${entry.name}${entry.kind === "directory" ? "/" : entry.kind === "file" ? "" : ` [${entry.kind}]`}`,
						)
						.join("\n") + (entries.length > count ? "\n[Entries truncated.]" : ""),
				);
			},
		}),
		defineTool({
			name: "find",
			annotations: readOnlyAnnotations,
			label: "find",
			description:
				"Find source files by glob (*, **, ?). Matches source-relative paths or basenames. Skips symlinks, submodules, .git, .jj and node_modules. Bounded to 10000 visited entries.",
			parameters: Type.Object({ path, pattern: Type.String(), limit }),
			outputSchema: Type.String(),
			async execute(_id, args, signal) {
				const matcher = glob(args.pattern);
				const found: string[] = [];
				for await (const name of reader.walk(args.path ?? ".", signal)) {
					if (matcher(name) || matcher(basename(name))) found.push(name);
					if (found.length >= (args.limit ?? 1000)) return result(`${found.join("\n")}\n[Match limit reached.]`);
				}
				return result(found.join("\n"));
			},
		}),
		defineTool({
			name: "grep",
			annotations: readOnlyAnnotations,
			label: "grep",
			description:
				"Search source text for a literal string, not a regular expression. Reports path:line:text. Skips binary files, symlinks, submodules and metadata/dependency directories. Bounded to 32 MiB scanned and 10000 entries. Narrow path for large repositories.",
			parameters: Type.Object({
				path,
				pattern: Type.String({ minLength: 1, maxLength: 1024 }),
				ignoreCase: Type.Optional(Type.Boolean()),
				limit,
			}),
			outputSchema: Type.String(),
			async execute(_id, args, signal) {
				const found: string[] = [];
				let scanned = 0;
				let skipped = 0;
				const needle = args.ignoreCase ? args.pattern.toLowerCase() : args.pattern;
				for await (const name of reader.files(args.path ?? ".", signal)) {
					let bytes: Buffer;
					try {
						bytes = await reader.read(name, signal);
					} catch (error) {
						signal?.throwIfAborted();
						if (
							error instanceof ReadLimitError ||
							["ENOENT", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")
						) {
							skipped++;
							continue;
						}
						throw error;
					}
					scanned += bytes.length;
					if (scanned > MAX_SEARCH_BYTES)
						return result(`${found.join("\n")}\n[Search byte limit reached; narrow path.]`);
					if (bytes.includes(0)) continue;
					const lines = bytes.toString("utf8").split("\n");
					for (let index = 0; index < lines.length; index++) {
						signal?.throwIfAborted();
						const line = lines[index]!;
						if ((args.ignoreCase ? line.toLowerCase() : line).includes(needle))
							found.push(`${name}:${index + 1}:${line.slice(0, 2000)}`);
						if (found.length >= (args.limit ?? 1000))
							return result(`${found.join("\n")}\n[Match limit reached.]`);
					}
				}
				return result(found.join("\n") + (skipped ? `\n[Skipped ${skipped} oversized or unreadable files.]` : ""));
			},
		}),
	];
}
