/** Read-only GitHub discovery for private session branches, independent of a client or kernel. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SessionPullRequest } from "@pilot/protocol";
import { type Runner, workspaceBranch } from "./workspaces.ts";

const exec = promisify(execFile);
const run: Runner = async (file, args, cwd, timeoutMs) => {
	const { stdout } = await exec(file, args, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 });
	return stdout.trim();
};

export interface PullRequestSession {
	id: string;
	cwd: string;
	archivedAt?: number;
	workspaceRecovery?: unknown;
	workspace?: { branch?: string; upstream?: string; base?: string; baseBranch?: string; shared?: unknown };
	pullRequest?: SessionPullRequest;
	/** PRs from branches the session used before its current one, newest first. */
	previousPullRequests?: SessionPullRequest[];
	/** Earlier session branches without a known PR yet. */
	previousBranches?: string[];
}

export interface PullRequestResult {
	/** Current agent-chosen branch/bookmark, also cached for session summaries. */
	branch?: string;
	pullRequest?: SessionPullRequest;
	/** GitHub's merge time, epoch milliseconds. Used only for delayed archiving. */
	mergedAt?: number;
	/** Fresh results for the session's other branches. Branches without a result keep their cache. */
	others?: SessionPullRequest[];
	error?: string;
}

export interface PullRequestOptions {
	runner?: Runner;
	/** Delay between completed sweeps, not an overlapping interval. Defaults to one minute. */
	intervalMs?: number;
}

export function isTerminalPullRequest(pr: SessionPullRequest | undefined): boolean {
	return pr?.state === "merged" || pr?.state === "closed";
}

/** Current branch PR first, then earlier branches' PRs. */
export function sessionPullRequests(session: PullRequestSession): SessionPullRequest[] {
	return [...(session.pullRequest ? [session.pullRequest] : []), ...(session.previousPullRequests ?? [])];
}

interface Repository {
	host: string;
	owner: string;
	name: string;
	identity: string;
}

/** Never let gh infer a repository from its environment or a shared checkout. */
export function githubRepository(remote: string): Repository {
	let host: string;
	let path: string;
	const scp = /^(?:git@)?([a-zA-Z0-9.-]+):([^\s]+)$/.exec(remote);
	if (scp && !remote.includes("://")) {
		host = scp[1]!;
		path = scp[2]!;
	} else {
		let url: URL;
		try {
			url = new URL(remote);
		} catch {
			throw new Error("Workspace origin is not a GitHub repository URL");
		}
		if (!["https:", "http:", "ssh:"].includes(url.protocol) || url.search || url.hash)
			throw new Error("Workspace origin is not a GitHub repository URL");
		host = url.hostname;
		path = url.pathname.replace(/^\//, "");
	}
	const parts = path
		.replace(/\/$/, "")
		.replace(/\.git$/, "")
		.split("/");
	const owner = parts[0] ?? "";
	const name = parts[1] ?? "";
	if (
		parts.length !== 2 ||
		!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host) ||
		!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(owner) ||
		!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(name) ||
		name === "." ||
		name === ".."
	)
		throw new Error("Workspace origin is not a GitHub repository URL");
	return { host, owner, name, identity: `${host}/${owner}/${name}` };
}

interface Candidate {
	number: number;
	url: string;
	title: string;
	state: "OPEN" | "MERGED" | "CLOSED";
	isDraft: boolean;
	headRefName: string;
	isCrossRepository: boolean;
	createdAt: string;
	mergedAt: string | null;
}

function select(output: string, branch: string | undefined, repo: Repository): Candidate | undefined {
	const rows: unknown = JSON.parse(output);
	if (!Array.isArray(rows)) throw new Error("Invalid GitHub pull request response");
	const matching: Candidate[] = [];
	for (const row of rows) {
		const pr = row as Candidate | null;
		if (
			!pr ||
			typeof pr !== "object" ||
			!Number.isSafeInteger(pr.number) ||
			pr.number <= 0 ||
			typeof pr.url !== "string" ||
			typeof pr.title !== "string" ||
			!["OPEN", "MERGED", "CLOSED"].includes(pr.state) ||
			typeof pr.isDraft !== "boolean" ||
			typeof pr.headRefName !== "string" ||
			typeof pr.isCrossRepository !== "boolean" ||
			typeof pr.createdAt !== "string" ||
			!Number.isFinite(Date.parse(pr.createdAt)) ||
			(pr.state === "MERGED" && (typeof pr.mergedAt !== "string" || !Number.isFinite(Date.parse(pr.mergedAt))))
		)
			throw new Error("Invalid GitHub pull request response");
		// Same-named fork branches are not this private clone's branch. Deleted head branches
		// remain identifiable by headRefName and isCrossRepository, without any local ref lookup.
		if (branch !== undefined && (pr.headRefName !== branch || pr.isCrossRepository)) continue;
		const url = new URL(pr.url);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.hostname.toLowerCase() !== repo.host.toLowerCase() ||
			url.pathname.toLowerCase() !== `/${repo.owner}/${repo.name}/pull/${pr.number}`.toLowerCase()
		)
			throw new Error("Invalid GitHub pull request URL");
		matching.push(pr);
	}
	return matching.sort(
		(a, b) =>
			Number(b.state === "OPEN") - Number(a.state === "OPEN") ||
			Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
			b.number - a.number,
	)[0];
}

