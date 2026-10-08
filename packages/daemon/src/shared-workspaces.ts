/** Daemon-owned, independent jj repositories with disposable colocated child workspaces. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
	appendFile,
	chmod,
	copyFile,
	lstat,
	mkdir,
	open,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
	copyLocalConfigs,
	dissociateWorkspace,
	localConfigs,
	run,
	type Runner,
	type Workspace,
	validateBaseBranch,
} from "./workspaces.ts";

export interface SharedWorkspace {
	repository: string;
	name: string;
}

export interface WorkspaceRecovery {
	commitId: string;
	changeId: string;
	repository: string;
	name: string;
	path: string;
	/** Internal Git ref, never a bookmark and never exported by jj. */
	archiveRef: string;
	/** SHA-256 of bounded ignored inputs (mise configs and .pi/todos), relative to recoveryDirectory. */
	localConfigs: Record<string, string>;
}

interface Binding {
	path: string;
	state: "creating" | "ready" | "removing" | "removed" | "restoring";
	initialCommitId?: string;
	initialConfigs?: Record<string, string>;
	restoreCommitId?: string;
	creationBaseId?: string;
}

const queues = new Map<string, Promise<unknown>>();
const hash = (input: string | Buffer) => createHash("sha256").update(input).digest("hex");
const regenerable = new Set(["node_modules", "dist", "build", ".build", "coverage", ".next", ".nuxt", ".svelte-kit"]);
const recoverableInput = (path: string) =>
	localConfigs.includes(path) || /^\.pi\/todos\/[a-zA-Z0-9_-]+\.(md|json)$/.test(path);
const fullCommit = /^[0-9a-f]{40}$/;
const maintenance = ["-c", "maintenance.auto=false", "-c", "gc.auto=0", "-c", "fetch.writeCommitGraph=false"];
const networkEnvironment = new Set([
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

function workspaceEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return {
		...Object.fromEntries(
			Object.entries(env).filter(([key]) => !key.startsWith("GIT_") || networkEnvironment.has(key)),
		),
		// jj may invoke Git too. This is command-scoped, never a change to the source's config.
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "core.hooksPath",
		GIT_CONFIG_VALUE_0: "/dev/null",
	};
}

async function remoteUrl(source: string, url: string) {
	if (url.includes(":")) return url;
	const path = isAbsolute(url) ? url : resolve(source, url);
	// Local remotes can use /var aliases or directory symlinks. They are read-only fetch sources.
	return realpath(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
		return path;
	});
}

async function stat(path: string) {
	return lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
		return undefined;
	});
}

/** Canonicalize even a not-yet-created destination, without accepting a final symlink. */
async function canonical(path: string): Promise<string> {
	const entry = await stat(path);
	if (entry?.isSymbolicLink()) throw new Error(`Unsafe symlink: ${path}`);
	if (entry) return realpath(path);
	return join(await canonical(dirname(resolve(path))), basename(path));
}

