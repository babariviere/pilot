/** What a session changed: its working copy against the point it branched from. */
import type { ChangedFile, SessionBranch, SessionChangeSummary, SessionChanges } from "@pilot/protocol";
import { ProcessFailed, subprocesses } from "./subprocess.ts";
import { TtlCache } from "./ttl-cache.ts";
import { type LineStat, type UntrackedFile, untrackedStats } from "./untracked-stats.ts";
import { workspaceBranch } from "./workspaces.ts";

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
	const result = await subprocesses.run("git", args, {
		cwd,
		timeoutMs: 30_000,
		killSignal: "SIGKILL",
		maxBytes,
		overflow: "truncate",
	});
	if (result.timedOut) throw new Error("Git diff timed out");
	if (result.truncated || result.code === 0 || (allowExitOne && result.code === 1))
		return { patch: result.stdout, truncated: result.truncated };
	throw new Error(result.stderr.trim() || `Git diff exited ${result.code}`);
}

/** TTL revalidation intentionally runs Git again, so external editors, commits and refs remain visible. */
export class RepositoryChanges {
	// Both endpoints share the same base, paths and line counts, including concurrent first reads.
	private readonly metadata = new TtlCache<ChangeMetadata>({
		ttlMs: 1000,
		maxEntries: 128,
		maxBytes: 8 * 1024 * 1024,
		maxPending: 16,
		busyMessage: "Repository changes are busy. Retry shortly.",
		weight: (value) => Buffer.byteLength(JSON.stringify(value)),
	});
	private readonly cache = new TtlCache<SessionChanges | SessionChangeSummary | SessionBranch>({
		ttlMs: 1000,
		maxEntries: 128,
		maxBytes: 16 * 1024 * 1024,
		maxPending: 16,
		busyMessage: "Repository changes are busy. Retry shortly.",
		weight: (value) => Buffer.byteLength(JSON.stringify(value)),
	});

	/** Shares bounded admission with diff reads, but never computes a base, paths or line counts. */
	branch(cwd: string): Promise<SessionBranch> {
		return this.cache.get(JSON.stringify([cwd, null, null, "branch"]), async () => {
			const branch = await workspaceBranch(cwd);
			return branch ? { branch } : {};
		}) as Promise<SessionBranch>;
	}

	changes(cwd: string, base = "HEAD", baseBranch?: string): Promise<SessionChanges> {
		return this.cache.get(JSON.stringify([cwd, base, baseBranch ?? null, "full"]), () =>
			this.readMetadata(cwd, base, baseBranch).then((metadata) => collectPatch(cwd, metadata)),
		) as Promise<SessionChanges>;
	}

	summary(cwd: string, base = "HEAD", baseBranch?: string): Promise<SessionChangeSummary> {
		return this.cache.get(JSON.stringify([cwd, base, baseBranch ?? null, "summary"]), () =>
			this.readMetadata(cwd, base, baseBranch).then(summarize),
		) as Promise<SessionChangeSummary>;
	}

	invalidate(cwd: string): void {
		this.cache.invalidate((key) => (JSON.parse(key) as string[])[0] === cwd);
		this.metadata.invalidate((key) => (JSON.parse(key) as string[])[0] === cwd);
	}

	private readMetadata(cwd: string, base: string, baseBranch?: string): Promise<ChangeMetadata> {
		return this.metadata.get(JSON.stringify([cwd, base, baseBranch ?? null]), () =>
			collectMetadata(cwd, base, baseBranch),
		);
	}
}

async function git(cwd: string, args: string[], allowExitOne = false, stdin?: string): Promise<string> {
	const result = await subprocesses.run("git", args, {
		cwd,
		...(stdin !== undefined ? { stdin } : {}),
		timeoutMs: 30_000,
		maxBytes: 32 * 1024 * 1024,
		overflow: "fail",
	});
	if (result.overflowed) throw new ProcessFailed("stdout maxBuffer length exceeded", result);
	if (result.timedOut) throw new ProcessFailed(`git ${args.join(" ")} timed out`, result);
	// `git diff --no-index` exits 1 when files differ.
	if (result.code === 0 || (allowExitOne && result.code === 1)) return result.stdout.toString("utf8");
	throw new ProcessFailed(result.stderr.trim() || `git ${args.join(" ")} exited ${result.code}`, result);
}

const STATUS: Record<string, ChangedFile["status"]> = {
	A: "added",
	M: "modified",
	D: "deleted",
	R: "renamed",
	T: "modified",
};

/**
 * The pinned creation base, or the base branch's newer merge base once the session has rebased onto or merged a
 * later tip. Without this, every upstream commit since session creation would count as the session's own change.
 */
