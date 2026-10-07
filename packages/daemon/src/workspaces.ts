/** Private working copies: each project session works in its own clone. */
import { spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { appendFile, copyFile, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface Workspace {
	path: string;
	/** Chosen by the agent, absent while the clone is detached. */
	branch?: string;
	/** What the branch started from, such as `origin/main`. */
	base: string;
	/** The real remote, so pushes and pull requests go upstream rather than to the local checkout. */
	upstream?: string;
	/** Colocated jj repository (the source project uses jj). */
	jj: boolean;
}

export type Runner = (
	file: string,
	args: string[],
	cwd: string,
	timeoutMs?: number,
	signal?: AbortSignal,
) => Promise<string>;

const run: Runner = (file, args, cwd, timeoutMs = 120_000, signal) =>
	new Promise((resolve, reject) => {
		let failure: Error | undefined;
		let output = "";
		let stderr = "";
		let bytes = 0;
		let forceKill: ReturnType<typeof setTimeout> | undefined;
		const child = spawn(file, args, {
			cwd,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const kill = (killSignal: NodeJS.Signals) => {
			try {
				// Git can spawn fetch/SSH helpers. Stop the whole private process group on Unix.
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, killSignal);
				else child.kill(killSignal);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(killSignal);
			}
		};
		const abort = () => {
			failure ??= new Error("Workspace preparation aborted");
			kill("SIGTERM");
			forceKill = setTimeout(() => kill("SIGKILL"), 1_000);
		};
		const timeout = setTimeout(() => {
			failure = new Error(`Workspace command timed out: ${file} ${args.join(" ")}`);
			abort();
		}, timeoutMs);
		for (const [stream, isError] of [
			[child.stdout, false],
			[child.stderr, true],
		] as const) {
			stream.on("data", (chunk: Buffer) => {
				bytes += chunk.length;
				if (bytes > 16 * 1024 * 1024) {
					if (!failure) {
						failure = new Error("Workspace command output exceeded 16 MiB");
						abort();
					}
					return;
				}
				if (isError) stderr += chunk.toString();
				else output += chunk.toString();
			});
		}
		child.once("error", (error) => {
			failure = error;
		});
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		// Wait for process and stdio closure before clone cleanup/restart, not just an abort notification.
		child.once("close", (code) => {
			signal?.removeEventListener("abort", abort);
			clearTimeout(timeout);
			clearTimeout(forceKill);
			if (code !== 0) failure ??= new Error(`${file} ${args.join(" ")} failed: ${stderr.trim() || code}`);
			failure ? reject(failure) : resolve(output.trim());
		});
	});

async function attempt(runner: Runner, file: string, args: string[], cwd: string): Promise<string | undefined> {
	try {
		return await runner(file, args, cwd);
	} catch {
		return undefined;
	}
}

// Deliberately bounded: ignored dependency trees, build output and unrelated secrets are not workspace inputs.
const localConfigs = ["mise.local.toml", ".mise.local.toml", "mise/config.local.toml", ".mise/config.local.toml"];

async function statIfExists(path: string) {
	return lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
		return undefined;
	});
}

async function copyLocalConfigs(source: string, destination: string, runner: Runner): Promise<void> {
	const ignored = await runner(
		"git",
		["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...localConfigs],
		source,
	);
	const tracked = new Set((await runner("git", ["ls-files", "-z", "--", ...localConfigs], destination)).split("\0"));
	const copied: string[] = [];
	for (const path of ignored.split("\0").filter((path) => localConfigs.includes(path))) {
		const from = join(source, path);
		const to = join(destination, path);
		// Never replace checked-out files or follow a checked-out directory symlink.
		const parent = await statIfExists(dirname(to));
		if (parent && !parent.isDirectory()) continue;
		if (tracked.has(path) || (await statIfExists(to)) || !(await lstat(from)).isFile()) continue;
		await mkdir(dirname(to), { recursive: true });
		await copyFile(from, to, constants.COPYFILE_EXCL);
		copied.push(`/${path}`);
	}
	if (copied.length) {
		// Source rules may live in .git/info/exclude or a global ignore file, neither of which is cloned.
		const exclude = await runner("git", ["rev-parse", "--git-path", "info/exclude"], destination);
		await appendFile(resolve(destination, exclude), `\n# Pilot local configuration\n${copied.join("\n")}\n`);
	}
}

/** The checked-out Git branch, or the nearest local jj bookmark on the working copy's ancestry. */
export async function workspaceBranch(
	cwd: string,
	previous?: string,
	runner: Runner = run,
): Promise<string | undefined> {
	if (existsSync(join(cwd, ".jj"))) {
		const output = await runner(
			"jj",
			[
				"log",
				// Bookmarks live in the operation log. Snapshotting the working copy would scan the whole tree
				// on every poll and race the agent's own jj commands.
				"--ignore-working-copy",
				"--no-graph",
				"-r",
				"heads(::@ & bookmarks())",
				"-T",
				'local_bookmarks.map(|b| b.name()).join("\\n") ++ "\\n"',
			],
			cwd,
			10_000,
		);
		const names = [...new Set(output.trim().split("\n").filter(Boolean))];
		// Several bookmarks may share a commit. Do not guess which one is this session's branch.
		return previous && names.includes(previous) ? previous : names.length === 1 ? names[0] : undefined;
	}
	return (await runner("git", ["branch", "--show-current"], cwd, 10_000)).trim() || undefined;
}

/**
 * Clone `source` into `destination` (a fresh directory), point `origin` at the source's real remote,
 * fetch it, and start detached from the remote's default branch. Delivery policy determines the agent's branch.
 * Ignored mise local configuration is copied too; other uncommitted changes in the user's checkout stay there.
 *
 * The clone borrows the source's object store through Git alternates, so preparation never copies or
 * hardlinks objects (tens of thousands of loose objects make that take minutes). Call
 * {@link dissociateWorkspace} afterwards to make the clone self-contained.
 */
export async function createWorkspace(
	source: string,
	destination: string,
	providedRunner: Runner = run,
	signal?: AbortSignal,
): Promise<Workspace> {
	const runner: Runner = (file, args, cwd, timeoutMs) => {
		signal?.throwIfAborted();
		return providedRunner(file, args, cwd, timeoutMs, signal);
	};
	if ((await attempt(runner, "git", ["rev-parse", "--is-inside-work-tree"], source)) !== "true")
		throw new Error(`Project is not a git repository: ${source}`);
	const [upstream, commonDir, sourceHead] = await Promise.all([
		attempt(runner, "git", ["remote", "get-url", "origin"], source),
		runner("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], source),
		runner("git", ["rev-parse", "--verify", "HEAD"], source),
	]);
	await mkdir(destination, { recursive: true });
	await runner("git", ["init", "--quiet", destination], source);
	const gitDir = join(destination, ".git");
	await mkdir(join(gitDir, "objects", "info"), { recursive: true });
	await writeFile(join(gitDir, "objects", "info", "alternates"), `${resolve(source, commonDir, "objects")}\n`);
	await runner("git", ["remote", "add", "origin", upstream ?? source], destination);
	// Borrowed refs are not needed for negotiation once remote-tracking refs are seeded, and listing a
	// jj-managed source's refs (tens of thousands of refs/jj/keep entries) costs seconds per fetch.
	await runner("git", ["config", "core.alternateRefsCommand", "true"], destination);
	// Seed remote-tracking refs from the source's own view of origin. Objects are already shared, so this
	// transfers nothing, and an offline fetch below still leaves the remote's branches available.
	await runner(
		"git",
		[
			...noMaintenance,
			"fetch",
			"--quiet",
			"--no-tags",
			"--no-write-fetch-head",
			source,
			upstream ? "+refs/remotes/origin/*:refs/remotes/origin/*" : "+refs/heads/*:refs/remotes/origin/*",
		],
		destination,
	);

	let base: string | undefined;
	if (upstream) {
		// Offline is fine: fall back to what the source already knows about its remote.
		await attempt(runner, "git", [...noMaintenance, "fetch", "--quiet", "origin"], destination);
		// Recent Git records the remote HEAD during fetch. Otherwise ask the source, which has the same remote.
		const head =
			(await attempt(
				runner,
				"git",
				["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
				destination,
			)) ||
			(await attempt(runner, "git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], source));
		for (const candidate of [head, "origin/main", "origin/master"]) {
			if (
				candidate &&
				(await attempt(runner, "git", ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], destination))
			) {
				base = candidate;
				break;
			}
		}
	}
	// Pin the fallback before the agent commits: HEAD would otherwise move the diff's base with it.
	base ??= sourceHead;
	await runner("git", ["checkout", "--quiet", "--detach", base], destination);
	await copyLocalConfigs(source, destination, runner);

	let jj = false;
	if (
		existsSync(join(source, ".jj")) &&
		(await attempt(runner, "jj", ["git", "init", "--colocate"], destination)) !== undefined
	) {
		jj = true;
	}
	signal?.throwIfAborted();
	return { path: destination, base, ...(upstream ? { upstream } : {}), jj };
}

// Background maintenance would write commit-graphs that index borrowed commits the clone may not keep.
const noMaintenance = ["-c", "maintenance.auto=false", "-c", "gc.auto=0", "-c", "fetch.writeCommitGraph=false"];

/** Whether the workspace still borrows objects from its source project. */
export function workspaceBorrowsObjects(path: string): boolean {
	return existsSync(join(path, ".git", "objects", "info", "alternates"));
}

/**
 * Copy every object the workspace can reach into its own store, then stop borrowing from the source.
 * Safe while the agent works: repacking is how `git gc` runs too. Refs created during the repack are
 * caught by repeating it until they settle.
 */
export async function dissociateWorkspace(path: string, providedRunner: Runner = run, signal?: AbortSignal) {
	const alternates = join(path, ".git", "objects", "info", "alternates");
	if (!existsSync(alternates)) return true;
	const runner: Runner = (file, args, cwd, timeoutMs) => {
		signal?.throwIfAborted();
		return providedRunner(file, args, cwd, timeoutMs, signal);
	};
	const refs = async () =>
		`${await attempt(runner, "git", ["rev-parse", "--verify", "--quiet", "HEAD"], path)}\n${await runner(
			"git",
			["for-each-ref", "--format=%(objectname) %(refname)"],
			path,
		)}`;
	let before = await refs();
	for (let round = 0; round < 5; round++) {
		// Without --local, repack copies borrowed objects reachable from HEAD, refs, reflogs and the index.
		await runner("git", [...noMaintenance, "repack", "-a", "-d", "--quiet"], path, 60 * 60_000);
		const after = await refs();
		if (after === before) {
			signal?.throwIfAborted();
			await rm(alternates, { force: true });
			// A commit-graph is only a cache. One written while borrowing may index commits no longer present.
			const info = join(path, ".git", "objects", "info");
			await rm(join(info, "commit-graph"), { force: true });
			await rm(join(info, "commit-graphs"), { recursive: true, force: true });
			return true;
		}
		before = after;
	}
	// Refs kept moving. Keep borrowing, which is always correct, and try again later.
	return false;
}
