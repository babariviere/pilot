/** Mechanical restacking in disposable repositories. Never imports into an agent's working copy. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionPullRequest } from "@pilot/protocol";
import { linkedPullRequest } from "./github.ts";
import { type Runner, run } from "./workspaces.ts";

export interface AutoRebaseHost {
	/** Rechecked before every push, including ownership, user input and live worker activity. */
	allowed(pr: SessionPullRequest): string | undefined;
	/** Durable admission, once per PR/base OID, before any trial. */
	reserve(pr: SessionPullRequest, baseHead: string): Promise<boolean>;
	ownedChanges(pr: SessionPullRequest, signal: AbortSignal): Promise<{ own: Set<string>; lower: Set<string> }>;
	rebased(pr: SessionPullRequest, base: string): Promise<void>;
}

export type AutoRebaseResult = { rebased: true } | { unchanged: true } | { skipped: string; divergedFrom?: string };
const oid = /^[0-9a-f]{40}$/;
/** The immutable pre-merge head, including squash merges and remotely deleted branches. */
export async function mergedPullRequestHead(pr: SessionPullRequest, cwd: string, runner: Runner = run) {
	const view = JSON.parse(
		await runner(
			"gh",
			["pr", "view", pr.url, "--json", "state,headRefOid,isCrossRepository,baseRefName,mergeCommit"],
			cwd,
			30_000,
		),
	);
	if (
		view.state !== "MERGED" ||
		view.isCrossRepository !== false ||
		view.baseRefName !== "main" ||
		!oid.test(view.headRefOid) ||
		!oid.test(view.mergeCommit?.oid)
	)
		throw new Error("Merged PR head could not be verified");
	return { head: view.headRefOid as string, merge: view.mergeCommit.oid as string };
}
const query = `query($owner: String!, $name: String!, $number: Int!) {
	repository(owner: $owner, name: $name) {
		defaultBranchRef { name }
		pullRequest(number: $number) { state isCrossRepository headRefName headRefOid baseRefName baseRefOid }
	}
}`;

interface Head {
	head: string;
	base: string;
	branch: string;
	baseBranch: string;
	defaultBranch: string;
}

function metadata(output: string, pr: SessionPullRequest): Head {
	const response = JSON.parse(output);
	if (response.errors?.length) throw new Error("GitHub rebase lookup failed");
	const repo = response.data?.repository;
	const view = repo?.pullRequest;
	if (view?.state !== "OPEN" || view.isCrossRepository !== false)
		throw new Error("PR is no longer open or belongs to a fork");
	if (
		view.headRefName !== pr.branch ||
		typeof view.headRefName !== "string" ||
		!view.headRefName.trim() ||
		!oid.test(view.headRefOid) ||
		!oid.test(view.baseRefOid) ||
		typeof view.baseRefName !== "string" ||
		!view.baseRefName.trim() ||
		typeof repo.defaultBranchRef?.name !== "string" ||
		!repo.defaultBranchRef.name.trim()
	)
		throw new Error("PR head or base could not be verified");
	if (view.headRefName === repo.defaultBranchRef.name) throw new Error("PR head is the default branch");
	return {
		head: view.headRefOid,
		base: view.baseRefOid,
		branch: view.headRefName,
		baseBranch: view.baseRefName,
		defaultBranch: repo.defaultBranchRef.name,
	};
}

/** Two stack passes at a time, no retained work queue. Each pass is bottom-to-top and deadline bounded. */
export class PullRequestAutoRebase {
	private active = 0;
	private readonly runner: Runner;
	constructor(runner: Runner = run) {
		this.runner = runner;
	}

