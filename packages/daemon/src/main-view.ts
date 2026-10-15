/** One daemon-managed, non-jj source view per project. Never fetches: consumes fetched main heads. */

import { type ChildProcess, fork } from "node:child_process";
import { chmod, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type CredentialEndpoint, credentialEnvironment } from "@pilot/kernel/credential-client";
import { forkLinuxCoordinator } from "./linux-coordinator.ts";
import { type Runner, run } from "./workspaces.ts";

async function permissions(path: string, writable: boolean): Promise<void> {
	const entry = await lstat(path);
	if (entry.isSymbolicLink()) return;
	if (entry.isDirectory()) {
		await chmod(path, writable ? 0o700 : 0o500);
		for (const child of await readdir(path)) await permissions(join(path, child), writable);
	} else await chmod(path, entry.mode & 0o111 ? (writable ? 0o700 : 0o500) : writable ? 0o600 : 0o400);
}

export class MainViewStore {
	private readonly queues = new Map<string, Promise<string>>();
	private readonly home: string;
	private readonly runner: Runner;
	constructor(home: string, runner: Runner = run) {
		this.home = home;
		this.runner = runner;
	}

	/** Git-only projects use a daemon-owned object store, never fetch into the user's checkout. */
	async fetch(projectId: string, upstream: string): Promise<{ repository: string; head: string }> {
		const repository = join(this.home, "main-views", projectId, "objects.git");
		await mkdir(repository, { recursive: true, mode: 0o700 });
		await this.runner("git", ["init", "--bare", "--quiet", "--template=", repository], this.home);
		await this.runner(
			"git",
			["-c", "core.hooksPath=/dev/null", "fetch", "--no-tags", upstream, "+HEAD:refs/heads/main"],
			repository,
		);
		const head = (await this.runner("git", ["rev-parse", "refs/heads/main"], repository)).trim();
		return { repository, head };
	}

	path(projectId: string): string {
		return join(this.home, "main-views", projectId, "source");
	}

	update(projectId: string, repository: string, head: string, upstream: string): Promise<string> {
		if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("Invalid main view head");
		const previous = this.queues.get(projectId) ?? Promise.resolve("");
		const task = previous
			.catch(() => "")
			.then(async () => {
				const path = this.path(projectId);
				const marker = join(this.home, "main-views", projectId, "head");
				if (
					(await readFile(marker, "utf8").catch(() => "")) === head &&
					(await lstat(join(path, ".git", "HEAD")).catch(() => undefined))?.isFile()
				)
					return path;
				await mkdir(path, { recursive: true, mode: 0o700 });
				await permissions(path, true);
				try {
					// No worktree registration, jj metadata, hooks, task ref or writable shared object store.
					await this.runner("git", ["init", "--quiet", path], this.home);
					await this.runner(
						"git",
						["-c", "core.hooksPath=/dev/null", "fetch", "--no-tags", repository, head],
						path,
					);
					await this.runner(
						"git",
						["-c", "core.hooksPath=/dev/null", "checkout", "--detach", "--force", head],
						path,
					);
					await this.runner("git", ["config", "remote.origin.url", upstream], path);
					await this.runner("git", ["config", "remote.origin.pushurl", "file:///dev/null/read-only"], path);
					await this.runner("git", ["config", "core.hooksPath", "/dev/null"], path);
				} finally {
					await permissions(path, false);
				}
				await writeFile(marker, head, { mode: 0o600 });
				return path;
			});
		this.queues.set(projectId, task);
		void task
			.finally(() => {
				if (this.queues.get(projectId) === task) this.queues.delete(projectId);
			})
			.catch(() => {});
		return task;
	}
}

/** Kernel and every descendant inherit this OS restriction. The daemon remains able to update the view. */
export function mainViewSandbox(paths: string[]): string {
	return `(version 1)(allow default)(deny file-write* ${paths.map((path) => `(subpath ${JSON.stringify(path)})`).join(" ")})`;
}

/** Fresh process, never a pre-forked unrestricted worker. All subprocesses inherit the sandbox. */
export async function forkMainViewWorker(
	entry: string,
	view: { scratch: string; protectedPaths: string[] },
	state?: { storageDir: string; agentDir: string; credentials?: CredentialEndpoint },
): Promise<ChildProcess> {
	if (process.platform === "linux" && state) return forkLinuxCoordinator(entry, view, state);
	if (process.platform !== "darwin")
		throw new Error("Coordinator OS isolation is unavailable on this host; refusing an unrestricted source worker");
	return fork(entry, [], {
		cwd: view.scratch,
		execPath: "/usr/bin/sandbox-exec",
		execArgv: ["-p", mainViewSandbox(view.protectedPaths), process.execPath],
		env: {
			...process.env,
			...credentialEnvironment(state?.credentials),
			TMPDIR: view.scratch,
			TMP: view.scratch,
			TEMP: view.scratch,
			GIT_OPTIONAL_LOCKS: "0",
		},
		serialization: "advanced",
		stdio: ["ignore", "inherit", "inherit", "ipc"],
	});
}
