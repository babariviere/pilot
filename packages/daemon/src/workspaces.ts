/** Private working copies: each project session works in its own clone, on its own branch. */
import { spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { appendFile, copyFile, lstat, mkdir } from "node:fs/promises";
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
 * fetch it, and start detached from the remote's default branch. The agent chooses its own branch.
 * Ignored mise local configuration
 * is copied too; other uncommitted changes in the user's checkout stay there.
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
	// Pin the fallback before the agent commits: HEAD would otherwise move the diff's base with it.
	if (base === "HEAD") base = await runner("git", ["rev-parse", "HEAD"], destination);
	const clonedBranch = await runner("git", ["branch", "--show-current"], destination);
	await runner("git", ["switch", "--quiet", "--detach", base], destination);
	// A cloned source branch is not an agent choice. Do not import it as a local jj bookmark.
	if (clonedBranch) await runner("git", ["branch", "-D", "--", clonedBranch], destination);
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