const fields = "number,url,title,state,isDraft,headRefName,isCrossRepository,createdAt,mergedAt";

export interface LinkedPullRequest {
	url: string;
	cwd: string;
	pullRequest?: SessionPullRequest;
}

/** Number-based lookup for hand-linked PRs, including fork heads unrelated to any chat branch. */
export async function discoverLinkedPullRequest(
	target: LinkedPullRequest,
	runner: Runner = run,
): Promise<SessionPullRequest> {
	const url = new URL(target.url);
	const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)$/.exec(url.pathname);
	if (
		url.protocol !== "https:" ||
		url.hostname !== "github.com" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!match
	)
		throw new Error("Invalid linked GitHub pull request URL");
	const repo = githubRepository(`https://${url.hostname}/${match[1]}/${match[2]}`);
	const number = Number(match[3]);
	if (!Number.isSafeInteger(number)) throw new Error("Invalid linked pull request number");
	const output = await runner(
		"gh",
		["pr", "view", String(number), `--repo=${repo.identity}`, `--json=${fields}`],
		target.cwd,
		10_000,
	);
	const pr = select(JSON.stringify([JSON.parse(output)]), undefined, repo);
	if (!pr || pr.number !== number) throw new Error("Invalid linked pull request response");
	return toSessionPullRequest(pr);
}

export interface LinkedPullRequestTracking {
	targets(): Iterable<LinkedPullRequest>;
	apply(pr: SessionPullRequest): void;
}

