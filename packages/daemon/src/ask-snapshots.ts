/** Committed Ask sources live in a private object store, never a working copy. */
import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { AskContext } from "@pilot/kernel";
import { daemonGitEnvironment, NO_GIT_MAINTENANCE } from "./workspace-environment.ts";
import { type Runner, run, validateBaseBranch } from "./workspaces.ts";

const snapshotRef = "refs/pilot/ask-source";

export async function prepareAskSnapshot(
	ask: AskContext,
	providedRunner: Runner = run,
	signal?: AbortSignal,
): Promise<AskContext> {
	if (!ask.gitDir || !ask.branch) throw new Error("Ask snapshot requires gitDir and branch");
	const runner: Runner = (file, args, cwd, timeoutMs) => {
		signal?.throwIfAborted();
		return providedRunner(
			file,
			["-c", "core.hooksPath=/dev/null", ...args],
			cwd,
			timeoutMs,
			signal,
			daemonGitEnvironment(process.env, { preserveSnapshotCredentials: true }),
		);
	};
	await validateBaseBranch(ask.branch, ask.source, runner);
	const existing = await lstat(ask.gitDir).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
		return undefined;
	});
	if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
		throw new Error("Ask snapshot object store must be a private directory");
	await mkdir(ask.gitDir, { recursive: true, mode: 0o700 });
	const git = (args: string[]) => runner("git", ["--git-dir", ask.gitDir!, ...args], ask.gitDir!);
	// Retain the store across restarts, including a fetch completed before metadata was saved.
	await git(["init", "--bare", "--quiet", "--template="]);
	if (ask.commit) {
		await git(["cat-file", "-e", `${ask.commit}^{commit}`]);
		return ask;
	}
	let commit: string | undefined;
	try {
		commit = await git(["rev-parse", "--verify", `${snapshotRef}^{commit}`]);
	} catch {
		const upstream = await runner("git", ["remote", "get-url", "origin"], ask.source);
		if (!upstream) throw new Error("Cannot select baseBranch: project has no origin remote");
		// Git interprets relative local URLs from the repository's directory.
		const remote = !isAbsolute(upstream) && !upstream.includes(":") ? resolve(ask.source, upstream) : upstream;
		try {
			await git([
				...NO_GIT_MAINTENANCE,
				"fetch",
				"--quiet",
				"--depth=1",
				"--no-tags",
				"--no-write-fetch-head",
				"--",
				remote,
				`+refs/heads/${ask.branch}:${snapshotRef}`,
			]);
		} catch (error) {
			throw new Error(`Origin branch unavailable: ${ask.branch}: ${error instanceof Error ? error.message : error}`);
		}
		commit = await git(["rev-parse", "--verify", `${snapshotRef}^{commit}`]);
	}
	return { ...ask, commit };
}