async function changeBase(cwd: string, base: string, baseBranch?: string) {
	if ((await git(cwd, ["rev-parse", "--is-inside-work-tree"]).catch(() => "")).trim() !== "true")
		throw new Error("Not a git repository");
	const branch = await workspaceBranch(cwd).catch(() => undefined);
	let mergeBase = (await git(cwd, ["merge-base", "HEAD", base]).catch(() => "")).trim() || base;
	let label = base;
	if (baseBranch) {
		const latest = (
			await git(cwd, ["merge-base", "HEAD", `refs/remotes/origin/${baseBranch}`]).catch(() => "")
		).trim();
		// Only move forward: a stale or rewound remote-tracking ref must not widen the diff.
		if (
			latest &&
			latest !== mergeBase &&
			(await git(cwd, ["merge-base", "--is-ancestor", mergeBase, latest]).then(
				() => true,
				() => false,
			))
		) {
			mergeBase = latest;
			label = `origin/${baseBranch}`;
		}
	}
	return {
		mergeBase,
		base: mergeBase === label ? label : `${label} (${mergeBase.slice(0, 8)})`,
		...(branch ? { branch } : {}),
	};
}

/** Read NUL-delimited numstat records without interpreting tabs or newlines in filenames. */
function numstat(output: string): Map<string, LineStat> {
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

async function untrackedModes(cwd: string, paths: string[]): Promise<UntrackedFile[]> {
	if (!paths.length) return [];
	// Attributes and custom driver's binary flag affect --no-index numstat too. Preserve them without
	// invoking Git once per file, and use stdin so long filenames cannot overflow the argument limit.
	const attrs = (await git(cwd, ["check-attr", "-z", "--stdin", "diff"], false, `${paths.join("\0")}\0`)).split("\0");
	const configuredThreshold = (
		await git(cwd, ["config", "--type=int", "--get", "core.bigFileThreshold"], true)
	).trim();
	const bigFileThreshold = configuredThreshold ? Number(configuredThreshold) : 512 * 1024 * 1024;
	if (!Number.isSafeInteger(bigFileThreshold) || bigFileThreshold < 0) throw new Error("Invalid Git bigFileThreshold");
	const values = new Map<string, string>();
	for (let i = 0; i + 2 < attrs.length; i += 3) values.set(attrs[i]!, attrs[i + 2]!);
	const drivers = new Map<string, UntrackedFile["binary"]>();
	if ([...values.values()].some((value) => !["set", "unset", "unspecified"].includes(value))) {
		const config = await git(cwd, ["config", "--null", "--type=bool", "--get-regexp", "^diff\\..*\\.binary$"], true);
		for (const entry of config.split("\0")) {
			const match = /^diff\.(.*)\.binary\n(true|false)$/.exec(entry);
			if (match) drivers.set(match[1]!, match[2] === "true" ? "binary" : "text");
		}
	}
	return paths.map((path) => {
		const value = values.get(path);
		return {
			path,
			binary: value === "set" ? "text" : value === "unset" ? "binary" : (drivers.get(value ?? "") ?? "auto"),
			bigFileThreshold,
		};
	});
}

async function lineStats(cwd: string, mergeBase: string, untracked: string[]) {
	const stats = numstat(
		await git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "-M", mergeBase, "--"]),
	);
	const additions = await untrackedStats.read(cwd, await untrackedModes(cwd, untracked));
	for (let i = 0; i < untracked.length; i++) {
		// Recreated untracked paths replace staged deletions. Errors must not become fabricated zero counts.
		stats.set(untracked[i]!, additions[i]!);
	}
	return stats;
}

/** Count changed paths and lines without generating patches. Renames count once. */
export async function collectChangeSummary(
	cwd: string,
	base = "HEAD",
	baseBranch?: string,
): Promise<SessionChangeSummary> {
	return summarize(await collectMetadata(cwd, base, baseBranch));
}

interface ChangeMetadata {
	mergeBase: string;
	base: string;
	branch?: string;
	files: ChangedFile[];
	untracked: string[];
}

function summarize({ base, branch, files }: ChangeMetadata): SessionChangeSummary {
	let additions = 0;
	let deletions = 0;
	for (const stat of files) {
		additions += stat.additions;
		deletions += stat.deletions;
	}
	return { base, ...(branch ? { branch } : {}), fileCount: files.length, additions, deletions };
}

/**
 * Committed and uncommitted changes since `base` (default `HEAD`), including untracked files. Uses the
 * merge base, so commits that landed on the base branch afterwards are not shown as changes. With `baseBranch`,
 * a session rebased onto a newer `origin/<baseBranch>` is compared against that newer merge base instead.
 */
export async function collectChanges(cwd: string, base = "HEAD", baseBranch?: string): Promise<SessionChanges> {
	return collectPatch(cwd, await collectMetadata(cwd, base, baseBranch));
}

async function collectMetadata(cwd: string, base: string, baseBranch?: string): Promise<ChangeMetadata> {
	const { mergeBase, ...metadata } = await changeBase(cwd, base, baseBranch);

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
	return {
		mergeBase,
		...metadata,
		files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
		untracked,
	};
}

async function collectPatch(
	cwd: string,
	{ mergeBase, untracked, files, ...metadata }: ChangeMetadata,
): Promise<SessionChanges> {
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
		files,
		diff,
		truncated,
	};
}
