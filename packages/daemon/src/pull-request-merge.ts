/** Explicit user merges only. The read-only discovery/sync path never calls this service. */
import type { MergePullRequestRequest, PullRequestMergeMethod, PullRequestMergePreview } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { githubRepository, type Repository, run } from "./github.ts";
import type { Runner } from "./workspaces.ts";

export function mergeTarget(raw: string): { repo: Repository; number: number } {
	const url = new URL(raw);
	const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)$/.exec(url.pathname);
	if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || !match)
		throw new Error("Invalid GitHub pull request URL");
	const repo = githubRepository(`https://${url.hostname}/${match[1]}/${match[2]}`);
	const number = Number(match[3]);
	if (!Number.isSafeInteger(number) || number > 2_147_483_647) throw new Error("Invalid pull request number");
	return { repo, number };
}

/** Bounded on-demand I/O, with one in-flight operation per PR across all chats. No queued mutations or retries. */
export class PullRequestMerger {
	private readonly active = new Map<string, Promise<unknown>>();
	private readonly runner: Runner;
	constructor(runner: Runner = run) {
		this.runner = runner;
	}

	async perform<T>(url: string, work: () => Promise<T>): Promise<T> {
		const key = url.toLowerCase();
		if (this.active.has(key)) throw new Conflict("This pull request already has an action in progress");
		if (this.active.size >= 3) throw new Conflict("Other pull request actions are in progress. Try again shortly.");
		const job = Promise.resolve().then(work);
		this.active.set(key, job);
		try {
			return await job;
		} finally {
			this.active.delete(key);
		}
	}

	async settled(): Promise<void> {
		await Promise.allSettled(this.active.values());
	}

	private async api(repo: Repository, path: string, cwd: string, fields?: string[]): Promise<Record<string, unknown>> {
		const output = await this.runner(
			"gh",
			[
				"api",
				"--hostname",
				repo.host,
				"--method",
				fields ? "PUT" : "GET",
				`repos/${repo.owner}/${repo.name}${path}`,
				...(fields ?? []),
			],
			cwd,
			20_000,
		);
		const value: unknown = JSON.parse(output);
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid GitHub response");
		return value as Record<string, unknown>;
	}

	async preview(url: string, cwd: string): Promise<PullRequestMergePreview> {
		const { repo, number } = mergeTarget(url);
		// Drain both reads even on failure, so releasing admission cannot leave an unbounded orphan process.
		const results = await Promise.allSettled([this.api(repo, `/pulls/${number}`, cwd), this.api(repo, "", cwd)]);
		const values = results.map((result) => {
			if (result.status === "rejected") throw result.reason;
			return result.value;
		});
		const [pr, repository] = values as [Record<string, unknown>, Record<string, unknown>];
		if (pr.merged === true) throw new Conflict("This pull request is already merged");
		if (pr.state !== "open" || pr.draft !== false)
			throw new Conflict("Only open, non-draft pull requests can be merged");
		const head = pr.head as { sha?: unknown; ref?: unknown } | undefined;
		const base = pr.base as { ref?: unknown } | undefined;
		if (
			typeof pr.title !== "string" ||
			typeof head?.sha !== "string" ||
			!/^[a-f0-9]{40,64}$/.test(head.sha) ||
			typeof head.ref !== "string" ||
			typeof base?.ref !== "string"
		)
			throw new Error("Invalid GitHub pull request response");
		const methods = (["squash", "merge", "rebase"] as PullRequestMergeMethod[]).filter(
			(method) => repository[method === "merge" ? "allow_merge_commit" : `allow_${method}_merge`] === true,
		);
		if (!methods.length) throw new Conflict("This repository has no available merge methods");
		return { url, number, title: pr.title, headSha: head.sha, headBranch: head.ref, baseBranch: base.ref, methods };
	}

	async merge(request: MergePullRequestRequest, preview: PullRequestMergePreview, cwd: string): Promise<void> {
		if (
			request.url !== preview.url ||
			request.headSha !== preview.headSha ||
			request.baseBranch !== preview.baseBranch
		)
			throw new Conflict("The pull request changed. Reload it and confirm again.");
		if (!preview.methods.includes(request.method)) throw new Conflict("This merge method is not available");
		const { repo, number } = mergeTarget(preview.url);
		const result = await this.api(repo, `/pulls/${number}/merge`, cwd, [
			"-f",
			`sha=${preview.headSha}`,
			"-f",
			`merge_method=${request.method}`,
		]);
		if (result.merged !== true)
			throw new Conflict(
				typeof result.message === "string" ? result.message : "GitHub did not merge the pull request",
			);
	}
}
