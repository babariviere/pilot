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

async function directory(path: string): Promise<boolean> {
	return lstat(path).then(
		(entry) => entry.isDirectory(),
		(error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
			return false;
		},
	);
}

export class MainViewStore {
	private readonly queues = new Map<string, Promise<unknown>>();
	private readonly maintained = new Map<string, number>();
	private readonly home: string;
	private readonly runner: Runner;
	constructor(home: string, runner: Runner = run) {
		this.home = home;
		this.runner = runner;
	}

	/** Git-only projects use a daemon-owned object store, never fetch into the user's checkout. */
	async fetch(projectId: string, upstream: string): Promise<{ repository: string; head: string }> {
		return this.queue(projectId, async () => {
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
		});
	}

	path(projectId: string): string {
		return join(this.home, "main-views", projectId, "source");
	}

	update(projectId: string, repository: string, head: string, upstream: string): Promise<string> {
		if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("Invalid main view head");
		return this.queue(projectId, async () => {
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
				await this.runner("git", ["-c", "core.hooksPath=/dev/null", "fetch", "--no-tags", repository, head], path);
				await this.runner("git", ["-c", "core.hooksPath=/dev/null", "checkout", "--detach", "--force", head], path);
				await this.runner("git", ["config", "remote.origin.url", upstream], path);
				await this.runner("git", ["config", "remote.origin.pushurl", "file:///dev/null/read-only"], path);
				await this.runner("git", ["config", "core.hooksPath", "/dev/null"], path);
			} finally {
				await permissions(path, false);
			}
			await writeFile(marker, head, { mode: 0o600 });
			return path;
		});
	}

	/** Git-only views are not covered by shared-repository jj GC. Never prune immediately. */
	async maintain(now = Date.now(), signal?: AbortSignal): Promise<void> {
		const root = join(this.home, "main-views");
		const projects = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
			return [];
		});
		for (const project of projects) {
			if (signal?.aborted) return;
			if (!project.isDirectory()) continue;
			try {
				await this.queue(project.name, async () => {
					if (signal?.aborted) return;
					const day = 86_400_000;
					const marker = join(root, project.name, "gc-at");
					const previous =
						this.maintained.get(project.name) ?? Number(await readFile(marker, "utf8").catch(() => ""));
					if (Number.isFinite(previous) && previous > 0 && now - previous < day) return;
					// Failed maintenance retries tomorrow, not on every minute's sweep.
					this.maintained.set(project.name, now);
					const source = this.path(project.name);
					if ((await directory(source)) && (await directory(join(source, ".git")))) {
						const metadata = join(source, ".git");
						try {
							await permissions(metadata, true);
							await this.runner("git", ["-c", "core.hooksPath=/dev/null", "gc"], source, 10 * 60_000, signal);
						} finally {
							// Source stays read-only throughout; reseal new Git files too.
							await permissions(metadata, false);
						}
					}
					const objects = join(root, project.name, "objects.git");
					if (await directory(objects))
						await this.runner("git", ["-c", "core.hooksPath=/dev/null", "gc"], objects, 10 * 60_000, signal);
					if (signal?.aborted) return;
					await writeFile(marker, String(now), { mode: 0o600 });
				});
			} catch (error) {
				if (!signal?.aborted) console.warn(`pilotd: could not maintain main view ${project.name}: ${error}`);
			}
		}
	}

	private queue<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
		const task = (this.queues.get(projectId) ?? Promise.resolve()).catch(() => {}).then(operation);
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
