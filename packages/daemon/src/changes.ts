/** What a session changed: its working copy against the point it branched from. */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { ChangedFile, SessionChangeSummary, SessionChanges } from "@pilot/protocol";
import { TtlCache } from "./ttl-cache.ts";
import { workspaceBranch } from "./workspaces.ts";

const exec = promisify(execFile);
const MAX_DIFF = 1024 * 1024;
// The client's unified-diff parser expects a/ and b/, regardless of the user's Git config.
const PATCH_ARGS = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"];

/** Only expose complete hunks from a clipped patch, never a partial line or incorrect hunk body. */
function completePatchPrefix(diff: string): string {
	let safeEnd = 0;
	let oldLines = 0;
	let newLines = 0;
	let inHunk = false;
	for (let offset = 0; offset < diff.length; ) {
		const end = diff.indexOf("\n", offset);
		if (end < 0) break;
		const line = diff.slice(offset, end);
		const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
		if (header) {
			oldLines = header[1] === undefined ? 1 : Number(header[1]);
			newLines = header[2] === undefined ? 1 : Number(header[2]);
			inHunk = true;
		} else if (inHunk) {
			if (line.startsWith(" ")) {
				oldLines--;
				newLines--;
			} else if (line.startsWith("-")) oldLines--;
			else if (line.startsWith("+")) newLines--;
			else if (!line.startsWith("\\")) break;
		} else if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
			safeEnd = end + 1;
		} else if (offset === safeEnd && line.startsWith("\\ No newline at end of file")) {
			safeEnd = end + 1;
		}
		if (inHunk && oldLines === 0 && newLines === 0) {
			safeEnd = end + 1;
			inHunk = false;
		}
		offset = end + 1;
	}
	return diff.slice(0, safeEnd);
}

/** Bound both retained output and Git's lifetime, not just the final concatenated string. */
async function gitPatch(cwd: string, args: string[], maxBytes: number, allowExitOne = false) {
	return new Promise<{ patch: Buffer; truncated: boolean }>((resolve, reject) => {
		const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		let size = 0;
		let stderr = "";
		let truncated = false;
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, 30_000);
		child.stdout.on("data", (chunk: Buffer) => {
			if (truncated) return;
			const remaining = maxBytes - size;
			if (chunk.length > remaining) {
				chunks.push(chunk.subarray(0, remaining));
				size += remaining;
				truncated = true;
				child.kill("SIGKILL");
			} else {
				chunks.push(chunk);
				size += chunk.length;
			}
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8").slice(0, 64 * 1024 - stderr.length);
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (timedOut) reject(new Error("Git diff timed out"));
			else if (truncated || code === 0 || (allowExitOne && code === 1))
				resolve({ patch: Buffer.concat(chunks, size), truncated });
			else reject(new Error(stderr.trim() || `Git diff exited ${code}`));
		});
	});
}

/** TTL revalidation intentionally runs Git again, so external editors, commits and refs remain visible. */
export class RepositoryChanges {
	private readonly cache = new TtlCache<SessionChanges | SessionChangeSummary>({
		ttlMs: 1000,
		maxEntries: 128,
		maxBytes: 16 * 1024 * 1024,
		maxPending: 16,
		busyMessage: "Repository changes are busy. Retry shortly.",
		weight: (value) => Buffer.byteLength(JSON.stringify(value)),
	});

	changes(cwd: string, base = "HEAD"): Promise<SessionChanges> {
		return this.cache.get(JSON.stringify([cwd, base, "full"]), () =>
			collectChanges(cwd, base),
		) as Promise<SessionChanges>;
	}

	summary(cwd: string, base = "HEAD"): Promise<SessionChangeSummary> {
		return this.cache.get(JSON.stringify([cwd, base, "summary"]), () =>
			collectChangeSummary(cwd, base),
		) as Promise<SessionChangeSummary>;
	}

	invalidate(cwd: string): void {
		this.cache.invalidate((key) => (JSON.parse(key) as string[])[0] === cwd);
	}
}

async function git(cwd: string, args: string[], allowExitOne = false): Promise<string> {
	try {
		const { stdout } = await exec("git", args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 30_000 });
		return stdout;
	} catch (error) {
		// `git diff --no-index` exits 1 when files differ.
		const failure = error as { code?: number; stdout?: string };
		if (allowExitOne && failure.code === 1 && typeof failure.stdout === "string") return failure.stdout;
		throw error;
	}
}

const STATUS: Record<string, ChangedFile["status"]> = {
	A: "added",
	M: "modified",
	D: "deleted",
	R: "renamed",
	T: "modified",
};

async function changeBase(cwd: string, base: string) {
	if ((await git(cwd, ["rev-parse", "--is-inside-work-tree"]).catch(() => "")).trim() !== "true")
		throw new Error("Not a git repository");
	const branch = await workspaceBranch(cwd).catch(() => undefined);
	const mergeBase = (await git(cwd, ["merge-base", "HEAD", base]).catch(() => "")).trim() || base;
	return {
		mergeBase,
		base: mergeBase === base ? base : `${base} (${mergeBase.slice(0, 8)})`,
		...(branch ? { branch } : {}),
	};
}

