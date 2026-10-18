/** Host-owned GitHub import. Remote URLs, never workspace copies, scripts or implicit trust. */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, opendir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GitHubImportOperation, GitHubImportRequest, GitHubRepositoryChoices } from "@pilot/protocol";
import type { GitHubSetupService } from "./github-setup.ts";
import { durableJSON } from "./operation-journal.ts";
import { projectDestination } from "./project-destination.ts";
import type { ProjectStore } from "./projects.ts";
import { RuntimeAdmission } from "./runtime-admission.ts";
import { SetupError } from "./setup.ts";
import { type ProcessOptions, type ProcessResult, subprocesses } from "./subprocess.ts";

type Stored = GitHubImportOperation & { device?: number; inode?: number; existing?: boolean; cloned?: boolean };
type Options = {
	command?: (file: string, args: string[], options: ProcessOptions) => Promise<ProcessResult>;
};
const bad = (message: string): never => {
	throw new SetupError(409, message);
};
export function importRepository(input: unknown): { name: string; url: string; ssh: string } {
	if (typeof input !== "string" || input.length > 512) return bad("Use a credential-free GitHub.com repository URL.");
	const match =
		/^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_][A-Za-z0-9_.-]{0,99}?)(?:\.git)?\/?$/.exec(
			input,
		);
	if (!match || match[2] === "." || match[2] === "..")
		return bad("Use a credential-free GitHub.com repository URL, with no query, fragment or extra path.");
	const name = `${match[1]}/${match[2]}`;
	return { name, url: `https://github.com/${name}`, ssh: `git@github.com:${name}.git` };
}
const running = (op: Stored) => ["queued", "cloning", "registering"].includes(op.phase);
export class GitHubImportService extends RuntimeAdmission {
	private readonly records = new Map<string, Stored>();
	private readonly children = new Map<string, AbortController>();
	private readonly ready: Promise<void>;
	private writes = Promise.resolve();
	private admitting = false;
	private readonly command: NonNullable<Options["command"]>;
	private readonly file: string;
	private readonly setup: GitHubSetupService;
	private readonly projects: ProjectStore;
	constructor(setup: GitHubSetupService, projects: ProjectStore, options: Options = {}) {
		super();
		this.setup = setup;
		this.projects = projects;
		this.file = join(setup.home, "github-import", "operations.json");
		this.command = options.command ?? ((f, a, o) => subprocesses.run(f, a, o));
		this.ready = this.load();
		void this.ready.catch(() => {});
	}
	private async load() {
		await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
		try {
			const records: Stored[] = JSON.parse(await readFile(this.file, "utf8"));
			if (!Array.isArray(records) || records.length > 128)
				bad("GitHub import journal needs attention. No operation was replayed.");
			for (const op of records) {
				if (running(op)) {
					op.phase = "interrupted";
					op.problem =
						"Host restarted during import. Resume explicitly on this host; existing checkout ownership is revalidated first.";
				}
				this.records.set(op.id, op);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	private persist() {
		const records = structuredClone([...this.records.values()]);
		const next = this.writes.then(() => durableJSON(this.file, records));
		this.writes = next.catch(() => {});
		return next;
	}
	async list(): Promise<GitHubImportOperation[]> {
		await this.ready;
		return [...this.records.values()].map(({ device: _, inode: __, existing: ___, cloned: ____, ...op }) => ({
			...op,
		}));
	}
	async repositories(query: string): Promise<GitHubRepositoryChoices> {
		if (query.length > 128 || /[\x00-\x1f]/.test(query)) bad("Repository search is too long or invalid.");
		const repositories: GitHubRepositoryChoices["repositories"] = [];
		let truncated = false;
		for (let page = 1; page <= 3; page++) {
			const items = JSON.parse(
				await this.setup.gh([
					"api",
					`user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member&page=${page}`,
					"--jq",
					"[.[] | {full_name, private}]",
				]),
			);
			if (!Array.isArray(items)) bad("GitHub repository inventory was not available.");
			for (const item of items.slice(0, 100)) {
				const repo = importRepository(`https://github.com/${item.full_name}`);
				if (repo.name.toLowerCase().includes(query.toLowerCase()))
					repositories.push({ name: repo.name, url: repo.url, private: item.private === true });
			}
			if (items.length < 100) break;
			if (page === 3) truncated = true;
		}
		return { repositories, truncated };
	}
	async preview(url: unknown, destination?: unknown): Promise<{ destination: string; resolvedDestination: string }> {
		const repo = importRepository(url),
			[owner, name] = repo.name.split("/");
		const value =
			destination === undefined || destination === ""
				? projectDestination({ host: "github.com", owner: owner!, repo: name! })
				: destination;
		return { destination: value as string, resolvedDestination: await this.destination(value) };
	}
	private async destination(input: unknown, createParents = false) {
		if (
			typeof input !== "string" ||
			!input ||
			input.length > 4096 ||
			/[\x00-\x1f\x7f$`\\{}]/.test(input) ||
			(input.includes("~") && !input.startsWith("~/")) ||
			input.slice(2).includes("~") ||
			input.split("/").includes("..")
		)
			bad("Choose a valid destination under this host's home folder, without parent traversal.");
		const root = await realpath(this.setup.userHome);
		const path = resolve(root, (input as string).replace(/^~\//, ""));
		const rel = relative(root, path);
		if (
			!rel ||
			rel.startsWith(`..${sep}`) ||
			isAbsolute(rel) ||
			rel.split(sep).some((p) => [".git", ".jj", ".ssh", ".pi"].includes(p)) ||
			path === this.setup.home ||
			path.startsWith(`${this.setup.home}${sep}`)
		)
			bad("Choose a project destination under this host's home, outside configuration and runtime storage.");
		let parent = root;
		for (const component of relative(root, dirname(path)).split(sep).filter(Boolean)) {
			parent = join(parent, component);
			let info = await lstat(parent).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
			if (!info && createParents) {
				await mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "EEXIST") throw error;
				});
				info = await lstat(parent);
			}
			if (info && (!info.isDirectory() || info.isSymbolicLink() || (await realpath(parent)) !== parent))
				bad("Destination parents must be real directories, never symlinks.");
		}
		return path;
	}
	async start(request: GitHubImportRequest): Promise<GitHubImportOperation> {
		await this.ready;
		if (
			!request ||
			!/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(request.id) ||
			Object.keys(request).some((k) => !["id", "url", "destination"].includes(k))
		)
			bad("Invalid GitHub import request.");
		const repo = importRepository(request.url),
			destination = await this.destination(request.destination);
		const previous = this.records.get(request.id);
		if (previous) {
			if (previous.url !== repo.url || previous.destination !== destination)
				bad("This operation ID is already bound to a different import.");
			return { ...previous };
		}
		if (this.admitting || this.children.size >= 2 || this.records.size >= 128)
			bad("GitHub import capacity reached. Check existing imports first.");
		if (
			[...this.records.values()].some(
				(op) => op.destination === destination && op.phase !== "failed" && op.phase !== "cancelled",
			)
		)
			bad("This destination already has an import. Check or resume that operation, not a duplicate.");
		const end = this.begin({ kind: "github-import", id: request.id });
		this.admitting = true;
		try {
			const op: Stored = { id: request.id, url: repo.url, destination, phase: "queued" };
			this.records.set(op.id, op);
			await this.persist();
			if (this.records.get(op.id)?.phase === "cancelled") {
				end();
				return { ...op };
			}
			this.launch(op, end);
			return { ...op };
		} catch (error) {
			end();
			throw error;
		} finally {
			this.admitting = false;
		}
	}
	async action(id: string, action: string): Promise<GitHubImportOperation> {
		await this.ready;
		const op = this.records.get(id);
		if (!op) return bad("Unknown import on this host.");
		if (action === "cancel") {
			this.children.get(id)?.abort();
			if (!this.children.has(id) && op.phase !== "done") {
				op.phase = "cancelled";
				await this.persist();
			}
			return { ...op };
		}
		if (op.phase === "done") return { ...op };
		if (action !== "resume" && action !== "confirm_existing") return bad("Unknown import action.");
		if (this.children.has(id) || this.admitting || this.children.size >= 2)
			return bad("Import is still running. Check its state first.");
		if (action === "confirm_existing" && op.phase !== "confirm_existing")
			return bad("This checkout is not awaiting confirmation.");
		if (action === "resume" && !["interrupted", "failed", "cancelled"].includes(op.phase))
			return bad("This import cannot be resumed.");
		const end = this.begin({ kind: "github-import", id });
		this.admitting = true;
		try {
			op.phase = action === "confirm_existing" ? "registering" : "queued";
			delete op.problem;
			await this.persist();
			if (this.records.get(op.id)?.phase === "cancelled") {
				end();
				return { ...op };
			}
			this.launch(op, end, action === "confirm_existing");
			return { ...op };
		} catch (error) {
			op.phase = "interrupted";
			end();
			throw error;
		} finally {
			this.admitting = false;
		}
	}
	private launch(op: Stored, end: () => void, confirm = false) {
		const controller = new AbortController();
		this.children.set(op.id, controller);
		void this.execute(op, controller.signal, confirm)
			.catch(() => {
				op.phase = "interrupted";
				op.problem = "Import state could not be committed. Recheck this host; do not start a duplicate.";
			})
			.finally(() => {
				this.children.delete(op.id);
				end();
			});
	}
	private async git(args: string[], cwd: string, signal?: AbortSignal, network = false) {
		const result = await this.command(
			"git",
			[
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"core.fsmonitor=false",
				"-c",
				"protocol.ext.allow=never",
				"-c",
				"protocol.file.allow=never",
				...args,
			],
			{
				cwd,
				env: {
					HOME: this.setup.userHome,
					PATH: process.env.PATH ?? "/usr/bin:/bin",
					LANG: "C.UTF-8",
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_TERMINAL_PROMPT: "0",
					GIT_SSH_COMMAND: this.setup.sshCommand,
					GIT_LFS_SKIP_SMUDGE: "1",
				},
				timeoutMs: network ? 120_000 : 15_000,
				maxBytes: 64 * 1024,
				maxStderrBytes: 4096,
				overflow: "fail",
				detached: process.platform !== "win32",
				...(signal ? { signal } : {}),
			},
		);
		if (result.aborted || result.timedOut || result.overflowed || result.code !== 0)
			bad(
				"Git operation did not complete. Check host trust, repository access and organization SSO; no raw Git output is returned. Partial files are kept, never overwritten or silently deleted.",
			);
		return result.stdout.toString().trim();
	}
	private async validateCheckout(op: Stored) {
		const info = await lstat(op.destination);
		if (
			!info.isDirectory() ||
			info.isSymbolicLink() ||
			info.dev !== op.device ||
			info.ino !== op.inode ||
			(await realpath(op.destination)) !== op.destination
		)
			bad("Destination identity changed. No existing files were overwritten.");
		const git = join(op.destination, ".git"),
			meta = await lstat(git);
		if (!meta.isDirectory() || meta.isSymbolicLink())
			bad("Only a standalone checkout with a real .git directory can be reused.");
		const origin = await this.git(
			["config", "--no-includes", "--file", join(git, "config"), "--get", "remote.origin.url"],
			this.setup.userHome,
		);
		if (importRepository(origin).url.toLowerCase() !== op.url.toLowerCase())
			bad("Existing checkout belongs to another repository. Nothing was overwritten or registered.");
		await this.git(["rev-parse", "--verify", "HEAD"], op.destination);
	}
	private async execute(op: Stored, signal: AbortSignal, confirm: boolean) {
		try {
			if (signal.aborted) throw new Error("cancelled");
			await this.destination(op.destination, true);
			if (confirm || op.cloned) {
				await this.validateCheckout(op);
			} else if (op.existing) {
				await this.validateCheckout(op);
				op.phase = "confirm_existing";
				delete op.problem;
				await this.persist();
				return;
			} else {
				const status = await this.setup.act({ id: randomUUID(), action: "verify" });
				if (signal.aborted) throw new Error("cancelled");
				if (!status.apiReady || !status.sshReady)
					bad(
						"Connect GitHub on this host first. Both independent CLI/API and dedicated SSH identity must be verified.",
					);
				const repo = importRepository(op.url);
				// Live per-repository permission/access probe, not a promise based on global login.
				await this.setup.gh(["api", `repos/${repo.name}`]);
				if (signal.aborted) throw new Error("cancelled");
				op.phase = "cloning";
				delete op.problem;
				await this.persist();
				let info = await lstat(op.destination).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
				});
				if (op.inode === undefined) {
					if (info) {
						op.device = info.dev;
						op.inode = info.ino;
						op.existing = true;
						await this.validateCheckout(op);
						op.phase = "confirm_existing";
						await this.persist();
						return;
					}
					if (signal.aborted) throw new Error("cancelled");
					await mkdir(op.destination, { mode: 0o700 });
					info = await lstat(op.destination);
					op.device = info.dev;
					op.inode = info.ino;
					await this.persist();
				}
				if (!info?.isDirectory() || info.isSymbolicLink() || info.dev !== op.device || info.ino !== op.inode)
					bad("Import destination ownership changed. Nothing was overwritten.");
				// Clone into our exclusive empty reservation. A failed/interrupted clone is not blindly repeated.
				const entries = await opendir(op.destination);
				let empty: boolean;
				try {
					empty = (await entries.read()) === null;
				} finally {
					await entries.close();
				}
				if (!empty) {
					await this.validateCheckout(op);
					// Do not execute arbitrary config/filters if a user touched an interrupted clone.
					op.existing = true;
					op.phase = "confirm_existing";
					op.problem =
						"Interrupted checkout was kept, not checked out again. Confirm reuse only after checking its files on this host.";
					await this.persist();
					return;
				}
				await this.git(
					[
						"clone",
						"--no-checkout",
						"--no-recurse-submodules",
						"--template=",
						"--config",
						`core.sshCommand=${this.setup.sshCommand}`,
						"--",
						repo.ssh,
						op.destination,
					],
					this.setup.userHome,
					signal,
					true,
				);
				// Empty templates, disabled global/system configuration and no submodules prevent repository
				// hooks and attributes from activating host-configured checkout filters during first import.
				await this.git(["checkout", "--force", "--no-recurse-submodules"], op.destination, signal);
				await this.validateCheckout(op);
				op.cloned = true;
				await this.persist();
			}
			if (signal.aborted) throw new Error("cancelled");
			op.phase = "registering";
			await this.persist();
			const project =
				this.projects.list().find((p) => p.path === op.destination) ??
				(await this.projects.create({ path: op.destination }));
			op.projectId = project.id;
			op.phase = "done";
			delete op.problem;
			await this.persist();
		} catch (error) {
			op.phase = signal.aborted ? "cancelled" : "failed";
			op.problem =
				error instanceof SetupError
					? error.message
					: "Import was interrupted or could not be confirmed. Check this host's operation before resuming; existing files are kept. No automatic retry or Local fallback.";
			await this.persist();
		}
	}
	async close() {
		this.freezeAdmissions();
		for (const controller of this.children.values()) controller.abort();
		if (this.blockers().length)
			await new Promise<void>((resolve) => {
				const stop = this.onChange(() => {
					if (!this.blockers().length) {
						stop();
						resolve();
					}
				});
			});
		await this.writes;
	}
}