function validBranch(name: string): boolean {
	return !!name && !name.startsWith("-") && !/[\s\x00-\x1f\x7f:~^?*[\\]/.test(name);
}

function toSessionPullRequest(pr: Candidate): SessionPullRequest {
	return {
		number: pr.number,
		url: pr.url,
		title: pr.title,
		// A merged/closed PR can still carry isDraft=true. GitHub's terminal state wins.
		state: pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open",
		branch: pr.headRefName,
		...(pr.state === "MERGED" ? { mergedAt: Date.parse(pr.mergedAt!) } : {}),
		checkedAt: Date.now(),
	};
}

/**
 * Local branches of a private clone are the agent's own, so a session that opened several PRs in one
 * run is still discovered. Shared jj repositories hold sibling sessions' bookmarks, so they rely only
 * on branches the session was observed using.
 */
async function localBranches(session: PullRequestSession, runner: Runner): Promise<string[]> {
	if (session.workspace?.shared) return [];
	const output = await runner("git", ["branch", "--format=%(refname:short)"], session.cwd, 10_000);
	return output
		.split("\n")
		.map((name) => name.trim())
		.filter(Boolean);
}

export async function discoverPullRequest(
	session: PullRequestSession,
	runner: Runner = run,
): Promise<PullRequestResult> {
	if (!session.workspace) return {};
	if (session.workspaceRecovery) return session.workspace.branch ? { branch: session.workspace.branch } : {};
	const workspace = session.workspace;
	let branch = session.workspace.branch;
	let repo: Repository | undefined;
	const repository = async () => {
		repo ??= githubRepository(
			(workspace.upstream ?? (await runner("git", ["remote", "get-url", "origin"], session.cwd, 10_000))).trim(),
		);
		return repo;
	};
	const list = async (head: string, state: string) => {
		const target = await repository();
		return select(
			await runner(
				"gh",
				[
					"pr",
					"list",
					`--head=${head}`,
					`--repo=${target.identity}`,
					`--state=${state}`,
					"--limit=100",
					`--json=${fields}`,
				],
				session.cwd,
				10_000,
			),
			head,
			target,
		);
	};
	// Query active PRs separately so even a long historical list cannot hide an open PR.
	const lookup = async (head: string) => (await list(head, "open")) ?? (await list(head, "all"));
	const failure = (error: unknown) =>
		`Pull request lookup failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 512);
	// Direct delivery on the default branch is not a session PR. Avoid matching unrelated
	// historical PRs (and potentially auto-archiving the session based on their merge time).
	const isBase = (name: string) => workspace.base === `origin/${name}` || workspace.baseBranch === name;

	const result: PullRequestResult = {};
	try {
		const validateBranch = (name: string) => {
			if (!validBranch(name)) throw new Error("Invalid workspace branch for pull request discovery");
		};
		if (branch !== undefined) validateBranch(branch);
		// Keep the recorded name if a merged/deleted branch no longer has a local ref.
		branch = (await workspaceBranch(session.cwd, branch, runner)) ?? branch;
		if (branch !== undefined) {
			validateBranch(branch);
			result.branch = branch;
			if (!isBase(branch)) {
				const pr = await lookup(branch);
				if (pr) {
					result.pullRequest = toSessionPullRequest(pr);
					if (result.pullRequest.mergedAt !== undefined) result.mergedAt = result.pullRequest.mergedAt;
				} else if (session.pullRequest && workspace.branch === branch) {
					result.error = "No matching pull request found; keeping last known status";
				}
			}
		}
	} catch (error) {
		return { ...(branch ? { branch } : {}), error: failure(error) };
	}

	// The session's other branches: earlier PR heads, earlier observed branches and private local branches.
	try {
		const cached = new Map((session.previousPullRequests ?? []).map((pr) => [pr.branch, pr]));
		const names = new Set<string>([
			...(session.previousPullRequests ?? []).flatMap((pr) => (pr.branch ? [pr.branch] : [])),
			...(session.previousBranches ?? []),
			// Direct delivery to the default branch does not open PRs from other local branches.
			...(branch !== undefined && isBase(branch) ? [] : await localBranches(session, runner)),
		]);
		const others: SessionPullRequest[] = [];
		for (const name of names) {
			if (name === branch || !validBranch(name) || isBase(name)) continue;
			// Merged and closed PRs never poll again, like the current branch's.
			if (isTerminalPullRequest(cached.get(name))) continue;
			const pr = await lookup(name);
			if (pr) others.push(toSessionPullRequest(pr));
		}
		if (others.length) result.others = others;
	} catch (error) {
		result.error = failure(error);
	}
	return result;
}

/** Globally serial commands, per-session deduplication, and a drainable daemon-owned poll loop. */
export class PullRequestTracker {
	private readonly pending = new Map<string, Promise<void>>();
	private tail = Promise.resolve();
	private timer?: ReturnType<typeof setTimeout>;
	private polling?: Promise<void>;
	private stopped = false;
	private started = false;

	private readonly sessions: () => Iterable<PullRequestSession>;
	private readonly apply: (session: PullRequestSession, result: PullRequestResult) => Promise<void>;
	private readonly options: PullRequestOptions;
	private readonly linked?: LinkedPullRequestTracking;

	constructor(
		sessions: () => Iterable<PullRequestSession>,
		apply: (session: PullRequestSession, result: PullRequestResult) => Promise<void>,
		options: PullRequestOptions = {},
		linked?: LinkedPullRequestTracking,
	) {
		this.sessions = sessions;
		this.apply = apply;
		this.options = options;
		this.linked = linked;
	}

	start(): void {
		if (this.started || this.stopped) return;
		this.started = true;
		this.poll();
	}

	refresh(session: PullRequestSession): Promise<void> {
		if (this.stopped || !session.workspace) return Promise.resolve();
		return this.enqueue(session.id, async () => {
			await this.apply(session, await discoverPullRequest(session, this.options.runner));
		});
	}

	refreshLinked(target: LinkedPullRequest): Promise<void> {
		if (this.stopped || !this.linked || isTerminalPullRequest(target.pullRequest)) return Promise.resolve();
		return this.enqueue(`linked:${target.url}`, async () => {
			this.linked!.apply(await discoverLinkedPullRequest(target, this.options.runner));
		});
	}

	private enqueue(key: string, work: () => Promise<void>): Promise<void> {
		const existing = this.pending.get(key);
		if (existing) return existing;
		const next = this.tail
			.then(async () => {
				if (this.stopped) return;
				await work();
			})
			.catch((error: unknown) => {
				// A metadata I/O failure must not kill polling or become an agent failure.
				console.warn(`pilotd: could not cache pull request for ${key}: ${error}`);
			})
			.finally(() => this.pending.delete(key));
		this.pending.set(key, next);
		this.tail = next;
		return next;
	}

	async stop(): Promise<void> {
		this.stopped = true;
		clearTimeout(this.timer);
		await this.polling;
		await this.tail;
	}

	/** Terminal PRs never poll again. Explicit agent-activity refreshes may discover a new PR. */
	private due(session: PullRequestSession): boolean {
		if (session.archivedAt !== undefined) return false;
		if (!session.pullRequest) return true;
		return sessionPullRequests(session).some((pr) => !isTerminalPullRequest(pr));
	}

	private poll(): void {
		this.polling = (async () => {
			for (const session of [...this.sessions()]) {
				if (this.stopped) break;
				if (this.due(session)) await this.refresh(session);
			}
			const seen = new Set<string>();
			for (const target of this.linked?.targets() ?? []) {
				if (this.stopped) break;
				if (isTerminalPullRequest(target.pullRequest)) continue;
				if (seen.has(target.url)) continue;
				seen.add(target.url);
				await this.refreshLinked(target);
			}
		})().finally(() => {
			if (!this.stopped) {
				this.timer = setTimeout(() => this.poll(), this.options.intervalMs ?? 60_000);
				this.timer.unref();
			}
		});
	}
}
