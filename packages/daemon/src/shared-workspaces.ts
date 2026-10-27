/** Daemon-owned, independent jj repositories with disposable colocated child workspaces. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
	appendFile,
	chmod,
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { SessionPullRequest } from "@pilot/protocol";
import { mergedPullRequestHead } from "./pr-auto-rebase.ts";
import { workspaceBookmarks, workspaceChangeIds } from "./pull-requests.ts";
import { authenticationHint, gitPromptlessEnvironment, toolTrustEnvironment } from "./workspace-environment.ts";
import {
	copyLocalConfigs,
	dissociateWorkspace,
	localConfigs,
	type Runner,
	run,
	validateBaseBranch,
	type Workspace,
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
	/** SHA-256 of bounded ignored mise configs, relative to recoveryDirectory. */
	localConfigs: Record<string, string>;
}

interface Binding {
	path: string;
	state: "creating" | "ready" | "removing" | "removed" | "restoring";
	initialCommitId?: string;
	restoreCommitId?: string;
	creationBaseId?: string;
}

const queues = new Map<string, Promise<unknown>>();
const hash = (input: string | Buffer) => createHash("sha256").update(input).digest("hex");
const recoverableInput = (path: string) => localConfigs.includes(path);
const recoveryInputDirectory = (path: string) => localConfigs.some((config) => config.startsWith(`${path}/`));
const fullCommit = /^[0-9a-f]{40}$/;
/** Where a child's gitdir file is hidden while jj updates or snapshots it without importing Git refs. */
const PARKED_GIT = ".jj/pilot-refresh-git";
/** Exact file/mode/blob transitions, unlike patch-id which normalizes away whitespace edits. */
const changeFingerprint = (raw: string) => {
	const lines = raw.split("\n").filter((line) => line.startsWith(":"));
	return lines.length ? hash(lines.join("\n")) : undefined;
};
const maintenance = ["-c", "maintenance.auto=false", "-c", "gc.auto=0", "-c", "fetch.writeCommitGraph=false"];
const DAY_MS = 86_400_000;
/** `jj util gc` runs `git gc`, which can take minutes on a large repository. */
const GC_TIMEOUT_MS = 10 * 60_000;
const baseRefs = "refs/pilot/origin/";
const baseRemote = "pilot-base";
const networkEnvironment = new Set([
	"GIT_SSH",
	"GIT_SSH_COMMAND",
	"GIT_SSH_VARIANT",
	"GIT_SSL_CAINFO",
	"GIT_SSL_CAPATH",
	"GIT_SSL_NO_VERIFY",
	"GIT_PROXY_COMMAND",
	"GIT_HTTP_USER_AGENT",
]);

function workspaceEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return {
		...gitPromptlessEnvironment(
			toolTrustEnvironment(
				Object.fromEntries(
					Object.entries(env).filter(([key]) => !key.startsWith("GIT_") || networkEnvironment.has(key)),
				),
			),
		),
		// jj may invoke Git too. This is command-scoped, never a change to the source's config.
		GIT_CONFIG_COUNT: "2",
		GIT_CONFIG_KEY_0: "core.hooksPath",
		GIT_CONFIG_VALUE_0: "/dev/null",
		// Global pruneTags can add an implicit tags refspec even when fetching only a private base.
		GIT_CONFIG_KEY_1: "fetch.pruneTags",
		GIT_CONFIG_VALUE_1: "false",
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
	/** Unwrapped runner, for the one Git check that needs its own GIT_INDEX_FILE. */
	private readonly baseRunner: Runner;
	private readonly runner: Runner;
	/** Last maintenance attempt per repository in this process, so failures are not retried every sweep. */
	private readonly maintained = new Map<string, number>();
	constructor(home: string, runner: Runner = run) {
		this.home = home;
		this.baseRunner = runner;
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

	/** Managed repository paths. Ownership is checked by each operation. */
	async repositories(): Promise<string[]> {
		const directory = await canonical(join(this.home, "repositories"));
		const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
			return [];
		});
		return entries
			.filter((entry) => entry.isDirectory() && /^[0-9a-f]{64}$/.test(entry.name))
			.map((entry) => join(directory, entry.name));
	}

	/**
	 * Daemon Git commands disable automatic GC. At most once a day, `jj util gc` drops jj data no operation still
	 * references and runs `git gc`, which packs loose objects and prunes unreachable ones older than two weeks.
	 * Merged task bookmarks are forgotten and superseded local copies of landed commits abandoned first, so their
	 * data can be collected too.
	 */
	async maintain(repository: string, now = Date.now()): Promise<boolean> {
		const attempted = this.maintained.get(repository);
		if (attempted !== undefined && now - attempted < DAY_MS) return false;
		// Set before any failure, so a broken repository is retried daily rather than on every sweep.
		this.maintained.set(repository, now);
		return this.queue(repository, async () => {
			await this.repositoryOwned(repository);
			const marker = join(repository, ".jj", "pilot-maintenance.json");
			const previous = await readFile(marker, "utf8").then(
				(text) => (JSON.parse(text) as { at?: unknown }).at,
				() => undefined,
			);
			if (typeof previous === "number" && now - previous < DAY_MS) {
				this.maintained.set(repository, previous);
				return false;
			}
			await atomicJson(marker, { at: now });
			try {
				await this.cleanupLanded(repository, await this.control(repository));
			} catch (error) {
				console.warn(`pilotd: could not clean up superseded commits in ${repository}: ${error}`);
			}
			await this.runner(
				"jj",
				["--no-pager", "--color=never", "--ignore-working-copy", "util", "gc"],
				repository,
				GC_TIMEOUT_MS,
			);
			return true;
		});
	}

	/**
	 * A commit rewritten outside this repository (PR auto-rebase, another checkout) keeps its change ID, so once
	 * fetched from origin the local original turns divergent and stays visible. An original is superseded when a
	 * landed copy has exactly the same diff.
	 *
	 * Forget local bookmarks whose every target is on trunk or superseded by a trunk copy: their work merged, and
	 * forgetting, unlike deleting, never pushes a branch deletion. Then abandon superseded originals that no
	 * workspace, bookmark, tag or remote bookmark reaches and nothing else builds on. Amended originals stay.
	 */
	private async cleanupLanded(repository: string, control: string) {
		const rows = async (revset: string) =>
			(
				await this.jj(
					[
						"--ignore-working-copy",
						"log",
						"--no-graph",
						"--limit",
						"1000",
						"-r",
						revset,
						"-T",
						'change_id ++ "\\t" ++ commit_id ++ "\\t" ++ parents.len() ++ "\\n"',
					],
					control,
				)
			)
				.split("\n")
				.filter(Boolean)
				.map((line) => line.split("\t") as [string, string, string]);
		const fingerprints = new Map<string, string | undefined>();
		const fingerprint = async (commit: string) => {
			if (!fingerprints.has(commit))
				fingerprints.set(
					commit,
					changeFingerprint(
						await this.runner(
							"git",
							["diff-tree", "--no-commit-id", "--raw", "--no-renames", "-r", commit],
							repository,
						),
					),
				);
			return fingerprints.get(commit);
		};
		const superseded = async (originals: [string, string, string][], landedRevset: string) => {
			const landed = new Map<string, string[]>();
			for (const [change, commit, parents] of await rows(`divergent() & ${landedRevset}`))
				if (parents === "1") landed.set(change, [...(landed.get(change) ?? []), commit]);
			const result = new Set<string>();
			for (const [change, commit, parents] of originals) {
				const copies = landed.get(change);
				if (parents !== "1" || !copies || !fullCommit.test(commit)) continue;
				const own = await fingerprint(commit);
				for (const copy of copies) {
					if (own && own === (await fingerprint(copy))) {
						result.add(commit);
						break;
					}
				}
			}
			return result;
		};
		const bookmarks = (
			await this.jj(
				[
					"--ignore-working-copy",
					"bookmark",
					"list",
					"-T",
					'if(remote, "", name ++ "\\t" ++ self.added_targets().map(|c| c.commit_id()).join(",") ++ "\\n")',
				],
				control,
			)
		)
			.split("\n")
			.map((line) => line.split("\t"))
			.map(([name = "", targets = ""]) => ({ name, targets: targets.split(",").filter(Boolean) }))
			.filter(({ name, targets }) => targets.length && !["main", "master", "trunk"].includes(name));
		const targets = [...new Set(bookmarks.flatMap((bookmark) => bookmark.targets))];
		if (targets.length && targets.every((target) => fullCommit.test(target))) {
			// trunk() needs origin/HEAD, which an independent clone may lack.
			const trunk =
				'::(trunk() | remote_bookmarks(exact:"main", remote=exact:"origin") | ' +
				'remote_bookmarks(exact:"master", remote=exact:"origin"))';
			const set = `(${targets.join(" | ")})`;
			const merged = new Set((await rows(`${set} & ${trunk}`)).map(([, commit]) => commit));
			for (const commit of await superseded(await rows(`(${set} ~ ${trunk}) & divergent()`), trunk))
				merged.add(commit);
			const names = bookmarks
				.filter((bookmark) => bookmark.targets.every((target) => merged.has(target)))
				.map((bookmark) => `exact:${bookmark.name}`);
			if (names.length) {
				await this.jj(["--ignore-working-copy", "bookmark", "forget", ...names], control);
				// The control workspace is not colocated. Export now, or the next import in an agent's colocated
				// workspace would restore the bookmarks from their stale Git refs.
				await this.jj(["--ignore-working-copy", "git", "export"], control);
			}
		}
		const loose = await rows("divergent() ~ ::(working_copies() | bookmarks() | remote_bookmarks() | tags())");
		if (!loose.length) return;
		const originals = [...(await superseded(loose, '::remote_bookmarks(remote=exact:"origin")'))];
		if (!originals.length) return;
		const set = `(${originals.join(" | ")})`;
		// Abandoning rebases descendants, so keep any original that something else builds on.
		const safe = (await rows(`${set} ~ ::((${set}::) ~ ${set})`)).map(([, commit]) => commit);
		if (safe.length) await this.jj(["--ignore-working-copy", "abandon", ...safe], control);
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
			".jj/pilot-base.git",
			".jj/pilot-base.git/objects",
			".jj/pilot-base.git/objects/info",
			".jj/pilot-base.git/refs",
			".jj/pilot-base.git/refs/heads",
			".jj/pilot-control",
			".jj/pilot-control/.jj",
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
		await this.jjChild(cwd, shared);
		if (!(await safeFile(cwd, ".git"))) throw new Error("Unsafe child workspace metadata");
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

	private async jjChild(cwd: string, shared: SharedWorkspace) {
		const registered = await this.registered(shared);
		if (!registered || registered.path !== cwd) throw new Error("jj workspace path binding mismatch");
		if (!(await safeFile(cwd, ".jj/repo"))) throw new Error("Unsafe child workspace metadata");
		const repository = (await readFile(join(cwd, ".jj/repo"), "utf8")).trim();
		if ((await realpath(resolve(cwd, ".jj", repository))) !== join(shared.repository, ".jj", "repo"))
			throw new Error("Child points to a different jj repository");
	}

	private async materialize(cwd: string, shared: SharedWorkspace, signal?: AbortSignal) {
		await this.jjChild(cwd, shared);
		if (!(await stat(join(cwd, ".git")))) {
			// update-stale imports Git refs too, so only run it before colocation is enabled.
			await this.jj(["workspace", "update-stale"], cwd, signal);
		} else await this.child(cwd, shared);
	}

	private async colocate(cwd: string, shared: SharedWorkspace, signal?: AbortSignal) {
		if (!(await stat(join(cwd, ".git"))))
			await this.jj(["--ignore-working-copy", "git", "colocation", "enable"], cwd, signal);
		await this.child(cwd, shared);
	}

	/** Restore a child's gitdir file hidden by an interrupted refresh or snapshot. */
	private async unparkGit(cwd: string) {
		const marker = join(cwd, ".git");
		if (!(await stat(join(cwd, PARKED_GIT)))) return;
		if ((await stat(marker)) || !(await safeFile(cwd, PARKED_GIT)))
			throw new Error("Unsafe interrupted refresh metadata");
		await rename(join(cwd, PARKED_GIT), marker);
	}

	/**
	 * Snapshot this child's filesystem. Another workspace may have rewritten its working-copy commit, leaving it
	 * stale, so update it first. Hide the gitdir file meanwhile so neither command imports shared Git refs.
	 */
	private async snapshotChild(cwd: string, shared: SharedWorkspace) {
		await this.jjChild(cwd, shared);
		await this.unparkGit(cwd);
		await this.child(cwd, shared);
		await rename(join(cwd, ".git"), join(cwd, PARKED_GIT));
		try {
			await this.jj(["workspace", "update-stale"], cwd);
			await this.jj(["status"], cwd);
		} finally {
			await rename(join(cwd, PARKED_GIT), join(cwd, ".git"));
		}
	}

	/** A retained, empty non-colocated command workspace. Never snapshot/import the default workspace. */
	private async control(repository: string, signal?: AbortSignal) {
		const shared = { repository, name: "pilot-control" };
		const path = join(repository, ".jj/pilot-control");
		if (!(await this.registered(shared))) {
			if (await stat(path)) throw new Error("Unowned partial control workspace requires review");
			await this.jj(
				[
					"--ignore-working-copy",
					"workspace",
					"add",
					"--no-colocate",
					"--sparse-patterns=full",
					"--name",
					shared.name,
					"-r",
					"root()",
					path,
				],
				repository,
				signal,
			);
		}
		await this.jjChild(path, shared);
		if (await stat(join(path, ".git"))) throw new Error("Control workspace must not be colocated");
		// Also resumes a crash after adding the control workspace but before its empty checkout.
		await this.jj(["workspace", "update-stale"], path, signal);
		return path;
	}

	private async optional(file: string, args: string[], cwd: string, runner = this.runner) {
		try {
			return await runner(file, args, cwd);
		} catch {
			return undefined;
		}
	}

	/**
	 * Seed the daemon's private base cache from the source's possibly stale origin view. Never write agent-owned
	 * refs/remotes/origin. Only missing refs and fast-forwards are accepted, including a CAS for missing refs.
	 */
	private async seedRemoteRefs(source: string, repository: string, runner: Runner) {
		const staging = "refs/pilot/source-origin/";
		await runner(
			"git",
			[
				...maintenance,
				"fetch",
				"--quiet",
				"--no-tags",
				"--no-write-fetch-head",
				"--refmap=",
				"--prune",
				source,
				`+refs/remotes/origin/*:${staging}*`,
			],
			repository,
		);
		const refs = async (prefix: string) => {
			const output = await runner("git", ["for-each-ref", "--format=%(objectname) %(refname)", prefix], repository);
			const map = new Map<string, string>();
			for (const line of output.split("\n")) {
				const space = line.indexOf(" ");
				if (space > 0) map.set(line.slice(space + 1).slice(prefix.length), line.slice(0, space));
			}
			return map;
		};
		const [seeded, current] = await Promise.all([refs(staging), refs(baseRefs)]);
		for (const [name, commit] of seeded) {
			// origin/HEAD is a symbolic ref. Updating it would move whichever branch it points to.
			if (name === "HEAD") continue;
			const existing = current.get(name);
			if (existing === commit) continue;
			if (
				existing &&
				(await this.optional("git", ["merge-base", "--is-ancestor", existing, commit], repository, runner)) ===
					undefined
			)
				continue;
			// The old value guards against a concurrent fetch. Losing that race keeps the newer ref.
			await this.optional(
				"git",
				["update-ref", `${baseRefs}${name}`, commit, existing ?? "0".repeat(40)],
				repository,
				runner,
			);
		}
	}

	private async base(
		source: string,
		repository: string,
		baseBranch: string | undefined,
		runner: Runner,
		requireFetch = false,
	) {
		const sourceUpstream = await this.optional("git", ["remote", "get-url", "origin"], source, runner);
		const upstream = sourceUpstream ? await remoteUrl(source, sourceUpstream) : undefined;
		if (requireFetch && baseBranch === undefined) baseBranch = "main";
		if (baseBranch !== undefined && !upstream && !requireFetch)
			throw new Error("Cannot select baseBranch: project has no origin remote");
		await runner("git", ["remote", "set-url", "origin", upstream ?? source], repository);
		let branch: string | undefined;
		let fetched = false;
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
						"--refmap=",
						"origin",
						`+refs/heads/${baseBranch}:${baseRefs}${baseBranch}`,
					],
					repository,
				);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				throw new Error(`Origin branch unavailable: ${baseBranch}: ${reason}${authenticationHint(reason)}`);
			}
			branch = baseBranch;
		} else {
			if (upstream) await this.seedRemoteRefs(source, repository, runner);
			else
				await runner(
					"git",
					[
						...maintenance,
						"fetch",
						"--quiet",
						"--no-tags",
						"--no-write-fetch-head",
						"--refmap=",
						source,
						`+refs/heads/*:${baseRefs}*`,
					],
					repository,
				);
			if (upstream) {
				fetched =
					(await this.optional(
						"git",
						[
							...maintenance,
							"fetch",
							"--quiet",
							"--no-tags",
							"--no-write-fetch-head",
							"--refmap=",
							"origin",
							`+refs/heads/*:${baseRefs}*`,
						],
						repository,
						runner,
					)) !== undefined;
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
							["rev-parse", "--verify", "--quiet", `${baseRefs}${candidate.slice(7)}^{commit}`],
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
		let commitId =
			branch !== undefined
				? await runner("git", ["rev-parse", "--verify", `${baseRefs}${branch}^{commit}`], repository)
				: await runner("git", ["rev-parse", "--verify", "HEAD^{commit}"], source);
		if (branch !== undefined && baseBranch === undefined && !fetched) {
			// Existing repositories and agents may have a fresher jj view than the source or our cache.
			const cached = await this.optional(
				"jj",
				[
					"--ignore-working-copy",
					"log",
					"--no-graph",
					"-r",
					`remote_bookmarks(exact:${JSON.stringify(branch)}, remote=exact:"origin")`,
					"-T",
					"commit_id",
				],
				repository,
				runner,
			);
			if (
				cached &&
				fullCommit.test(cached) &&
				(await this.optional("git", ["merge-base", "--is-ancestor", commitId, cached], repository, runner)) !==
					undefined
			)
				commitId = cached;
		}
		// A local-only source may have new commits since the one-time independent clone.
		if (branch === undefined)
			await runner(
				"git",
				[...maintenance, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--refmap=", source, commitId],
				repository,
			);
		if (!fullCommit.test(commitId)) throw new Error("Invalid shared base commit");
		return { commitId, branch, upstream };
	}

	/**
	 * jj cannot resolve a previously unseen Git hash without indexing it. Give it a private base ref via a tiny
	 * local remote borrowing only this owned repository's objects. A filtered jj fetch imports that hash alone,
	 * not stale/deleted Git refs belonging to agents. The remote holds only the newest base, so the same fetch
	 * prunes earlier base bookmarks, which would otherwise be copied into every later operation's view. Their
	 * commits stay visible because unreachable commits are never abandoned here.
	 */
	private async importBase(repository: string, control: string, commitId: string, signal?: AbortSignal) {
		// Repeated launches normally reuse an indexed base. Avoid a local fetch and extra ref metadata then.
		if (
			(await this.optional(
				"jj",
				["--ignore-working-copy", "log", "--no-graph", "-r", commitId, "-T", "commit_id"],
				control,
			)) === commitId
		)
			return;
		const directory = join(repository, ".jj/pilot-base.git");
		await rm(directory, { recursive: true, force: true });
		await this.runner("git", ["init", "--bare", "--quiet", "--template=", directory], repository);
		await writeFile(join(directory, "objects/info/alternates"), `${join(repository, ".git/objects")}\n`);
		const args = [`--git-dir=${directory}`];
		const ref = `refs/heads/${commitId}`;
		await this.runner("git", [...args, "update-ref", ref, commitId, "0".repeat(40)], repository);
		if ((await this.runner("git", [...args, "rev-parse", "--verify", ref], repository)) !== commitId)
			throw new Error("Base import ref mismatch");
		const url = await this.optional("git", ["remote", "get-url", baseRemote], repository);
		if (url === undefined) await this.runner("git", ["remote", "add", baseRemote, directory], repository);
		else if (url !== directory) throw new Error("Base import remote mismatch");
		await this.jj(
			[
				"--ignore-working-copy",
				"--config=git.abandon-unreachable-commits=false",
				"--config=git.record-synthetic-predecessors=false",
				`--config=remotes.${baseRemote}.auto-track-bookmarks="glob:* ~ glob:*"`,
				"git",
				"fetch",
				"--remote",
				`exact:${baseRemote}`,
				"--branch",
				"glob:*",
			],
			control,
			signal,
		);
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
			const control = await this.control(repository, signal);
			const base = await this.base(source, repository, baseBranch, runner);
			binding.creationBaseId = base.commitId;
			await atomicJson(this.bindingPath(shared), binding);
			await runner("git", ["update-ref", `refs/pilot/base/${name}`, base.commitId], repository);
			await this.importBase(repository, control, base.commitId, signal);
			await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
			await this.jj(
				[
					"workspace",
					"add",
					"--no-colocate",
					"--sparse-patterns=full",
					"--name",
					name,
					"-r",
					base.commitId,
					destination,
				],
				control,
				signal,
			);
			// Both source and child are non-colocated here: checkout once, without any Git import.
			await this.jjChild(destination, shared);
			await this.colocate(destination, shared, signal);
			binding.initialCommitId = (await this.ids(destination)).commitId;
			await atomicJson(this.bindingPath(shared), binding);
			// Only the bounded local inputs come from the source, never its dirty tracked files.
			await copyLocalConfigs(source, destination, runner);
			await this.inspect(destination, true, false);
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

	/** Fetch/index main once for a project pass, without snapshotting any agent working copy. */
	async fetchMain(shared: SharedWorkspace, source: string): Promise<string> {
		return this.queue(shared.repository, async () => {
			await this.repositoryOwned(shared.repository);
			const control = await this.control(shared.repository);
			const base = await this.base(source, shared.repository, undefined, this.runner, true);
			await this.importBase(shared.repository, control, base.commitId);
			return base.commitId;
		});
	}

	/** Same squash-merge fingerprint check used by the turn-boundary base refresh. */
	private async integratedChanges(repository: string, previousBase: string, base: string, revisions: string[]) {
		const upstream = await this.runner(
			"git",
			[
				"log",
				"--no-merges",
				"--format=commit %H",
				"--raw",
				"--no-abbrev",
				"--no-renames",
				`${previousBase}..${base}`,
			],
			repository,
		);
		const fingerprints = new Set(
			upstream
				.split(/^commit [0-9a-f]{40}$/m)
				.map(changeFingerprint)
				.filter(Boolean),
		);
		const completed = new Set<string>();
		for (const commit of revisions) {
			const raw = await this.runner(
				"git",
				["diff-tree", "--no-commit-id", "--raw", "--no-renames", "-r", commit],
				repository,
			);
			const fingerprint = changeFingerprint(raw);
			if (fingerprint && fingerprints.has(fingerprint)) completed.add(commit);
		}
		return completed;
	}

	/** Reuse the isolated refresh transaction for either a safe fresh change or a trial rebase. */
	async refreshBase(
		cwd: string,
		shared: SharedWorkspace,
		source: string,
		previousBase: string,
		branch?: string,
		merged?: { target: string; mergedPrs: SessionPullRequest[]; allowed?: () => string | undefined },
	) {
		return this.queue(shared.repository, async () => {
			await this.owned(shared, cwd);
			await this.jjChild(cwd, shared);
			const marker = join(cwd, ".git");
			const parkedMarker = join(cwd, PARKED_GIT);
			// Recover an interrupted refresh before validating colocation.
			await this.unparkGit(cwd);
			await this.child(cwd, shared);
			const control = await this.control(shared.repository);
			if (merged && !fullCommit.test(merged.target)) throw new Error("Invalid fetched main head");
			const base = merged
				? { commitId: merged.target }
				: await this.base(source, shared.repository, branch, this.runner);
			await this.importBase(shared.repository, control, base.commitId);
			// jj snapshots/update-stale in a colocated child also import Git refs. Hide only this child's
			// gitdir file for the transaction, so stale agent refs cannot resurrect or move bookmarks.
			await rename(marker, parkedMarker);
			try {
				await this.jj(["workspace", "update-stale"], cwd);
				await this.jj(["status"], cwd); // snapshot this workspace's filesystem, never a sibling's
				if (merged) {
					const behind = (reason: string) => ({ base: previousBase, behind: reason, target: base.commitId });
					const workingCopy = await this.ids(cwd);
					await this.inspect(cwd, true, false, parkedMarker);
					const log = (rev: string, template = "commit_id") =>
						this.jj(
							["--ignore-working-copy", "log", "--no-graph", "--limit", "257", "-r", rev, "-T", template],
							cwd,
						);
					const heads: string[] = [base.commitId];
					const range = `${previousBase}..@`;
					if (await log(`(${range} ~ ::${base.commitId}) ~ empty()`)) {
						if (merged.mergedPrs.length > 16) return behind("Too many merged PR heads to verify safely.");
						for (const pr of merged.mergedPrs) {
							const { head, merge } = await mergedPullRequestHead(pr, cwd, this.runner);
							if (!(await log(`${merge} & ::${base.commitId}`)))
								return behind("A completed PR is not merged into current main.");
							if (
								(await this.optional("git", ["cat-file", "-e", `${head}^{commit}`], shared.repository)) ===
								undefined
							)
								return behind("A completed PR head is not available locally to verify safely.");
							await this.importBase(shared.repository, control, head);
							heads.push(head);
						}
					}
					const unpublished = `(${range} ~ ::(${heads.join(" | ")})) ~ empty()`;
					const revisions = (await log(unpublished, 'commit_id ++ "\\n"')).split("\n").filter(Boolean);
					if (revisions.length > 256) return behind("The change stack exceeds the automatic update safety limit.");
					if (revisions.length) {
						const integrated = await this.integratedChanges(
							shared.repository,
							previousBase,
							base.commitId,
							revisions,
						);
						if (revisions.some((commit) => !integrated.has(commit)))
							return behind("The working copy has unpublished changes not already merged into main.");
					}
					const old = `(${range} ~ ::${base.commitId})`;
					const machine: Runner = (file, args, ...rest) =>
						this.runner(file, file === "jj" ? ["--no-pager", "--color=never", ...args] : args, ...rest);
					const ownBookmarks = await workspaceBookmarks(cwd, shared.name, machine);
					if (ownBookmarks.length > 256) return behind("Too many chat bookmarks to verify safely.");
					const ownRefs = ownBookmarks.map((name) => `bookmarks(exact:${JSON.stringify(name)})`);
					const candidates = `(descendants(${old})${ownRefs.length ? ` | ${ownRefs.join(" | ")}` : ""}) ~ ::${base.commitId}`;
					const bookmarks = (
						await this.jj(
							[
								"--ignore-working-copy",
								"bookmark",
								"list",
								"--all-remotes",
								"--revision",
								candidates,
								"-T",
								'name ++ "\\t" ++ if(remote, remote, "local") ++ "\\t" ++ if(normal_target, normal_target.commit_id(), "conflict") ++ "\\n"',
							],
							cwd,
						)
					)
						.split("\n")
						.filter(Boolean)
						.map((row) => row.split("\t"));
					if (bookmarks.length > 256) return behind("Too many dependent bookmarks to verify safely.");
					const completed = new Set(merged.mergedPrs.map((pr) => pr.branch).filter(Boolean));
					const pushed = new Map(
						bookmarks.filter(([, remote]) => remote === "origin").map(([name, , target]) => [name, target]),
					);
					if (
						bookmarks.some(
							([name, remote, target]) =>
								remote === "local" &&
								!(completed.has(name) && heads.includes(target!)) &&
								(target === "conflict" || pushed.get(name) !== target),
						)
					)
						return behind("An unpushed bookmark depends on this work.");
					await this.jj(["status"], cwd);
					if ((await this.ids(cwd)).commitId !== workingCopy.commitId)
						return behind("The working copy changed during the update.");
					const blocked = merged.allowed?.();
					if (blocked) return behind(blocked);
					// New, not rebase: completed bookmarks and sibling workspaces stay untouched.
					await this.jj(["--ignore-working-copy", "new", base.commitId], cwd);
					await this.jj(["workspace", "update-stale"], cwd);
					await this.runner(
						"git",
						["update-ref", `refs/pilot/base/${shared.name}`, base.commitId],
						shared.repository,
					);
					return { base: base.commitId };
				}
				if (base.commitId === previousBase) return { base: previousBase };
				const binding = JSON.parse(await readFile(this.bindingPath(shared), "utf8")) as Binding;
				const machineRunner: Runner = (file, args, ...rest) =>
					this.runner(file, file === "jj" ? ["--no-pager", "--color=never", ...args] : args, ...rest);
				const own = await workspaceChangeIds(cwd, shared.name, machineRunner);
				if (binding.initialCommitId) {
					const initial = await this.optional(
						"jj",
						["--ignore-working-copy", "log", "--no-graph", "-r", binding.initialCommitId, "-T", "change_id"],
						control,
						machineRunner,
					);
					if (initial) own.add(initial);
				}
				// A long-idle empty working copy can predate the bounded provenance window. It has no
				// authored content to rebase; the trial below still rejects every foreign pointer or descendant.
				const emptyWorkingCopy = await this.jj(
					["--ignore-working-copy", "log", "--no-graph", "-r", "@ & empty()", "-T", "change_id"],
					cwd,
				);
				if (emptyWorkingCopy) own.add(emptyWorkingCopy);
				let selected = `${previousBase}..@ ~ ::${base.commitId}`;
				let revisions = (
					await this.jj(
						[
							"--ignore-working-copy",
							"log",
							"--no-graph",
							"-r",
							selected,
							"-T",
							'change_id ++ "\\t" ++ commit_id ++ "\\n"',
						],
						cwd,
					)
				)
					.split("\n")
					.filter(Boolean)
					.map((line) => line.split("\t"));
				const behind = (reason: string) => ({ base: previousBase, behind: reason, target: base.commitId });
				if (revisions.length > 256) return behind("The change stack exceeds the automatic update safety limit.");
				if (revisions.length > 1 || !emptyWorkingCopy) {
					// Squash/rebase merges change commit IDs. Do not replay old completed work onto newer
					// implementations: recognize only identical blob transitions already in upstream history.
					const completed = [
						...(await this.integratedChanges(
							shared.repository,
							previousBase,
							base.commitId,
							revisions.map(([, commit]) => commit!),
						)),
					];
					if (completed.length) {
						selected = `(${selected}) ~ (${completed.join(" | ")})`;
						revisions = revisions.filter(([, commit]) => !completed.includes(commit!));
					}
				}
				const ids = revisions.map(([id]) => id!);
				if (ids.some((id) => !own.has(id)))
					return behind("The working copy includes changes not owned by this chat.");
				const bookmarks = new Set(await workspaceBookmarks(cwd, shared.name, machineRunner));
				const head = () =>
					this.jj(["--ignore-working-copy", "op", "log", "--no-graph", "--limit", "1", "-T", "id"], cwd);
				const before = await head();
				const trial = await this.jj(
					[
						"--ignore-working-copy",
						"--no-integrate-operation",
						...(ids.length
							? ["rebase", "-r", selected, "-o", base.commitId, "--skip-emptied"]
							: ["new", base.commitId]),
					],
					cwd,
				);
				// Identity warnings can follow jj's successful operation report.
				const prefix = trial.match(
					/^Operation left uncommitted because --no-integrate-operation was requested: ([0-9a-f]+)$/m,
				)?.[1];
				if (!prefix) throw new Error("Missing trial rebase operation");
				const operation = await this.jj(
					["--at-op", prefix, "op", "log", "--no-graph", "--limit", "1", "-T", "id"],
					cwd,
				);
				const conflicts = await this.jj(
					[
						"--at-op",
						operation,
						"log",
						"--no-graph",
						"-r",
						`(${base.commitId}..@) & conflicts()`,
						"-T",
						"commit_id",
					],
					cwd,
				);
				if (conflicts) return behind("Rebasing this chat's changes would conflict with the latest base.");
				const diff = await this.jj(
					[
						"--ignore-working-copy",
						"op",
						"show",
						"--no-graph",
						"-T",
						"",
						'--config=templates.commit_summary="change_id ++ \\" \\" ++ commit_id"',
						operation,
					],
					cwd,
				);
				const removed = [
					...(diff.split("Changed commits:\n")[1]?.split(/\nChanged /)[0] ?? "").matchAll(/^- ([k-z]+) /gm),
				];
				if (
					removed.some((match) => !ids.includes(match[1]!)) ||
					[...diff.matchAll(/^Changed working copy (.+):$/gm)].some((match) => match[1] !== `${shared.name}@`) ||
					(diff.split("Changed local bookmarks:\n")[1]?.split(/\nChanged /)[0] ?? "")
						.split("\n")
						.some((line) => /^[^\s+-].*:$/.test(line) && !bookmarks.has(line.slice(0, -1)))
				)
					return behind("Updating would rewrite another chat's changes or bookmarks.");
				if ((await head()) !== before)
					return behind("The shared repository changed during the update; retry on the next turn.");
				await this.jj(["--ignore-working-copy", "op", "integrate", operation], control);
				await this.jj(["workspace", "update-stale"], cwd);
				await this.runner(
					"git",
					["update-ref", `refs/pilot/base/${shared.name}`, base.commitId],
					shared.repository,
				);
				return { base: base.commitId };
			} finally {
				await rename(parkedMarker, marker);
			}
		});
	}

	/** Compare the actual filesystem with jj's tree, including omitted large/auto-track-disabled files. */
	private async inspect(
		cwd: string,
		jj = true,
		recoverIgnored = true,
		gitMarker?: string,
	): Promise<Record<string, string>> {
		if (jj && (await this.jj(["--ignore-working-copy", "sparse", "list"], cwd)) !== ".")
			throw new Error("Automatic cleanup requires a full (non-sparse) jj workspace");
		// Child snapshots avoid importing Git refs, so newly added gitlinks may not be in jj's tree yet.
		const gitArgs = gitMarker
			? [`--git-dir=${(await readFile(gitMarker, "utf8")).trim().replace(/^gitdir: /, "")}`]
			: [];
		const gitFields = (await this.runner("git", [...gitArgs, "ls-files", "--stage", "-z"], cwd))
			.split("\0")
			.filter(Boolean)
			.flatMap((line) => [
				line.slice(line.indexOf("\t") + 1),
				line.startsWith("160000 ") ? "git-submodule" : "file",
			]);
		for (let index = 0; index + 1 < gitFields.length; index += 2) {
			if (gitFields[index + 1] === "git-submodule")
				throw new Error(`Submodule prevents automatic cleanup: ${gitFields[index]}`);
		}
		const fields = jj
			? (
					await this.jj(
						["--ignore-working-copy", "file", "list", "-T", 'path ++ "\\0" ++ file_type ++ "\\0"'],
						cwd,
					)
				).split("\0")
			: gitFields;
		const tracked = new Set<string>();
		const trackedDirectories = new Set<string>();
		for (let index = 0; index + 1 < fields.length; index += 2) {
			// Large snapshots need an index, but building it must not stall streaming and HTTP work.
			if (index > 0 && index % 2048 === 0) await yieldToEventLoop();
			if (fields[index + 1] === "git-submodule")
				throw new Error(`Submodule prevents automatic cleanup: ${fields[index]}`);
			tracked.add(fields[index]!);
			for (let parent = dirname(fields[index]!); parent !== "."; parent = dirname(parent))
				trackedDirectories.add(parent);
		}
		// Collapse ignored trees so dependency directories never consume the command output budget.
		const ignored = new Set(
			(
				await this.runner(
					"git",
					[...gitArgs, "ls-files", "--others", "--ignored", "--directory", "--exclude-standard", "-z"],
					cwd,
				)
			)
				.split("\0")
				.filter(Boolean),
		);
		// Mixed build trees can contain many individual ignored files. Avoid a scan of every rule per file.
		const isIgnored = (path: string) => {
			if (ignored.has(path) || ignored.has(`${path}/`)) return true;
			for (let parent = dirname(path); parent !== "."; parent = dirname(parent))
				if (ignored.has(`${parent}/`)) return true;
			return false;
		};
		const configs: Record<string, string> = {};
		let inputBytes = 0;
		let entries = 0;
		const walk = async (directory: string, prefix = "") => {
			const contents = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
				const path = prefix.slice(0, -1);
				if (prefix && isIgnored(path) && !trackedDirectories.has(path)) return [];
				throw error;
			});
			for (const entry of contents) {
				if (++entries % 2048 === 0) await yieldToEventLoop();
				const path = prefix + entry.name;
				if (!prefix && (path === ".git" || path === ".jj")) continue;
				const disposable = isIgnored(path) && !tracked.has(path) && !trackedDirectories.has(path);
				// Ignored content is disposable, including links and nested checkouts. Never follow links.
				// Only descend into ignored trees to recover bounded, known local inputs.
				if (
					disposable &&
					(!recoverIgnored || !(entry.isDirectory() ? recoveryInputDirectory(path) : recoverableInput(path)))
				)
					continue;
				// jj does not list submodules, so a nested .git is the only sign of one. Report it specifically.
				if (prefix && entry.name === ".git")
					throw new Error(`Submodule or nested git repository prevents automatic cleanup: ${prefix.slice(0, -1)}`);
				if (entry.isDirectory()) {
					await walk(join(directory, entry.name), `${path}/`);
				} else if (!tracked.has(path)) {
					if (disposable) {
						// Recovery is best-effort for ignored inputs, never a prerequisite for cleanup.
						try {
							if (!(await safeFile(cwd, path))) continue;
							const size = (await lstat(join(cwd, path))).size;
							if (
								size > 1024 * 1024 ||
								inputBytes + size > 4 * 1024 * 1024 ||
								Object.keys(configs).length >= 256
							)
								continue;
							configs[path] = hash(await readFile(join(cwd, path)));
							inputBytes += size;
						} catch {
							// Unreadable or concurrently removed ignored inputs can be discarded.
						}
					} else throw new Error(`Unsafe untracked or jj-omitted path prevents cleanup: ${path}`);
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
			await this.snapshotChild(cwd, shared);
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
			if (!(await this.registered(shared))) {
				// Only a removal this store started and verified may be finished without jj.
				if (binding.state !== "removing")
					throw new Error("Workspace was unregistered but its directory remains; partial removal needs review");
				await this.finishRemoval(cwd, shared, recovery);
				binding.state = "removed";
				await atomicJson(this.bindingPath(shared), binding);
				return;
			}
			await this.snapshotChild(cwd, shared);
			if ((await this.ids(cwd)).commitId !== recovery.commitId)
				throw new Error("Workspace changed since recovery snapshot");
			// Ignored changes after the snapshot are disposable too; only revalidate non-ignored data.
			await this.inspect(cwd, true, false);
			binding.state = "removing";
			await atomicJson(this.bindingPath(shared), binding);
			await this.jj(["workspace", "remove", shared.name], await this.control(shared.repository));
			if (await stat(cwd))
				await this.finishRemoval(cwd, shared, recovery, "jj did not remove the workspace directory");
			binding.state = "removed";
			await atomicJson(this.bindingPath(shared), binding);
		});
	}

	/**
	 * `jj workspace remove` unregisters the workspace before deleting its files, so a timeout or crash can leave
	 * part of the tree behind. Delete the remnant only when it is still part of the verified recovery snapshot:
	 * jj metadata for this repository, tracked files unchanged or already deleted, and nothing else unignored.
	 */
	private async finishRemoval(
		cwd: string,
		shared: SharedWorkspace,
		recovery: WorkspaceRecovery,
		context = "Workspace was unregistered but its directory remains",
	) {
		const review = (reason: string) => new Error(`${context}: ${reason}; partial removal needs review`);
		const jjDirectory = await stat(join(cwd, ".jj"));
		if (jjDirectory && !jjDirectory.isDirectory()) throw review("unsafe jj metadata");
		if (await stat(join(cwd, ".jj/repo"))) {
			if (!(await safeFile(cwd, ".jj/repo"))) throw review("unsafe jj metadata");
			const repository = (await readFile(join(cwd, ".jj/repo"), "utf8")).trim();
			if (
				(await realpath(resolve(cwd, ".jj", repository)).catch(() => "")) !== join(shared.repository, ".jj", "repo")
			)
				throw review("it points to a different jj repository");
		}
		const worktrees = join(shared.repository, ".git", "worktrees");
		for (const marker of [".git", PARKED_GIT]) {
			if (!(await stat(join(cwd, marker)))) continue;
			if (!(await safeFile(cwd, marker))) throw review("unsafe Git metadata");
			const gitDir = resolve(cwd, (await readFile(join(cwd, marker), "utf8")).trim().replace(/^gitdir: /, ""));
			if ((await realpath(dirname(gitDir)).catch(() => dirname(gitDir))) !== worktrees)
				throw review("it points to a different Git repository");
		}
		const scratch = await mkdtemp(join(tmpdir(), "pilot-remnant-"));
		try {
			const env = { ...workspaceEnvironment(), GIT_INDEX_FILE: join(scratch, "index") };
			const git = (args: string[]) =>
				this.baseRunner(
					"git",
					[
						"-c",
						"core.hooksPath=/dev/null",
						`--git-dir=${join(shared.repository, ".git")}`,
						`--work-tree=${cwd}`,
						...args,
					],
					cwd,
					undefined,
					undefined,
					env,
				);
			const paths = (output: string) => output.split("\0").filter(Boolean);
			await git(["read-tree", recovery.commitId]);
			// Ignore rules are read from the work tree. Restore deleted ones so ignored build output stays ignored.
			const rules = paths(await git(["ls-files", "--deleted", "-z"])).filter(
				(path) => path === ".gitignore" || path.endsWith("/.gitignore"),
			);
			if (rules.length) await git(["checkout-index", "--", ...rules]);
			await git(["update-index", "-q", "--refresh"]);
			const changes = paths(await git(["diff-files", "--name-status", "-z"]));
			for (let index = 0; index + 1 < changes.length; index += 2)
				if (changes[index] !== "D") throw review(`${changes[index + 1]} changed since the recovery snapshot`);
			const untracked = paths(
				await git(["ls-files", "--others", "--exclude-standard", "--directory", "--no-empty-directory", "-z"]),
			).filter((path) => path !== ".jj/" && !path.startsWith(".jj/"));
			if (untracked.length) throw review(`${untracked[0]} is not in the recovery snapshot`);
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
		await rm(cwd, { recursive: true });
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
				if (binding.state === "restoring") await this.materialize(cwd, shared);
				else await this.child(cwd, shared);
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
					if (!(await stat(join(cwd, ".git")))) {
						// A crash after workspace add leaves a non-colocated child with the saved tree.
						// Restore its exact change before enabling Git for the ignored-input inspection.
						await this.jj(["edit", recovery.commitId], cwd);
						await this.colocate(cwd, shared);
					}
					await this.inspect(cwd);
				}
			} else {
				if (await stat(cwd)) throw new Error("Restore destination contains unowned partial data");
				binding.state = "restoring";
				binding.restoreCommitId = recovery.commitId;
				await atomicJson(this.bindingPath(shared), binding);
				await mkdir(dirname(cwd), { recursive: true, mode: 0o700 });
				const control = await this.control(shared.repository);
				await this.jj(
					[
						"workspace",
						"add",
						"--no-colocate",
						"--sparse-patterns=full",
						"--name",
						shared.name,
						"-r",
						recovery.commitId,
						cwd,
					],
					control,
				);
				await this.jjChild(cwd, shared);
			}
			// workspace add -r creates a *child*; edit restores the exact saved change, including conflicts.
			if ((await this.ids(cwd)).commitId !== recovery.commitId) await this.jj(["edit", recovery.commitId], cwd);
			await this.colocate(cwd, shared);
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
		await this.inspect(cwd, hasJj, false);
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
			if (binding.state === "creating") {
				await this.materialize(cwd, shared);
			} else await this.child(cwd, shared);
			if (binding.state !== "creating" && binding.state !== "ready")
				throw new Error("Workspace is not a partial creation");
			// Cancellation cleanup is part of launch too. Snapshot this child's edits without importing
			// stale shared Git refs, then restore Git access for the read-only ignored-input inspection.
			if (await stat(join(cwd, ".git")))
				await this.jj(["--ignore-working-copy", "git", "colocation", "disable"], cwd);
			try {
				await this.jj(["status"], cwd);
			} finally {
				await this.colocate(cwd, shared);
			}
			await this.inspect(cwd, true, false);
			if (binding.state === "ready") {
				if (!binding.initialCommitId || (await this.ids(cwd)).commitId !== binding.initialCommitId)
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
			}
			await this.jj(["--ignore-working-copy", "git", "colocation", "disable"], cwd);
			try {
				await this.jj(["workspace", "remove", shared.name], await this.control(repository));
			} catch (error) {
				if ((await stat(cwd)) && (await this.registered(shared))) await this.colocate(cwd, shared);
				throw error;
			}
			if (await stat(cwd))
				throw new Error("jj did not remove the partial workspace directory; partial removal needs review");
			binding.state = "removed";
			await atomicJson(this.bindingPath(shared), binding);
		});
	}
}
