/** Private working copies: each project session works in its own clone, on its own branch. */
import { execFile } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { appendFile, copyFile, lstat, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface Workspace {
	path: string;
	branch: string;
	/** What the branch started from, such as `origin/main`. */
	base: string;
	/** The real remote, so pushes and pull requests go upstream rather than to the local checkout. */
	upstream?: string;
	/** Colocated jj repository (the source project uses jj). */
	jj: boolean;
}

export type Runner = (file: string, args: string[], cwd: string, timeoutMs?: number) => Promise<string>;

const run: Runner = async (file, args, cwd, timeoutMs = 120_000) => {
	const { stdout } = await exec(file, args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
	return stdout.trim();
};

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

/** "Fix the flaky reopen test!" -> "fix-the-flaky-reopen-test" */
export function branchSlug(title: string): string {
	return (
		title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40)
			.replace(/-+$/, "") || "task"
	);
}

/**
 * Clone `source` into `destination` (a fresh directory), point `origin` at the source's real remote,
 * fetch it, and start `branch` from the remote's default branch. Ignored mise local configuration
 * is copied too; other uncommitted changes in the user's checkout stay there.
 */
export async function createWorkspace(
	source: string,
	destination: string,
	branch: string,
	runner: Runner = run,
): Promise<Workspace> {
	if ((await attempt(runner, "git", ["rev-parse", "--is-inside-work-tree"], source)) !== "true")
		throw new Error(`Project is not a git repository: ${source}`);
	const upstream = await attempt(runner, "git", ["remote", "get-url", "origin"], source);
	// Local clones hardlink objects, so this is fast and does not touch the source's working copy.
	await runner("git", ["clone", "--quiet", source, destination], source);

	let base = "HEAD";
	if (upstream) {
		await runner("git", ["remote", "set-url", "origin", upstream], destination);
		// Offline is fine: fall back to what the local clone already has.
		const fetched = (await attempt(runner, "git", ["fetch", "--quiet", "origin"], destination)) !== undefined;
		if (fetched) {
			await attempt(runner, "git", ["remote", "set-head", "origin", "--auto"], destination);
			const head = await attempt(
				runner,
				"git",
				["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
				destination,
			);
			for (const candidate of [head, "origin/main", "origin/master"]) {
				if (
					candidate &&
					(await attempt(runner, "git", ["rev-parse", "--verify", "--quiet", candidate], destination))
				) {
					base = candidate;
					break;
				}
			}
		}
	}
	await runner("git", ["switch", "--quiet", "--no-track", "-c", branch, base], destination);
	await copyLocalConfigs(source, destination, runner);

	let jj = false;
	if (
		existsSync(join(source, ".jj")) &&
		(await attempt(runner, "jj", ["git", "init", "--colocate"], destination)) !== undefined
	) {
		jj = true;
	}
	return { path: destination, branch, base, ...(upstream ? { upstream } : {}), jj };
}
