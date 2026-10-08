/** Committed Ask sources live in a private object store, never a working copy. */
import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { AskContext } from "@pilot/kernel";
import { run, type Runner, validateBaseBranch } from "./workspaces.ts";

const snapshotRef = "refs/pilot/ask-source";

/** Keep network authentication, but never inherit repository/config/object-store redirection. */
function snapshotEnvironment(): NodeJS.ProcessEnv {
	const network = new Set([
		"GIT_ASKPASS",
		"GIT_SSH",
		"GIT_SSH_COMMAND",
		"GIT_SSH_VARIANT",
		"GIT_TERMINAL_PROMPT",
		"GIT_SSL_CAINFO",
		"GIT_SSL_CAPATH",
		"GIT_SSL_NO_VERIFY",
		"GIT_PROXY_COMMAND",
		"GIT_HTTP_USER_AGENT",
	]);
	return Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_") || network.has(key)),
	);
}

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
			snapshotEnvironment(),
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
				"-c",
				"maintenance.auto=false",
				"-c",
				"gc.auto=0",
				"-c",
				"fetch.writeCommitGraph=false",
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
