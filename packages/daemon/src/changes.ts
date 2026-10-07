/** What a session changed: its working copy against the point it branched from. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ChangedFile, SessionChangeSummary, SessionChanges } from "@pilot/protocol";
import { workspaceBranch } from "./workspaces.ts";

const exec = promisify(execFile);
const MAX_DIFF = 1024 * 1024;
// The client's unified-diff parser expects a/ and b/, regardless of the user's Git config.
const PATCH_ARGS = ["diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/"];

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

/** Count changed paths without generating patches or line statistics. Renames count once. */
export async function collectChangeSummary(cwd: string, base = "HEAD"): Promise<SessionChangeSummary> {
	const { mergeBase, ...metadata } = await changeBase(cwd, base);
	const tracked = await git(cwd, ["diff", "--name-only", "-z", "-M", mergeBase, "--"]);
	const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
	// NUL records preserve tabs, newlines and quoted/non-ASCII filenames. A rename emits only its destination.
	const paths = new Set([...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean));
	return { ...metadata, fileCount: paths.size };
}

/**
 * Committed and uncommitted changes since `base` (default `HEAD`), including untracked files. Uses the
 * merge base, so commits that landed on the base branch afterwards are not shown as changes.
 */
export async function collectChanges(cwd: string, base = "HEAD"): Promise<SessionChanges> {
	const { mergeBase, ...metadata } = await changeBase(cwd, base);

	const files = new Map<string, ChangedFile>();
	for (const line of (await git(cwd, ["diff", "--name-status", "-M", mergeBase])).split("\n")) {
		const [code, ...paths] = line.split("\t");
		if (!code || paths.length === 0) continue;
		const path = paths.at(-1)!;
		files.set(path, {
			path,
			status: STATUS[code[0]!] ?? "modified",
			additions: 0,
			deletions: 0,
			...(code[0] === "R" ? { previousPath: paths[0] } : {}),
		});
	}
	for (const line of (await git(cwd, ["diff", "--numstat", "-M", mergeBase])).split("\n")) {
		const [added, deleted, ...rest] = line.split("\t");
		const path = rest.at(-1);
		const file = path
			? files.get(path.includes(" => ") ? path.replace(/.*=> /, "").replace(/}$/, "") : path)
			: undefined;
		if (!file) continue;
		file.additions = Number(added) || 0;
		file.deletions = Number(deleted) || 0;
	}

	let diff = await git(cwd, [...PATCH_ARGS, "-M", mergeBase]);
	const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard"])).split("\n").filter(Boolean);
	for (const path of untracked) {
		const patch = await git(cwd, [...PATCH_ARGS, "--no-index", "--", "/dev/null", path], true).catch(() => "");
		const additions = patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
		files.set(path, { path, status: "untracked", additions, deletions: 0 });
		diff += patch;
	}
	const truncated = diff.length > MAX_DIFF;
	return {
		...metadata,
		files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
		diff: truncated ? diff.slice(0, MAX_DIFF) : diff,
		truncated,
	};
}