async function atomicJson(path: string, value: unknown) {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.tmp`;
	if ((await stat(temporary))?.isSymbolicLink()) throw new Error("Unsafe metadata temporary file");
	const file = await open(temporary, "w", 0o600);
	try {
		await file.chmod(0o600);
		await file.writeFile(JSON.stringify(value));
		await file.sync();
	} finally {
		await file.close();
	}
	await rename(temporary, path);
}

/** Check every component, not just the final file (lstat alone follows parent links). */
async function safeFile(root: string, path: string): Promise<boolean> {
	const parts = path.split("/");
	if (parts.some((part) => !part || part === "." || part === "..")) return false;
	let current = root;
	for (const [index, part] of parts.entries()) {
		current = join(current, part);
		const entry = await stat(current);
		if (!entry || entry.isSymbolicLink() || (index < parts.length - 1 ? !entry.isDirectory() : !entry.isFile()))
			return false;
	}
	return true;
}

export class SharedWorkspaceStore {
	private readonly home: string;
	private readonly runner: Runner;
	constructor(home: string, runner: Runner = run) {
		this.home = home;
		this.runner = (file, args, cwd, timeout, signal, env) =>
			runner(
				file,
				file === "git" ? ["-c", "core.hooksPath=/dev/null", ...args] : args,
				cwd,
				timeout,
				signal,
				workspaceEnvironment(env),
			);
	}

	private async queue<T>(repository: string, action: () => Promise<T>): Promise<T> {
		const previous = queues.get(repository) ?? Promise.resolve();
		const next = previous.catch(() => {}).then(action);
		queues.set(repository, next);
		try {
			return await next;
		} finally {
			if (queues.get(repository) === next) queues.delete(repository);
		}
	}

	private async version(cwd: string) {
		const version = await this.runner("jj", ["--version"], cwd);
		const match = /jj (\d+)\.(\d+)\.(\d+)/.exec(version);
		if (!match || (Number(match[1]) === 0 && Number(match[2]) < 46))
			throw new Error(`Shared workspaces require jj >= 0.46.0 (found ${version})`);
	}

	private jj(args: string[], cwd: string, signal?: AbortSignal) {
		return this.runner("jj", ["--no-pager", "--color=never", ...args], cwd, undefined, signal);
	}

	private bindingPath(shared: SharedWorkspace) {
		return join(shared.repository, ".jj", "pilot-workspaces", `${shared.name}.json`);
	}

	private async repositoryOwned(repository: string, allowInitializing = false) {
		const repositories = await canonical(join(this.home, "repositories"));
		if (dirname(repository) !== repositories || !/^[0-9a-f]{64}$/.test(basename(repository)))
			throw new Error("Shared repository is not owned by this store");
		if ((await canonical(repository)) !== repository) throw new Error("Shared repository moved");
		if (!(await safeFile(repositories, `${basename(repository)}.json`)))
			throw new Error("Unsafe repository ownership file");
		const owner = JSON.parse(await readFile(`${repository}.json`, "utf8")) as { source: string; ready: boolean };
		if (
			typeof owner.source !== "string" ||
			(!owner.ready && !allowInitializing) ||
			hash(owner.source) !== basename(repository)
		)
			throw new Error("Invalid repository ownership");
		for (const directory of [
			".git",
			".git/objects",
			".git/objects/info",
			".git/refs",
			".git/worktrees",
			".jj",
			".jj/repo",
			".jj/repo/store",
			".jj/pilot-workspaces",
		]) {
			const entry = await stat(join(repository, directory));
			if (
				entry
					? !entry.isDirectory() || entry.isSymbolicLink()
					: owner.ready && [".git", ".jj", ".jj/repo", ".jj/pilot-workspaces"].includes(directory)
			)
				throw new Error("Unsafe managed repository metadata");
		}
		if (owner.ready) {
			const target = join(repository, ".jj/repo/store/git_target");
			if (
				!(await safeFile(repository, ".jj/repo/store/git_target")) ||
				(await realpath(resolve(dirname(target), (await readFile(target, "utf8")).trim()))) !==
					join(repository, ".git")
			)
				throw new Error("Managed jj store points outside its owned Git repository");
		}
		return owner;
	}

	private async owned(shared: SharedWorkspace, cwd: string): Promise<Binding> {
		if (!/^pilot-[a-zA-Z0-9_-]+-[0-9a-f]{16}$/.test(shared.name)) throw new Error("Invalid shared workspace name");
		await this.repositoryOwned(shared.repository);
		const bindingFile = this.bindingPath(shared);
		if (!(await safeFile(shared.repository, `.jj/pilot-workspaces/${shared.name}.json`)))
			throw new Error("Missing or unsafe workspace binding");
		const binding = JSON.parse(await readFile(bindingFile, "utf8")) as Binding;
		if (binding.path !== (await canonical(cwd)) || binding.path === shared.repository)
			throw new Error("Shared workspace path binding mismatch");
		return binding;
	}

	/** Resume initialization in place. Never remove the retained main repository. */
	private async initialize(source: string, repository: string) {
		const owner = await this.repositoryOwned(repository, true);
		if (owner.source !== source) throw new Error("Shared repository source mismatch");
		if (owner.ready) return;
		if (
			(await stat(join(repository, ".jj/pilot-workspaces"))) &&
			(await readdir(join(repository, ".jj/pilot-workspaces"))).length
		)
			throw new Error("Initializing repository unexpectedly contains child workspace bindings");
		await mkdir(repository, { recursive: true, mode: 0o700 });
		await this.runner("git", ["init", "--quiet", "--template=", repository], source);
		await this.runner("git", ["config", "core.hooksPath", "/dev/null"], repository);
		const commonDir = await this.runner("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], source);
		const alternates = join(repository, ".git/objects/info/alternates");
		if ((await stat(alternates))?.isSymbolicLink()) throw new Error("Unsafe shared alternates file");
		// Initialization owns the only borrowing phase; no child exists until dissociation completes.
		await writeFile(alternates, `${resolve(source, commonDir, "objects")}\n`);
		await this.runner("git", ["config", "core.alternateRefsCommand", "true"], repository);
		if (!(await this.optional("git", ["remote", "get-url", "origin"], repository)))
			await this.runner("git", ["remote", "add", "origin", source], repository);
		const base = await this.base(source, repository, undefined, this.runner);
		if (!(await stat(join(repository, ".jj")))) {
			await this.runner("git", ["checkout", "--quiet", "--detach", base.commitId], repository);
			await this.jj(["git", "init", "--colocate"], repository);
		} else {
			await this.jj(["git", "import"], repository);
		}
		if (!(await dissociateWorkspace(repository, this.runner)))
			throw new Error("Unable to dissociate shared repository");
		await mkdir(join(repository, ".jj/pilot-workspaces"), { recursive: true, mode: 0o700 });
		await atomicJson(`${repository}.json`, { source, ready: true });
	}

	private async registered(shared: SharedWorkspace): Promise<{ path: string; commitId: string } | undefined> {
		const fields = (
			await this.jj(
				[
					"--ignore-working-copy",
					"workspace",
					"list",
					"-T",
					'name ++ "\\0" ++ root.absolute() ++ "\\0" ++ target.commit_id() ++ "\\0"',
				],
				shared.repository,
			)
		).split("\0");
		for (let index = 0; index + 2 < fields.length; index += 3) {
			if (fields[index] === shared.name) return { path: fields[index + 1]!, commitId: fields[index + 2]! };
		}
		return undefined;
	}

	private async child(cwd: string, shared: SharedWorkspace) {
		const registered = await this.registered(shared);
		if (!registered || registered.path !== cwd) throw new Error("jj workspace path binding mismatch");
		if (!(await safeFile(cwd, ".jj/repo")) || !(await safeFile(cwd, ".git")))
			throw new Error("Unsafe child workspace metadata");
		const repository = (await readFile(join(cwd, ".jj/repo"), "utf8")).trim();
		if ((await realpath(resolve(cwd, ".jj", repository))) !== join(shared.repository, ".jj", "repo"))
			throw new Error("Child points to a different jj repository");
		const common = await this.runner("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
		if ((await realpath(common)) !== join(shared.repository, ".git"))
			throw new Error("Child points to a different Git repository");
		const gitDir = await this.runner("git", ["rev-parse", "--absolute-git-dir"], cwd);
		if (dirname(await realpath(gitDir)) !== join(shared.repository, ".git", "worktrees"))
			throw new Error("Child is not a Git worktree");
		if (
			(await realpath(resolve(gitDir, (await readFile(join(gitDir, "gitdir"), "utf8")).trim()))) !==
			join(cwd, ".git")
		)
			throw new Error("Git worktree path binding mismatch");
	}

	private async optional(file: string, args: string[], cwd: string, runner = this.runner) {
		try {
			return await runner(file, args, cwd);
		} catch {
			return undefined;
		}
	}

	private async base(source: string, repository: string, baseBranch: string | undefined, runner: Runner) {
		const sourceUpstream = await this.optional("git", ["remote", "get-url", "origin"], source, runner);
		const upstream = sourceUpstream ? await remoteUrl(source, sourceUpstream) : undefined;
		if (baseBranch !== undefined && !upstream)
			throw new Error("Cannot select baseBranch: project has no origin remote");
		await runner("git", ["remote", "set-url", "origin", upstream ?? source], repository);
		let branch: string | undefined;
		if (baseBranch !== undefined) {
			try {
				await runner(
					"git",
					[
						...maintenance,
						"fetch",
						"--quiet",
						"--no-tags",
						"--no-write-fetch-head",
						"origin",
						`+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
					],
					repository,
				);
			} catch (error) {
				throw new Error(`Origin branch unavailable: ${baseBranch}: ${error}`);
			}
			branch = baseBranch;
		} else {
			await runner(
				"git",
				[
					...maintenance,
					"fetch",
					"--quiet",
					"--no-tags",
					"--no-write-fetch-head",
					source,
					upstream ? "+refs/remotes/origin/*:refs/remotes/origin/*" : "+refs/heads/*:refs/remotes/origin/*",
				],
				repository,
			);
			if (upstream) {
				await this.optional("git", [...maintenance, "fetch", "--quiet", "origin"], repository, runner);
				const head =
					(await this.optional(
						"git",
						["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
						repository,
						runner,
					)) ||
					(await this.optional(
						"git",
						["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
						source,
						runner,
					));
				for (const candidate of [head, "origin/main", "origin/master"]) {
					if (
						candidate?.startsWith("origin/") &&
						(await this.optional(
							"git",
							["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`],
							repository,
							runner,
						))
					) {
						branch = candidate.slice(7);
						break;
					}
				}
			}
		}
		const commitId =
			branch !== undefined
				? await runner("git", ["rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`], repository)
				: await runner("git", ["rev-parse", "--verify", "HEAD^{commit}"], source);
		// A local-only source may have new commits since the one-time independent clone.
		if (branch === undefined)
			await runner(
				"git",
				[...maintenance, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", source, commitId],
				repository,
			);
		if (!fullCommit.test(commitId)) throw new Error("Invalid shared base commit");
		return { commitId, branch, upstream };
	}

	async create(source: string, destination: string, signal?: AbortSignal, baseBranch?: string): Promise<Workspace> {
		source = await canonical(source);
		destination = await canonical(destination);
		if (!(await stat(join(source, ".jj")))) throw new Error("Shared workspaces require a jj source project");
		await this.version(source);
		signal?.throwIfAborted();
		const runner: Runner = (file, args, cwd, timeout) => {
			signal?.throwIfAborted();
			return this.runner(file, args, cwd, timeout, signal);
		};
		if (baseBranch !== undefined) await validateBaseBranch(baseBranch, source, runner);
		const repository = await canonical(join(this.home, "repositories", hash(source)));
		return this.queue(repository, async () => {
			signal?.throwIfAborted();
			if (await stat(destination)) throw new Error("Shared workspace destination already exists");
			if (!(await stat(`${repository}.json`))) {
				if (await stat(repository)) throw new Error("Unowned repository exists at shared storage path");
				await atomicJson(`${repository}.json`, { source, ready: false });
			}
			// Bootstrap is persistent, not a session partial. Finish it even if the caller cancels.
			await this.initialize(source, repository);
			const name = `pilot-${
				basename(dirname(destination))
					.replace(/[^a-zA-Z0-9_-]/g, "_")
					.slice(0, 64) || "session"
			}-${hash(destination).slice(0, 16)}`;
			const shared = { repository, name };
			await this.repositoryOwned(repository);
			if (await this.registered(shared)) throw new Error("Shared workspace name is already registered");
			const binding: Binding = { path: destination, state: "creating" };
			await atomicJson(this.bindingPath(shared), binding);
			await this.owned(shared, destination);
			const base = await this.base(source, repository, baseBranch, runner);
			binding.creationBaseId = base.commitId;
			await atomicJson(this.bindingPath(shared), binding);
			await runner("git", ["update-ref", `refs/pilot/base/${name}`, base.commitId], repository);
			await this.jj(["git", "import"], repository, signal);
			await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
			await this.jj(
				[
					"workspace",
					"add",
					"--colocate",
					"--sparse-patterns=full",
					"--name",
					name,
					"-r",
					base.commitId,
					destination,
				],
				repository,
				signal,
			);
			await this.child(destination, shared);
			binding.initialCommitId = (await this.ids(destination)).commitId;
			await atomicJson(this.bindingPath(shared), binding);
			// Only the bounded local inputs come from the source, never its dirty tracked files.
			await copyLocalConfigs(source, destination, runner);
			binding.initialConfigs = await this.inspect(destination);
			binding.state = "ready";
			await atomicJson(this.bindingPath(shared), binding);
			signal?.throwIfAborted();
			return {
				path: destination,
				base: base.commitId,
				...(base.branch ? { baseBranch: base.branch } : {}),
				...(base.upstream ? { upstream: base.upstream } : {}),
				jj: true,
				shared,
			};
		});
	}

	private async ids(cwd: string) {
		const [commitId, changeId] = (
			await this.jj(
				["--ignore-working-copy", "log", "--no-graph", "-r", "@", "-T", 'commit_id ++ "\\0" ++ change_id'],
				cwd,
			)
		).split("\0");
		if (!commitId || !fullCommit.test(commitId) || !changeId || !/^[k-z]+$/.test(changeId))
			throw new Error("Invalid jj recovery IDs");
		return { commitId, changeId };
	}

	/** Compare the actual filesystem with jj's tree, including omitted large/auto-track-disabled files. */
	private async inspect(cwd: string, jj = true): Promise<Record<string, string>> {
		if (jj && (await this.jj(["--ignore-working-copy", "sparse", "list"], cwd)) !== ".")
			throw new Error("Automatic cleanup requires a full (non-sparse) jj workspace");
		const fields = jj
			? (
					await this.jj(
						["--ignore-working-copy", "file", "list", "-T", 'path ++ "\\0" ++ file_type ++ "\\0"'],
						cwd,
					)
				).split("\0")
			: (await this.runner("git", ["ls-files", "--stage", "-z"], cwd))
					.split("\0")
					.filter(Boolean)
					.flatMap((line) => [
						line.slice(line.indexOf("\t") + 1),
						line.startsWith("160000 ") ? "git-submodule" : "file",
					]);
		const tracked = new Set<string>();
		for (let index = 0; index + 1 < fields.length; index += 2) {
			if (fields[index + 1] === "git-submodule")
				throw new Error(`Submodule prevents automatic cleanup: ${fields[index]}`);
			tracked.add(fields[index]!);
		}
		// Collapse ignored trees so dependency directories never consume the command output budget.
		const ignored = (
			await this.runner("git", ["ls-files", "--others", "--ignored", "--directory", "--exclude-standard", "-z"], cwd)
		)
			.split("\0")
			.filter(Boolean);
		const isIgnored = (path: string) =>
			ignored.some((rule) => rule === path || (rule.endsWith("/") && path.startsWith(rule)));
		const configs: Record<string, string> = {};
		let inputBytes = 0;
		const walk = async (directory: string, prefix = "") => {
			for (const entry of await readdir(directory, { withFileTypes: true })) {
				const path = prefix + entry.name;
				if (!prefix && (path === ".git" || path === ".jj")) continue;
				if (entry.isDirectory()) {
					if (regenerable.has(entry.name) && ![...tracked].some((file) => file.startsWith(`${path}/`))) {
						// Only ignored outputs may be discarded. Unignored directories can contain inputs.
						if (await this.optional("git", ["check-ignore", "--", `${path}/`], cwd)) continue;
					}
					await walk(join(directory, entry.name), `${path}/`);
				} else if (!tracked.has(path)) {
					if (recoverableInput(path) && isIgnored(path) && (await safeFile(cwd, path))) {
						const size = (await lstat(join(cwd, path))).size;
						inputBytes += size;
						if (size > 1024 * 1024 || inputBytes > 4 * 1024 * 1024 || Object.keys(configs).length >= 256)
							throw new Error(
								"Ignored recovery inputs exceed safety limits (256 files, 1 MiB each, 4 MiB total)",
							);
						configs[path] = hash(await readFile(join(cwd, path)));
					} else
						throw new Error(
							`Unsafe ${isIgnored(path) ? "ignored" : "untracked or jj-omitted"} path prevents cleanup: ${path}`,
						);
				} else if (!entry.isFile() && !entry.isSymbolicLink()) {
					throw new Error(`Unsupported filesystem entry prevents cleanup: ${path}`);
				}
			}
		};
		await walk(cwd);
		return configs;
	}

	private validateRecovery(cwd: string, shared: SharedWorkspace, recovery: WorkspaceRecovery) {
		if (
			recovery.path !== cwd ||
			recovery.repository !== shared.repository ||
			recovery.name !== shared.name ||
			recovery.archiveRef !== `refs/pilot/archive/${shared.name}` ||
			!fullCommit.test(recovery.commitId) ||
			!/^[k-z]+$/.test(recovery.changeId) ||
			!recovery.localConfigs ||
			Object.keys(recovery.localConfigs).length > 256 ||
			Object.entries(recovery.localConfigs).some(
				([path, digest]) => !recoverableInput(path) || !/^[0-9a-f]{64}$/.test(digest),
			)
		)
			throw new Error("Invalid shared workspace recovery metadata");
	}

	private async pin(shared: SharedWorkspace, recovery: WorkspaceRecovery) {
		const pinned = await this.runner(
			"git",
			["rev-parse", "--verify", `${recovery.archiveRef}^{commit}`],
			shared.repository,
		);
		if (pinned !== recovery.commitId) throw new Error("Recovery archive pin mismatch");
		await this.runner("git", ["cat-file", "-e", `${recovery.commitId}^{tree}`], shared.repository);
		const changeId = await this.jj(
			["--ignore-working-copy", "log", "--no-graph", "-r", recovery.commitId, "-T", "change_id"],
			shared.repository,
		);
		if (changeId !== recovery.changeId) throw new Error("Recovery change ID mismatch");
	}

	async snapshot(cwd: string, shared: SharedWorkspace, recoveryDirectory: string): Promise<WorkspaceRecovery> {
		cwd = await canonical(cwd);
		return this.queue(shared.repository, async () => {
			await this.owned(shared, cwd);
			await this.child(cwd, shared);
			await this.jj(["status"], cwd);
			const ids = await this.ids(cwd);
			const configs = await this.inspect(cwd);
			recoveryDirectory = await canonical(recoveryDirectory);
			if (recoveryDirectory === cwd || recoveryDirectory.startsWith(`${cwd}/`))
				throw new Error("Recovery directory must be outside workspace");
			await mkdir(recoveryDirectory, { recursive: true, mode: 0o700 });
			for (const [path, digest] of Object.entries(configs)) {
				await this.copyInput(cwd, path, recoveryDirectory, `objects/${digest}`, digest);
			}
			const archiveRef = `refs/pilot/archive/${shared.name}`;
			await this.runner(
				"git",
				["-c", "core.fsync=reference", "update-ref", archiveRef, ids.commitId],
				shared.repository,
			);
			return {
				...ids,
				repository: shared.repository,
				name: shared.name,
				path: cwd,
				archiveRef,
				localConfigs: configs,
			};
		});
	}

	private async copyInput(source: string, sourcePath: string, destination: string, path: string, digest: string) {
		if (!(await safeFile(source, sourcePath)) || hash(await readFile(join(source, sourcePath))) !== digest)
			throw new Error(`Missing, changed or unsafe recovery input: ${sourcePath}`);
		const parent = join(destination, dirname(path));
		if ((await canonical(parent)) !== parent) throw new Error(`Unsafe recovery input parent: ${path}`);
		await mkdir(parent, { recursive: true, mode: 0o700 });
		const target = join(destination, path);
		if (await stat(target)) {
			if (!(await safeFile(destination, path)) || hash(await readFile(target)) !== digest)
				throw new Error(`Recovery input would overwrite existing data: ${path}`);
			return;
		}
		await copyFile(join(source, sourcePath), target, constants.COPYFILE_EXCL);
		await chmod(target, 0o600);
	}

	async remove(cwd: string, shared: SharedWorkspace, recovery: WorkspaceRecovery): Promise<void> {
		cwd = await canonical(cwd);
		return this.queue(shared.repository, async () => {
			const binding = await this.owned(shared, cwd);
			this.validateRecovery(cwd, shared, recovery);
			await this.pin(shared, recovery);
			if (!(await this.registered(shared)) && !(await stat(cwd))) {
				binding.state = "removed";
				await atomicJson(this.bindingPath(shared), binding);
				return;
			}
			if (!(await this.registered(shared)))
				throw new Error("Workspace was unregistered but its directory remains; partial removal needs review");
			await this.child(cwd, shared);
			await this.jj(["status"], cwd);
			if ((await this.ids(cwd)).commitId !== recovery.commitId)
				throw new Error("Workspace changed since recovery snapshot");
			if (JSON.stringify(await this.inspect(cwd)) !== JSON.stringify(recovery.localConfigs))
				throw new Error("Local inputs changed since recovery snapshot");
			binding.state = "removing";
			await atomicJson(this.bindingPath(shared), binding);
			await this.jj(["workspace", "remove", shared.name], shared.repository);
			if (await stat(cwd))
				throw new Error("jj did not remove the workspace directory; partial removal needs review");
			binding.state = "removed";
			await atomicJson(this.bindingPath(shared), binding);
		});
	}

	async restore(
		cwd: string,
		shared: SharedWorkspace,
		recovery: WorkspaceRecovery,
		recoveryDirectory: string,
	): Promise<void> {
		cwd = await canonical(cwd);
		return this.queue(shared.repository, async () => {
			const binding = await this.owned(shared, cwd);
			this.validateRecovery(cwd, shared, recovery);
			await this.version(shared.repository);
			await this.pin(shared, recovery);
			recoveryDirectory = await canonical(recoveryDirectory);
			for (const [path, digest] of Object.entries(recovery.localConfigs)) {
				if (
					!(await safeFile(recoveryDirectory, `objects/${digest}`)) ||
					hash(await readFile(join(recoveryDirectory, `objects/${digest}`))) !== digest
				)
					throw new Error(`Missing or unsafe recovery input: ${path}`);
			}
			if (await this.registered(shared)) {
				await this.child(cwd, shared);
				await this.jj(["status"], cwd);
				const current = await this.ids(cwd);
				if (current.commitId !== recovery.commitId) {
					if (
						binding.state !== "restoring" ||
						binding.restoreCommitId !== recovery.commitId ||
						(await this.jj(
							["--ignore-working-copy", "log", "--no-graph", "-r", "@-", "-T", "commit_id"],
							cwd,
						)) !== recovery.commitId ||
						(await this.jj(
							["--ignore-working-copy", "diff", "--from", recovery.commitId, "--to", "@", "--summary"],
							cwd,
						))
					)
						throw new Error("Existing workspace differs from recovery; refusing to overwrite edits");
					await this.inspect(cwd);
				}
			} else {
				if (await stat(cwd)) throw new Error("Restore destination contains unowned partial data");
				binding.state = "restoring";
				binding.restoreCommitId = recovery.commitId;
				await atomicJson(this.bindingPath(shared), binding);
				await mkdir(dirname(cwd), { recursive: true, mode: 0o700 });
				await this.jj(
					[
						"workspace",
						"add",
						"--colocate",
						"--sparse-patterns=full",
						"--name",
						shared.name,
						"-r",
						recovery.commitId,
						cwd,
					],
					shared.repository,
				);
				await this.child(cwd, shared);
			}
			// workspace add -r creates a *child*; edit restores the exact saved change, including conflicts.
			if ((await this.ids(cwd)).commitId !== recovery.commitId) await this.jj(["edit", recovery.commitId], cwd);
			const exclude = await this.runner("git", ["rev-parse", "--git-path", "info/exclude"], cwd);
			await appendFile(
				resolve(cwd, exclude),
				`\n# Pilot recovery inputs\n${Object.keys(recovery.localConfigs)
					.map((path) => `/${path}`)
					.join("\n")}\n`,
			);
			for (const [path, digest] of Object.entries(recovery.localConfigs))
				await this.copyInput(recoveryDirectory, `objects/${digest}`, cwd, path, digest);
			binding.state = "ready";
			await atomicJson(this.bindingPath(shared), binding);
		});
	}

	private async discardPrivate(cwd: string, source: string) {
		if (!(await stat(cwd))) return;
		if (
			cwd === source ||
			source.startsWith(`${cwd}/`) ||
			cwd === (await canonical(this.home)) ||
			cwd.startsWith(`${await canonical(join(this.home, "repositories"))}/`)
		)
			throw new Error("Cannot discard source or managed repository");
		const gitDirectory = await stat(join(cwd, ".git"));
		const jjRepository = await stat(join(cwd, ".jj/repo"));
		if (
			gitDirectory?.isFile() ||
			gitDirectory?.isSymbolicLink() ||
			jjRepository?.isFile() ||
			jjRepository?.isSymbolicLink()
		)
			throw new Error("Cannot discard an unowned linked workspace");
		if (!gitDirectory) {
			if ((await readdir(cwd)).length) throw new Error("Unowned partial workspace contains data");
			await rm(cwd, { recursive: true });
			return;
		}
		if (!gitDirectory.isDirectory()) throw new Error("Unsafe private clone metadata");
		if (
			(await this.runner("git", ["rev-parse", "--show-toplevel"], cwd)) !== cwd ||
			(await realpath(
				await this.runner("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd),
			)) !== join(cwd, ".git")
		)
			throw new Error("Private clone repository binding mismatch");
		let origin = await this.runner("git", ["remote", "get-url", "origin"], cwd);
		if (origin.startsWith("/") && (await stat(origin))) origin = await canonical(origin);
		const sourceUpstream = await this.optional("git", ["remote", "get-url", "origin"], source);
		const upstream = sourceUpstream ? await remoteUrl(source, sourceUpstream) : undefined;
		if (origin !== source && origin !== upstream) throw new Error("Private clone origin mismatch");
		if (await this.runner("git", ["status", "--porcelain", "--untracked-files=all"], cwd))
			throw new Error("Private partial workspace contains edits");
		if (await this.runner("git", ["branch", "--show-current"], cwd))
			throw new Error("Private partial workspace has a local branch");
		const hasJj = !!(await stat(join(cwd, ".jj")));
		if (hasJj) {
			if (!jjRepository?.isDirectory() || (await stat(join(cwd, ".jj")))?.isSymbolicLink())
				throw new Error("Unsafe private jj metadata");
			await this.jj(["status"], cwd);
			if (
				(await this.jj(["diff", "--from", "@-", "--to", "@", "--summary"], cwd)) ||
				(await this.jj(["bookmark", "list"], cwd))
			)
				throw new Error("Private partial jj workspace contains edits or bookmarks");
		}
		const configs = await this.inspect(cwd, hasJj);
		for (const [path, digest] of Object.entries(configs)) {
			if (!(await safeFile(source, path)) || hash(await readFile(join(source, path))) !== digest)
				throw new Error("Private partial local inputs contain edits");
		}
		await rm(cwd, { recursive: true });
	}

	/** Discard pristine private clones or owned creation state. Never rm a linked .git/.jj. */
	async discardPartial(cwd: string, source: string): Promise<void> {
		cwd = await canonical(cwd);
		source = await canonical(source);
		const repository = await canonical(join(this.home, "repositories", hash(source)));
		const shared = {
			repository,
			name: `pilot-${
				basename(dirname(cwd))
					.replace(/[^a-zA-Z0-9_-]/g, "_")
					.slice(0, 64) || "session"
			}-${hash(cwd).slice(0, 16)}`,
		};
		return this.queue(repository, async () => {
			if (!(await stat(this.bindingPath(shared)))) {
				await this.discardPrivate(cwd, source);
				return;
			}
			const binding = await this.owned(shared, cwd);
			if (!(await stat(cwd)) && !(await this.registered(shared))) return;
			if (!(await this.registered(shared)))
				throw new Error(
					"Partial workspace was unregistered but its directory remains; partial removal needs review",
				);
			await this.child(cwd, shared);
			if (binding.state !== "creating" && binding.state !== "ready")
				throw new Error("Workspace is not a partial creation");
			await this.jj(["status"], cwd);
			const configs = await this.inspect(cwd);
			if (binding.state === "ready") {
				if (
					!binding.initialCommitId ||
					(await this.ids(cwd)).commitId !== binding.initialCommitId ||
					JSON.stringify(configs) !== JSON.stringify(binding.initialConfigs ?? {})
				)
					throw new Error("Partial workspace may contain edits; refusing cleanup");
			} else {
				if (
					!binding.creationBaseId ||
					(await this.jj(["--ignore-working-copy", "log", "--no-graph", "-r", "@-", "-T", "commit_id"], cwd)) !==
						binding.creationBaseId ||
					(await this.jj(
						["--ignore-working-copy", "diff", "--from", binding.creationBaseId, "--to", "@", "--summary"],
						cwd,
					))
				)
					throw new Error("Partial workspace may contain edits; refusing cleanup");
				for (const [path, digest] of Object.entries(configs)) {
					if (!(await safeFile(source, path)) || hash(await readFile(join(source, path))) !== digest)
						throw new Error("Partial local inputs may contain edits; refusing cleanup");
				}
			}
			await this.jj(["workspace", "remove", shared.name], repository);
			if (await stat(cwd))
				throw new Error("jj did not remove the partial workspace directory; partial removal needs review");
			binding.state = "removed";
			await atomicJson(this.bindingPath(shared), binding);
		});
	}
}
