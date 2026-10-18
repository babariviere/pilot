/** Off-thread, read-only workspace inventory. Only synthetic temporary repositories are authorized callers. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { scopedPath } from "./repository-browser.ts";

const execute = promisify(execFile);
const oid = /^[a-f0-9]{40}$/;
export const CODE_CAPTURE_LIMITS = Object.freeze({
	bytes: 120 * 1024 * 1024,
	blobBytes: 8 * 1024 * 1024,
	paths: 4000, // baseline/current sources + their inventories must fit the vault's 20k selections
	durationMs: 60_000,
	holdMs: 5000, // includes waiting for the safe boundary; expiry never aborts an author tool
});
export interface CodeWorkspace {
	/** Host-resolved existing canonical directories, never looked up or created by capture. */
	root: string;
	gitDirectory: string;
	/** Exact starting commit. No HEAD/default-branch/merge-base fallback. SHA-1 only for now. */
	baseline: string;
}
export interface CodeFile {
	path: string;
	mode: string;
	state: "present" | "deleted" | "unsafe" | "unsupported" | "raced";
	sha256: string | null;
	bytes?: Uint8Array;
	/** Comparison-only identity/stat watermark, never released as an author path. */
	stamp?: string;
}
export interface CodeTreeScan {
	status: "available" | "missing";
	baseline: string;
	baselineTree: string | null;
	head: string | null;
	baselineFiles: CodeFile[];
	files: CodeFile[];
	indexDigest: string | null;
	treeDigest: string | null;
	observationDigest: string | null;
	raced: boolean;
}
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const pathOK = (path: string) =>
	Buffer.byteLength(path) <= 400 &&
	path.split("/").length <= 64 &&
	!/[\x00-\x1f\x7f\\:]/.test(path) &&
	path.split("/").every((p) => p && p !== "." && p !== ".." && p.toLowerCase() !== ".git");
