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
	workspace?: { branch?: string; upstream?: string; base?: string; baseBranch?: string };
	pullRequest?: SessionPullRequest;
}

export interface PullRequestResult {
	/** Current agent-chosen branch/bookmark, also cached for session summaries. */
	branch?: string;
	pullRequest?: SessionPullRequest;
	/** GitHub's merge time, epoch milliseconds. Used only for delayed archiving. */
	mergedAt?: number;
	error?: string;
}

export interface PullRequestOptions {
	runner?: Runner;
	/** Delay between completed sweeps, not an overlapping interval. Defaults to one minute. */
	intervalMs?: number;
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

function select(output: string, branch: string, repo: Repository): Candidate | undefined {
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
		if (pr.headRefName !== branch || pr.isCrossRepository) continue;
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

export async function discoverPullRequest(
	session: PullRequestSession,
	runner: Runner = run,
): Promise<PullRequestResult> {
	if (!session.workspace) return {};
	if (session.workspaceRecovery) return session.workspace.branch ? { branch: session.workspace.branch } : {};
	let branch = session.workspace.branch;
	try {
		const validateBranch = (name: string) => {
			if (!name || name.startsWith("-") || /[\s\x00-\x1f\x7f:~^?*[\\]/.test(name))
				throw new Error("Invalid workspace branch for pull request discovery");
		};
		if (branch !== undefined) validateBranch(branch);
		// Keep the recorded name if a merged/deleted branch no longer has a local ref.
		branch = (await workspaceBranch(session.cwd, branch, runner)) ?? branch;
		if (branch === undefined) return {};
		validateBranch(branch);
		// Direct delivery on the default branch is not a session PR. Avoid matching unrelated
		// historical PRs (and potentially auto-archiving the session based on their merge time).
		if (session.workspace.base === `origin/${branch}` || session.workspace.baseBranch === branch) return { branch };
		const head = branch;
		const upstream =
			session.workspace.upstream ?? (await runner("git", ["remote", "get-url", "origin"], session.cwd, 10_000));
		const repo = githubRepository(upstream.trim());
		const list = async (state: string) =>
			select(
				await runner(
					"gh",
					[
						"pr",
						"list",
						`--head=${head}`,
						`--repo=${repo.identity}`,
						`--state=${state}`,
						"--limit=100",
						`--json=${fields}`,
					],
					session.cwd,
					10_000,
				),
				head,
				repo,
			);
		// Query active PRs separately so even a long historical list cannot hide an open PR.
		const pr = (await list("open")) ?? (await list("all"));
		if (!pr)
			return {
				branch,
				...(session.pullRequest && session.workspace.branch === branch
					? { error: "No matching pull request found; keeping last known status" }
					: {}),
			};
		return {
			branch,
			...(pr.state === "MERGED" ? { mergedAt: Date.parse(pr.mergedAt!) } : {}),
			pullRequest: {
				number: pr.number,
				url: pr.url,
				title: pr.title,
				// A merged/closed PR can still carry isDraft=true. GitHub's terminal state wins.
				state: pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open",
				checkedAt: Date.now(),
			},
		};
	} catch (error) {
		return {
			...(branch ? { branch } : {}),
			error: `Pull request lookup failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 512),
		};
	}
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

	constructor(
		sessions: () => Iterable<PullRequestSession>,
		apply: (session: PullRequestSession, result: PullRequestResult) => Promise<void>,
		options: PullRequestOptions = {},
	) {
		this.sessions = sessions;
		this.apply = apply;
		this.options = options;
	}

	start(): void {
		if (this.started || this.stopped) return;
		this.started = true;
		this.poll();
	}

	refresh(session: PullRequestSession): Promise<void> {
		if (this.stopped || !session.workspace) return Promise.resolve();
		const existing = this.pending.get(session.id);
		if (existing) return existing;
		const next = this.tail
			.then(async () => {
				if (this.stopped) return;
				await this.apply(session, await discoverPullRequest(session, this.options.runner));
			})
			.catch((error: unknown) => {
				// A metadata I/O failure must not kill polling or become an agent failure.
				console.warn(`pilotd: could not cache pull request for ${session.id}: ${error}`);
			})
			.finally(() => this.pending.delete(session.id));
		this.pending.set(session.id, next);
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
		const pr = session.pullRequest;
		return pr?.state !== "merged" && pr?.state !== "closed";
	}

	private poll(): void {
		this.polling = (async () => {
			for (const session of [...this.sessions()]) {
				if (this.stopped) break;
				if (this.due(session)) await this.refresh(session);
			}
		})().finally(() => {
			if (!this.stopped) {
				this.timer = setTimeout(() => this.poll(), this.options.intervalMs ?? 60_000);
				this.timer.unref();
			}
		});
	}
}
