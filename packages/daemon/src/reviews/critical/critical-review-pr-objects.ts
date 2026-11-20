/** Private, disposable, object-only Git database. Never opens a supplied repository or checks out files. */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { deflate, inflate } from "node:zlib";
import {
	type ReviewGitObjectType,
	ReviewPRCaptureError,
	type ReviewPRIdentity,
	type ReviewPRReader,
	type ReviewPRRepository,
	reviewGitOID,
} from "./critical-review-pr-intake.ts";
import type { CriticalReviewVault } from "./critical-review-vault.ts";

const execute = promisify(execFile),
	compress = promisify(deflate),
	decompress = promisify(inflate);
export const REVIEW_PR_LIMITS = Object.freeze({
	bytes: 128 * 1024 * 1024,
	objectBytes: 8 * 1024 * 1024,
	objects: 40_000,
	paths: 20_000,
	diffBytes: 8 * 1024 * 1024,
	metadataBytes: 64 * 1024,
	durationMs: 60_000,
	readMs: 10_000,
});
export type ReviewPRLimits = { [K in keyof typeof REVIEW_PR_LIMITS]: number };
export interface ReviewTreeEntry {
	path: string;
	oid: string;
	mode: string;
}
export class ReviewPRScope {
	readonly limits: ReviewPRLimits;
	private readonly caller?: AbortSignal;
	readonly controller = new AbortController();
	private readonly timer: ReturnType<typeof setTimeout>;
	private readonly cancel = () => this.controller.abort(new ReviewPRCaptureError("cancelled"));
	constructor(limits: ReviewPRLimits, caller?: AbortSignal) {
		this.limits = limits;
		this.caller = caller;
		caller?.addEventListener("abort", this.cancel, { once: true });
		if (caller?.aborted) this.cancel();
		this.timer = setTimeout(() => this.controller.abort(new ReviewPRCaptureError("timeout")), limits.durationMs);
	}
	get signal(): AbortSignal {
		return this.controller.signal;
	}
	check(): void {
		if (this.signal.aborted) throw this.signal.reason;
	}
	async read<T>(action: () => Promise<T>): Promise<T> {
		this.check();
		let rejectAbort!: (error: unknown) => void;
		const aborted = new Promise<never>((_, reject) => {
			rejectAbort = reject;
		});
		const cancel = () => rejectAbort(this.signal.reason);
		this.signal.addEventListener("abort", cancel, { once: true });
		const timer = setTimeout(() => this.controller.abort(new ReviewPRCaptureError("timeout")), this.limits.readMs);
		try {
			const value = await Promise.race([action(), aborted]);
			this.check();
			return value;
		} finally {
			clearTimeout(timer);
			this.signal.removeEventListener("abort", cancel);
		}
	}
	close(): void {
		clearTimeout(this.timer);
		this.caller?.removeEventListener("abort", this.cancel);
	}
}
export class ReviewPRObjects {
	readonly root: string;
	readonly scope: ReviewPRScope;
	private readonly identity: ReviewPRIdentity;
	private readonly reader: ReviewPRReader;
	private readonly vault: CriticalReviewVault;
	private readonly stage: { id: string; projectId: string };
	private stagedBytes = 128;
	private readonly types = new Map<string, ReviewGitObjectType>();
	private bytes = 0;
	private paths = 0;
	private constructor(
		root: string,
		scope: ReviewPRScope,
		identity: ReviewPRIdentity,
		reader: ReviewPRReader,
		vault: CriticalReviewVault,
		stage: { id: string; projectId: string },
	) {
		this.root = root;
		this.scope = scope;
		this.identity = identity;
		this.reader = reader;
		this.vault = vault;
		this.stage = stage;
	}
	static async create(
		scope: ReviewPRScope,
		identity: ReviewPRIdentity,
		reader: ReviewPRReader,
		vault: CriticalReviewVault,
		projectId: string,
	): Promise<ReviewPRObjects> {
		scope.check();
		await mkdir(vault.root, { recursive: true, mode: 0o700 });
		const info = await lstat(vault.root);
		if (
			!info.isDirectory() ||
			info.isSymbolicLink() ||
			info.mode & 0o077 ||
			(await realpath(vault.root)) !== vault.root
		)
			throw new ReviewPRCaptureError("object");
		const stage = { id: `pr-objects-${randomUUID()}`, projectId };
		const root = join(vault.root, `${stage.id}.part`);
		await vault.store.rpc("vaultStage", { ...stage, bytes: 128 });
		try {
			await mkdir(root, { mode: 0o700 });
			await mkdir(join(root, "objects"));
			await mkdir(join(root, "refs"));
			await writeFile(join(root, "HEAD"), "ref: refs/heads/disabled\n", { mode: 0o600 });
			await writeFile(join(root, "config"), "[core]\nrepositoryformatversion = 0\nbare = true\n", { mode: 0o600 });
			return new ReviewPRObjects(root, scope, identity, reader, vault, stage);
		} catch (error) {
			await rm(root, { recursive: true, force: true });
			await vault.store.rpc("abortStage", { id: stage.id });
			throw error;
		}
	}
	async close(): Promise<void> {
		await rm(this.root, { recursive: true, force: true });
		await this.vault.store.rpc("abortStage", { id: this.stage.id });
	}
	private async object(oid: string, type: ReviewGitObjectType, repository: ReviewPRRepository): Promise<Buffer> {
		this.scope.check();
		if (!reviewGitOID.test(oid)) throw new ReviewPRCaptureError("object");
		if (this.types.has(oid)) {
			if (this.types.get(oid) !== type) throw new ReviewPRCaptureError("object");
			const raw = await decompress(await readFile(join(this.root, "objects", oid.slice(0, 2), oid.slice(2))), {
				maxOutputLength: this.scope.limits.objectBytes + 64,
			});
			this.scope.check();
			const nul = raw.indexOf(0);
			if (
				nul < 0 ||
				raw.subarray(0, nul).toString("ascii") !== `${type} ${raw.length - nul - 1}` ||
				createHash("sha1").update(raw).digest("hex") !== oid
			)
				throw new ReviewPRCaptureError("object");
			return raw.subarray(nul + 1);
		}
		if (this.types.size >= this.scope.limits.objects) throw new ReviewPRCaptureError("quota");
		const response = await this.scope.read(() =>
			this.reader.readObject({
				identity: this.identity,
				repository,
				oid,
				type,
				signal: this.scope.signal,
				maxBytes: Math.min(this.scope.limits.objectBytes, this.scope.limits.bytes - this.bytes),
			}),
		);
		if (
			response.host !== this.identity.host ||
			response.accountId !== this.identity.account.id ||
			response.repositoryId !== repository.id
		)
			throw new ReviewPRCaptureError("identity");
		if (response.type !== type || !(response.bytes instanceof Uint8Array)) throw new ReviewPRCaptureError("object");
		if (
			response.bytes.byteLength > this.scope.limits.objectBytes ||
			this.bytes + response.bytes.byteLength > this.scope.limits.bytes
		)
			throw new ReviewPRCaptureError("quota");
		const bytes = Buffer.from(response.bytes);
		const header = Buffer.from(`${type} ${bytes.length}\0`);
		const hash = createHash("sha1").update(header).update(bytes).digest("hex");
		if (hash !== oid) throw new ReviewPRCaptureError("object");
		const compressed = await compress(Buffer.concat([header, bytes]));
		this.scope.check();
		this.stagedBytes += compressed.length;
		await this.vault.store.rpc("vaultStage", { ...this.stage, bytes: this.stagedBytes });
		await mkdir(join(this.root, "objects", oid.slice(0, 2)), { recursive: true, mode: 0o700 });
		await writeFile(join(this.root, "objects", oid.slice(0, 2), oid.slice(2)), compressed, {
			flag: "wx",
			mode: 0o600,
		});
		this.types.set(oid, type);
		this.bytes += bytes.length;
		return bytes;
	}
	/** Complete parent closure is mandatory. No shallow boundary or main fallback. */
	async history(head: string, repository: ReviewPRRepository): Promise<Map<string, string>> {
		const trees = new Map<string, string>(),
			pending = [head];
		while (pending.length) {
			const oid = pending.pop()!;
			if (trees.has(oid)) continue;
			const bytes = await this.object(oid, "commit", repository);
			const boundary = bytes.indexOf("\n\n");
			if (boundary < 0) throw new ReviewPRCaptureError("object");
			const lines = bytes.subarray(0, boundary).toString("latin1").split("\n");
			const tree = /^tree ([a-f0-9]{40})$/.exec(lines[0] ?? "")?.[1];
			if (!tree || lines.slice(1).some((line) => line.startsWith("tree "))) throw new ReviewPRCaptureError("object");
			trees.set(oid, tree);
			for (const line of lines) {
				if (!line.startsWith("parent ")) continue;
				const parent = /^parent ([a-f0-9]{40})$/.exec(line)?.[1];
				if (!parent) throw new ReviewPRCaptureError("object");
				pending.push(parent);
				if (pending.length > this.scope.limits.objects) throw new ReviewPRCaptureError("quota");
			}
		}
		return trees;
	}
	async mergeBase(head: string, base: string): Promise<string> {
		const candidates = (await this.git(["merge-base", "--all", head, base], 4096))
			.toString("ascii")
			.trim()
			.split("\n");
		if (candidates.length !== 1 || !reviewGitOID.test(candidates[0]!)) throw new ReviewPRCaptureError("ancestry");
		const mergeBase = candidates[0]!;
		await this.git(["merge-base", "--is-ancestor", mergeBase, head], 1);
		await this.git(["merge-base", "--is-ancestor", mergeBase, base], 1);
		return mergeBase;
	}
	/** Parse raw tree objects, without filesystem materialization, filters, LFS or submodules. */
	async tree(root: string, repository: ReviewPRRepository): Promise<ReviewTreeEntry[]> {
		const entries: ReviewTreeEntry[] = [];
		const pending = [{ oid: root, prefix: "", depth: 0 }];
		while (pending.length) {
			const next = pending.pop()!;
			if (next.depth > 64) throw new ReviewPRCaptureError("quota");
			const bytes = await this.object(next.oid, "tree", repository);
			const names = new Set<string>();
			for (let offset = 0; offset < bytes.length; ) {
				this.scope.check();
				const space = bytes.indexOf(32, offset),
					nul = bytes.indexOf(0, space + 1);
				if (space < offset || nul <= space + 1 || nul + 21 > bytes.length) throw new ReviewPRCaptureError("object");
				const mode = bytes.subarray(offset, space).toString("ascii");
				const rawName = bytes.subarray(space + 1, nul);
				let name: string;
				try {
					name = new TextDecoder("utf-8", { fatal: true }).decode(rawName);
				} catch {
					throw new ReviewPRCaptureError("object");
				}
				if (
					!["40000", "100644", "100755", "120000", "160000"].includes(mode) ||
					/[\x00-\x1f\x7f/\\:]/.test(name) ||
					name === "." ||
					name === ".." ||
					names.has(name)
				)
					throw new ReviewPRCaptureError("object");
				names.add(name);
				const oid = bytes.subarray(nul + 1, nul + 21).toString("hex");
				const path = next.prefix + name;
				if (Buffer.byteLength(path) > 400) throw new ReviewPRCaptureError("quota");
				if (++this.paths > this.scope.limits.paths) throw new ReviewPRCaptureError("quota");
				if (mode === "40000") pending.push({ oid, prefix: `${path}/`, depth: next.depth + 1 });
				else entries.push({ path, oid, mode });
				offset = nul + 21;
			}
		}
		return entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
	}
	blob(entry: ReviewTreeEntry, repository: ReviewPRRepository): Promise<Buffer> {
		return this.object(entry.oid, "blob", repository);
	}
	patch(mergeBase: string, head: string, path: string, maxBytes: number): Promise<Buffer> {
		return this.git(
			[
				"diff",
				"--no-ext-diff",
				"--no-textconv",
				"--no-renames",
				"--no-color",
				"--no-relative",
				"--submodule=short",
				"--src-prefix=a/",
				"--dst-prefix=b/",
				"--unified=3",
				"--inter-hunk-context=0",
				"--diff-algorithm=myers",
				"--no-indent-heuristic",
				"--ignore-submodules=none",
				"--full-index",
				mergeBase,
				head,
				"--",
				`:(top,literal)${path}`,
				`:(top,exclude,literal)${path}/`,
			],
			maxBytes,
		);
	}
	private async git(args: string[], maxBuffer: number): Promise<Buffer> {
		this.scope.check();
		try {
			const { stdout } = await execute(
				"/usr/bin/git",
				[
					"--no-pager",
					"--no-optional-locks",
					"-c",
					"core.hooksPath=/dev/null",
					"-c",
					"core.attributesFile=/dev/null",
					"-c",
					"core.fsmonitor=false",
					"-c",
					"core.quotePath=true",
					"-c",
					"protocol.allow=never",
					`--git-dir=${this.root}`,
					...args,
				],
				{
					cwd: this.root,
					encoding: "buffer",
					maxBuffer: Math.max(1, maxBuffer),
					timeout: this.scope.limits.readMs,
					killSignal: "SIGKILL",
					signal: this.scope.signal,
					env: {
						PATH: "/usr/bin:/bin",
						HOME: this.root,
						XDG_CONFIG_HOME: this.root,
						LC_ALL: "C",
						TZ: "UTC",
						GIT_CONFIG_NOSYSTEM: "1",
						GIT_CONFIG_SYSTEM: "/dev/null",
						GIT_CONFIG_GLOBAL: "/dev/null",
						GIT_NO_REPLACE_OBJECTS: "1",
						GIT_ATTR_NOSYSTEM: "1",
						GIT_TERMINAL_PROMPT: "0",
						GIT_ALLOW_PROTOCOL: "",
					},
				},
			);
			this.scope.check();
			return stdout;
		} catch (error) {
			this.scope.check();
			if ((error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
				throw new ReviewPRCaptureError("quota");
			if ((error as { killed?: boolean }).killed) throw new ReviewPRCaptureError("timeout");
			throw new ReviewPRCaptureError(args[0] === "merge-base" ? "ancestry" : "object");
		}
	}
}