const decode = (bytes: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const stamp = (s: Awaited<ReturnType<typeof lstat>>) =>
	JSON.stringify([s.dev, s.ino, s.mode, s.size, s.mtimeMs, s.ctimeMs]);

/** Fixed read-only Git operations. execFile's owned child handle is cancelled and awaited by the capture owner. */
export async function readCodeGit(
	workspace: CodeWorkspace,
	args: string[],
	maxBuffer: number,
	input?: string,
	signal?: AbortSignal,
): Promise<Buffer> {
	const running = execute(
		"/usr/bin/git",
		[
			"--no-optional-locks",
			`--git-dir=${workspace.gitDirectory}`,
			`--work-tree=${workspace.root}`,
			"-c",
			"core.fsmonitor=false",
			"-c",
			"core.untrackedCache=false",
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"core.attributesFile=/dev/null",
			"-c",
			"core.excludesFile=/dev/null",
			...args,
		],
		{
			env: {
				PATH: "/usr/bin:/bin",
				HOME: "/dev/null",
				LC_ALL: "C",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_NO_REPLACE_OBJECTS: "1",
				GIT_NO_LAZY_FETCH: "1",
				GIT_TERMINAL_PROMPT: "0",
				GIT_ALLOW_PROTOCOL: "",
				GIT_OPTIONAL_LOCKS: "0",
			},
			encoding: "buffer",
			maxBuffer,
			timeout: 10_000,
			signal,
			killSignal: "SIGKILL",
		},
	);
	running.child.stdin?.on("error", () => {});
	running.child.stdin?.end(input);
	return (await running).stdout;
}
export type CodeGitReader = (args: string[], maxBuffer: number, input?: string) => Promise<Buffer>;
export async function scanCodeTree(workspace: CodeWorkspace, reader?: CodeGitReader): Promise<CodeTreeScan> {
	if (!oid.test(workspace.baseline)) throw new Error("Exact starting SHA-1 required");
	const result: CodeTreeScan = {
		status: "missing",
		baseline: workspace.baseline,
		baselineTree: null,
		head: null,
		baselineFiles: [],
		files: [],
		indexDigest: null,
		treeDigest: null,
		observationDigest: null,
		raced: false,
	};
	for (const path of [workspace.root, workspace.gitDirectory]) {
		try {
			const info = await lstat(path);
			if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path)
				throw new Error("Noncanonical workspace");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
			throw error;
		}
	}
	const git = async (args: string[], maxBuffer = 8 * 1024 * 1024, input?: string) => {
		return reader ? reader(args, maxBuffer, input) : readCodeGit(workspace, args, maxBuffer, input);
	};
	result.head = (await git(["rev-parse", "--verify", "HEAD"], 1024)).toString().trim();
	if (!oid.test(result.head!)) throw new Error("Unsupported Git identity");
	let total = 0;
	const budget = (bytes: number) => {
		total += bytes;
		if (bytes > CODE_CAPTURE_LIMITS.blobBytes || total > CODE_CAPTURE_LIMITS.bytes)
			throw new Error("Code capture byte limit");
	};
	const paths = new Set<string>();
	const add = (path: string) => {
		if (!pathOK(path)) throw new Error("Unsupported source path");
		paths.add(path);
		if (paths.size > CODE_CAPTURE_LIMITS.paths) throw new Error("Code capture path limit");
	};
	const objects = new Map<string, { type: string; bytes: Buffer }>();
	const acquire = async (requested: { object: string; type: "commit" | "tree" | "blob" }[]) => {
		const wanted = [...new Map(requested.map((r) => [r.object, r])).values()].filter((r) => {
			const existing = objects.get(r.object);
			if (existing && existing.type !== r.type) throw new Error("Baseline object type mismatch");
			return !existing;
		});
		if (!wanted.length) return;
		if (objects.size + wanted.length > CODE_CAPTURE_LIMITS.paths * 2 + 1) throw new Error("Baseline object limit");
		const input = `${wanted.map((r) => r.object).join("\n")}\n`;
		const sizes = (await git(["cat-file", "--batch-check"], wanted.length * 128 + 1, input))
			.toString("ascii")
			.trimEnd()
			.split("\n");
		if (sizes.length !== wanted.length) throw new Error("Invalid baseline inventory");
		let batchBytes = 0;
		const items = wanted.map((r, i) => {
			const fields = sizes[i]!.split(" ");
			const size = Number(fields[2]);
			if (
				fields.length !== 3 ||
				fields[0] !== r.object ||
				fields[1] !== r.type ||
				!Number.isSafeInteger(size) ||
				size < 0
			)
				throw new Error("Invalid baseline object");
			budget(size);
			batchBytes += size;
			return { ...r, size };
		});
		const batch = await git(["cat-file", "--batch"], batchBytes + items.length * 128 + 1, input);
		let offset = 0;
		for (const { object, type, size } of items) {
			const end = batch.indexOf(10, offset);
			if (end < 0 || batch.subarray(offset, end).toString() !== `${object} ${type} ${size}`)
				throw new Error("Invalid baseline batch");
			const bytes = batch.subarray(end + 1, end + size + 1);
			if (
				bytes.length !== size ||
				batch[end + size + 1] !== 10 ||
				createHash("sha1").update(`${type} ${size}\0`).update(bytes).digest("hex") !== object
			)
				throw new Error("Baseline object mismatch");
			objects.set(object, { type, bytes });
			offset = end + size + 2;
		}
		if (offset !== batch.length) throw new Error("Invalid baseline batch length");
	};
	await acquire([{ object: workspace.baseline, type: "commit" }]);
	const commit = objects.get(workspace.baseline)!.bytes;
	result.baselineTree = /^tree ([a-f0-9]{40})\n/.exec(commit.toString("latin1"))?.[1] ?? null;
	if (!result.baselineTree) throw new Error("Invalid starting commit");
	let pending = [{ object: result.baselineTree, prefix: "" }],
		treeEntries = 0;
	const blobs: { object: string; file: CodeFile }[] = [];
	while (pending.length) {
		await acquire(pending.map(({ object }) => ({ object, type: "tree" })));
		const next: typeof pending = [];
		for (const { object, prefix } of pending) {
			const raw = objects.get(object)!.bytes,
				names = new Set<string>();
			for (let offset = 0; offset < raw.length; ) {
				const space = raw.indexOf(32, offset),
					nul = raw.indexOf(0, space + 1);
				if (space < offset || nul <= space + 1 || nul + 21 > raw.length) throw new Error("Invalid baseline tree");
				const mode = raw.subarray(offset, space).toString("ascii"),
					name = decode(raw.subarray(space + 1, nul));
				const child = raw.subarray(nul + 1, nul + 21).toString("hex"),
					path = prefix + name;
				if (
					!pathOK(path) ||
					name.includes("/") ||
					names.has(name) ||
					!["40000", "100644", "100755", "120000", "160000"].includes(mode)
				)
					throw new Error("Unsupported baseline path/mode");
				names.add(name);
				if (++treeEntries > CODE_CAPTURE_LIMITS.paths) throw new Error("Baseline tree path limit");
				if (mode === "40000") next.push({ object: child, prefix: `${path}/` });
				else {
					add(path);
					const file: CodeFile = { path, mode, state: "unsupported", sha256: null };
					result.baselineFiles.push(file);
					if (["100644", "100755"].includes(mode)) blobs.push({ object: child, file });
				}
				offset = nul + 21;
			}
		}
		pending = next;
	}
	await acquire(blobs.map(({ object }) => ({ object, type: "blob" })));
	for (const { object, file } of blobs) {
		const bytes = objects.get(object)!.bytes;
		Object.assign(file, { state: "present", sha256: hash(bytes), bytes });
	}
	result.baselineFiles.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
	const index = await git(["ls-files", "--stage", "-v", "-z"]);
	const eligible = new Set<string>();
	const gitlinks = new Set<string>(),
		sparse = new Set<string>();
	result.indexDigest = hash(index);
	for (const record of decode(index).split("\0").filter(Boolean)) {
		const match = /^([A-Za-z]) ([0-9]{6}) [a-f0-9]{40} [0-3]\t(.+)$/.exec(record);
		if (!match) throw new Error("Unsupported index");
		const path = match[3]!;
		add(path);
		eligible.add(path);
		if (match[2] === "160000") gitlinks.add(path);
		if (match[1]!.toUpperCase() === "S") sparse.add(path);
	}
	for (const path of decode(await git(["ls-files", "--others", "--exclude-standard", "-z"]))
		.split("\0")
		.filter(Boolean)) {
		add(path);
		eligible.add(path);
	}
	for (const path of [...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
		const file: CodeFile = { path, mode: "unknown", state: "unsafe", sha256: null };
		result.files.push(file);
		if (!eligible.has(path)) {
			file.state = "deleted";
			continue;
		}
		if (gitlinks.has(path)) {
			file.mode = "160000";
			file.state = "unsupported";
			continue;
		}
		try {
			const full = await scopedPath(workspace.root, path);
			const before = await lstat(full);
			file.stamp = stamp(before);
			if (!before.isFile() || before.nlink !== 1) {
				file.state = "unsupported";
				continue;
			}
			file.mode = before.mode & 0o111 ? "100755" : "100644";
			budget(before.size);
			const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			try {
				const info = await handle.stat();
				if (stamp(info) !== stamp(before)) {
					file.state = "raced";
					result.raced = true;
					continue;
				}
				const bytes = Buffer.alloc(before.size + 1);
				let size = 0;
				while (size < bytes.length) {
					const next = await handle.read(bytes, size, bytes.length - size, size);
					if (!next.bytesRead) break;
					size += next.bytesRead;
				}
				const checked = await lstat(await scopedPath(workspace.root, path));
				if (
					size !== before.size ||
					stamp(await handle.stat()) !== stamp(before) ||
					stamp(checked) !== stamp(before)
				) {
					file.state = "raced";
					result.raced = true;
					continue;
				}
				Object.assign(file, {
					state: "present",
					sha256: hash(bytes.subarray(0, size)),
					bytes: bytes.subarray(0, size),
				});
			} finally {
				await handle.close();
			}
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR") file.state = sparse.has(path) ? "unsupported" : "deleted";
			else if (error instanceof Error && error.message === "Code capture byte limit") throw error;
		}
	}
	const inventory = result.files.map(({ bytes: _bytes, stamp: _stamp, ...file }) => file);
	result.treeDigest = hash(JSON.stringify(inventory));
	result.observationDigest = hash(
		JSON.stringify({
			head: result.head,
			index: result.indexDigest,
			files: result.files.map(({ bytes: _bytes, ...f }) => f),
		}),
	);
	result.status = "available";
	return result;
}