/** Read NUL-delimited numstat records without interpreting tabs or newlines in filenames. */
function numstat(output: string): Map<string, { additions: number; deletions: number }> {
	const records = output.split("\0");
	const files = new Map<string, { additions: number; deletions: number }>();
	for (let i = 0; i < records.length; i++) {
		const record = records[i]!;
		if (!record) continue;
		const firstTab = record.indexOf("\t");
		const secondTab = record.indexOf("\t", firstTab + 1);
		if (firstTab < 0 || secondTab < 0) continue;
		let path = record.slice(secondTab + 1);
		// A rename has an empty path field followed by separate old and new path records.
		if (!path) {
			i += 2;
			path = records[i]!;
		}
		if (!path) continue;
		files.set(path, {
			additions: Number(record.slice(0, firstTab)) || 0,
			deletions: Number(record.slice(firstTab + 1, secondTab)) || 0,
		});
	}
	return files;
}

async function lineStats(cwd: string, mergeBase: string, untracked: string[]) {
	const stats = numstat(
		await git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "-M", mergeBase, "--"]),
	);
	for (const path of untracked) {
		const untrackedStats = numstat(
			await git(
				cwd,
				["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "--no-index", "--", "/dev/null", path],
				true,
			),
		);
		// Recreated untracked paths replace staged deletions. Errors must not become fabricated zero counts.
		stats.set(path, [...untrackedStats.values()][0] ?? { additions: 0, deletions: 0 });
	}
	return stats;
}

/** Count changed paths and lines without generating patches. Renames count once. */
export async function collectChangeSummary(cwd: string, base = "HEAD"): Promise<SessionChangeSummary> {
	const { mergeBase, ...metadata } = await changeBase(cwd, base);
	const tracked = await git(cwd, ["diff", "--name-only", "-z", "-M", mergeBase, "--"]);
	const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
	// NUL records preserve tabs, newlines and quoted/non-ASCII filenames. A rename emits only its destination.
	const paths = new Set([...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean));
	const stats = await lineStats(cwd, mergeBase, untracked.split("\0").filter(Boolean));
	let additions = 0;
	let deletions = 0;
	for (const stat of stats.values()) {
		additions += stat.additions;
		deletions += stat.deletions;
	}
	return { ...metadata, fileCount: paths.size, additions, deletions };
}

/**
 * Committed and uncommitted changes since `base` (default `HEAD`), including untracked files. Uses the
 * merge base, so commits that landed on the base branch afterwards are not shown as changes.
 */
export async function collectChanges(cwd: string, base = "HEAD"): Promise<SessionChanges> {
	const { mergeBase, ...metadata } = await changeBase(cwd, base);

	const files = new Map<string, ChangedFile>();
	const records = (await git(cwd, ["diff", "--name-status", "-z", "-M", mergeBase, "--"])).split("\0");
	for (let i = 0; i < records.length; ) {
		const code = records[i++];
		if (!code) continue;
		const previousPath = records[i++];
		const path = code[0] === "R" ? records[i++] : previousPath;
		if (!path) continue;
		files.set(path, {
			path,
			status: STATUS[code[0]!] ?? "modified",
			additions: 0,
			deletions: 0,
			...(code[0] === "R" ? { previousPath } : {}),
		});
	}
	const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
	const stats = await lineStats(cwd, mergeBase, untracked);
	for (const path of untracked) {
		files.set(path, { path, status: "untracked", additions: 0, deletions: 0 });
	}
	for (const [path, stat] of stats) {
		const file = files.get(path);
		if (file) Object.assign(file, stat);
	}

	const tracked = await gitPatch(cwd, [...PATCH_ARGS, "-M", mergeBase, "--"], MAX_DIFF);
	const patches = [tracked.patch];
	let size = tracked.patch.length;
	let truncated = tracked.truncated;
	for (const path of untracked) {
		// All file statistics are already complete, even when later patches are omitted.
		if (truncated || size === MAX_DIFF) {
			truncated = true;
			break;
		}
		const result = await gitPatch(cwd, [...PATCH_ARGS, "--no-index", "--", "/dev/null", path], MAX_DIFF - size, true);
		patches.push(result.patch);
		size += result.patch.length;
		truncated = result.truncated;
	}
	// Ignore a partial final UTF-8 code point instead of expanding it into a replacement character.
	let diff = new TextDecoder("utf-8").decode(Buffer.concat(patches, size), { stream: truncated });
	// Invalid UTF-8 text can expand into replacement characters. Keep the wire representation bounded too.
	if (Buffer.byteLength(diff) > MAX_DIFF) {
		diff = new TextDecoder("utf-8").decode(Buffer.from(diff).subarray(0, MAX_DIFF), { stream: true });
		truncated = true;
	}
	if (truncated) diff = completePatchPrefix(diff);
	return {
		...metadata,
		files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
		diff,
		truncated,
	};
}