	async restack(
		prs: SessionPullRequest[],
		cwd: string,
		upstream: string,
		host: AutoRebaseHost,
		signal?: AbortSignal,
	): Promise<Map<string, AutoRebaseResult>> {
		const results = new Map<string, AutoRebaseResult>();
		const skipAll = (reason: string) => {
			for (const pr of prs) results.set(pr.url, { skipped: reason });
			return results;
		};
		if (this.active >= 2) return skipAll("Automatic rebase capacity is busy");
		if (prs.length > 16) return skipAll("Stack exceeds the automatic rebase safety limit");
		prs = prs.filter((pr) => {
			const reason = host.allowed(pr);
			if (reason) results.set(pr.url, { skipped: reason });
			return !reason;
		});
		if (!prs.length) return results;
		this.active++;
		const budget = AbortSignal.timeout(120_000);
		signal = signal ? AbortSignal.any([signal, budget]) : budget;
		const deadline = Date.now() + 120_000;
		const command = async (file: string, args: string[], directory: string) => {
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error("Automatic rebase timed out");
			return this.runner(file, args, directory, Math.min(30_000, remaining), signal);
		};
		let scratch: string | undefined;
		try {
			scratch = await mkdtemp(join(tmpdir(), "pilot-auto-rebase-"));
			const store = join(scratch, "store.git");
			const work = join(scratch, "work");
			await command("git", ["init", "--bare", store], scratch);
			await command("jj", ["git", "init", "--git-repo", store, work], scratch);
			const jj = (args: string[]) =>
				command("jj", ["--no-pager", "--color=never", "--ignore-working-copy", ...args], work);
			for (const pr of [...prs].sort((a, b) => (a.stack?.position ?? 0) - (b.stack?.position ?? 0))) {
				let divergedFrom: string | undefined;
				try {
					const blocked = host.allowed(pr);
					if (blocked) throw new Error(blocked);
					const { repo } = linkedPullRequest(pr.url);
					const read = async () =>
						metadata(
							await command(
								"gh",
								[
									"api",
									"graphql",
									`--hostname=${repo.host}`,
									"-f",
									`query=${query}`,
									"-f",
									`owner=${repo.owner}`,
									"-f",
									`name=${repo.name}`,
									"-F",
									`number=${pr.number}`,
								],
								cwd,
							),
							pr,
						);
					const head = await read();
					// Coalescing a stack must not rewrite its bottom just because main advanced.
					// Conflicts on the root base go to the agent, not a mechanical restack.
					if (head.baseBranch === head.defaultBranch || head.baseBranch === pr.stack?.baseBranch) {
						results.set(pr.url, { unchanged: true });
						continue;
					}
					// Only GitHub's current base is used. A merged/deleted base is never retargeted here.
					await command("git", ["check-ref-format", `refs/heads/${head.branch}`], store);
					await command("git", ["check-ref-format", `refs/heads/${head.baseBranch}`], store);
					if (!(await host.reserve(pr, head.base)))
						throw new Error("Already attempted this PR on this base head or safety budget is exhausted");
					await command(
						"git",
						[
							"fetch",
							"--no-tags",
							upstream,
							`+refs/heads/${head.branch}:refs/heads/trial-head`,
							`+refs/heads/${head.baseBranch}:refs/heads/trial-base`,
						],
						store,
					);
					const fetchedHead = await command("git", ["rev-parse", "refs/heads/trial-head"], store);
					const fetchedBase = await command("git", ["rev-parse", "refs/heads/trial-base"], store);
					if (fetchedHead !== head.head) throw new Error("PR head moved since it was read");
					if (fetchedBase !== head.base) throw new Error("Base head moved since it was read");
					await jj(["git", "import"]);
					const range = `${head.base}..${head.head}`;
					if (!(await jj(["log", "--no-graph", "-r", `${head.base} & ::${head.head}`, "-T", "commit_id"]))) {
						divergedFrom = head.baseBranch;
						const { own, lower } = await host.ownedChanges(pr, signal);
						const revisions = (
							await jj([
								"log",
								"--no-graph",
								"--limit",
								"257",
								"-r",
								range,
								"-T",
								'commit_id ++ "\\t" ++ change_id ++ "\\t" ++ parents.len() ++ "\\n"',
							])
						)
							.split("\n")
							.filter(Boolean)
							.map((line) => line.split("\t"));
						if (!revisions.length || revisions.length > 256)
							throw new Error("PR exceeds the automatic rebase commit limit");
						// A rewritten stacked base keeps its jj change ID. Find that boundary instead of
						// replaying the old lower PR, even when both PRs belong to the same chat.
						const baseChanges = new Set(
							(
								await jj([
									"log",
									"--no-graph",
									"--limit",
									"1024",
									"-r",
									`::${head.base}`,
									"-T",
									'change_id ++ "\\n"',
								])
							).split("\n"),
						);
						// Known lower/merged PRs are boundaries too, including squash merges whose
						// change IDs disappeared. They are omitted, never replayed or rewritten.
						const boundary = revisions.find(([, change]) => baseChanges.has(change!) || lower.has(change!));
						const selected = boundary ? `(${range}) ~ ::${boundary[0]}` : range;
						const selectedRows = (
							await jj([
								"log",
								"--no-graph",
								"-r",
								selected,
								"-T",
								'commit_id ++ "\\t" ++ change_id ++ "\\t" ++ parents.len() ++ "\\n"',
							])
						)
							.split("\n")
							.filter(Boolean)
							.map((line) => line.split("\t"));
						if (
							!selectedRows.length ||
							selectedRows.some(([, change, parents]) => !own.has(change!) || parents !== "1")
						)
							throw new Error("PR includes foreign commits or merge commits");
						await jj(["bookmark", "set", "--allow-backwards", "rebased-head", "-r", head.head]);
						const trial = await jj([
							"--no-integrate-operation",
							"rebase",
							"-r",
							selected,
							"-o",
							head.base,
							"--skip-emptied",
						]);
						const operation = trial.match(
							/^Operation left uncommitted because --no-integrate-operation was requested: ([0-9a-f]+)$/m,
						)?.[1];
						if (!operation) throw new Error("Missing trial rebase operation");
						const at = (args: string[]) => jj(["--at-op", operation, ...args]);
						if (
							await at([
								"log",
								"--no-graph",
								"-r",
								`(${head.base}..rebased-head) & conflicts()`,
								"-T",
								"commit_id",
							])
						)
							throw new Error("Rebase has conflicts");
						const diff = await jj([
							"op",
							"show",
							"--no-graph",
							"-T",
							"",
							'--config=templates.commit_summary="change_id ++ \\" \\" ++ commit_id"',
							operation,
						]);
						const selectedIds = new Set(selectedRows.map(([, change]) => change));
						const removed = [
							...(diff.split("Changed commits:\n")[1]?.split(/\nChanged /)[0] ?? "").matchAll(/^- ([k-z]+) /gm),
						];
						if (!removed.length || removed.some((match) => !selectedIds.has(match[1])))
							throw new Error("Trial would rewrite commits outside this PR");
						const next = await at(["log", "--no-graph", "-r", "rebased-head", "-T", "commit_id"]);
						if (!oid.test(next)) throw new Error("Rebased head is ambiguous");
						// Recheck GitHub's base, branch and open state, not just the Git transport's lease.
						const fresh = await read();
						if (fresh.head !== head.head) throw new Error("PR head moved during the rebase");
						if (fresh.base !== head.base || fresh.baseBranch !== head.baseBranch)
							throw new Error("PR base moved during the rebase");
						const reason = host.allowed(pr);
						if (reason) throw new Error(reason);
						await command(
							"git",
							[
								"-c",
								"core.hooksPath=/dev/null",
								"push",
								`--force-with-lease=refs/heads/${head.branch}:${head.head}`,
								upstream,
								`${next}:refs/heads/${head.branch}`,
							],
							store,
						);
						results.set(pr.url, { rebased: true });
						await host.rebased(pr, head.baseBranch);
						// Integrate only in the scratch store so the next PR can import the pushed base.
						await jj(["op", "integrate", operation]);
					} else results.set(pr.url, { unchanged: true });
				} catch (error) {
					// A successful push must not become a follow-up because recording activity failed.
					const result = results.get(pr.url);
					if (!result || !("rebased" in result))
						results.set(pr.url, {
							skipped: error instanceof Error ? error.message : "Automatic rebase failed",
							...(divergedFrom ? { divergedFrom } : {}),
						});
				}
			}
			return results;
		} catch (error) {
			return skipAll(error instanceof Error ? error.message : "Automatic rebase failed");
		} finally {
			try {
				if (scratch) await rm(scratch, { recursive: true, force: true });
			} finally {
				this.active--;
			}
		}
	}
}
