/**
 * Whether a session workspace holds work no pull request carries: uncommitted edits, commits without a bookmark,
 * a bookmark without a PR, or new commits on top of a merged PR. Such chats stay active.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type PullRequestSession, sessionPullRequests } from "./pull-requests.ts";
import { type Runner, run } from "./workspaces.ts";

const COMMIT = /^[0-9a-f]{40,64}$/;

/** Heads whose ancestry is published: the base and every branch with a known PR, in any state. */
function publishedHeads(session: PullRequestSession): { base?: string; baseBranch?: string; branches: string[] } {
	const workspace = session.workspace!;
	const branches = new Set<string>();
	for (const pr of sessionPullRequests(session)) {
		const branch = pr.branch ?? (pr === session.pullRequest ? workspace.branch : undefined);
		if (branch) branches.add(branch);
	}
	const baseBranch =
		workspace.baseBranch ??
		(workspace.base?.startsWith("origin/") ? workspace.base.slice("origin/".length) : undefined);
	return {
		...(workspace.base && /^[0-9a-f]{7,64}$/.test(workspace.base) ? { base: workspace.base } : {}),
		...(baseBranch ? { baseBranch } : {}),
		branches: [...branches],
	};
}

/** A jj string literal. JSON escaping matches jj's for quotes, backslashes and control characters. */
const literal = (value: string) => JSON.stringify(value);

export function unpublishedRevset(session: PullRequestSession): string {
	const { base, baseBranch, branches } = publishedHeads(session);
	const heads = [
		"trunk()",
		...(base ? [`present(${base})`] : []),
		...(baseBranch ? [`remote_bookmarks(exact:${literal(baseBranch)}, remote=exact:"origin")`] : []),
		...branches.flatMap((name) => [
			`bookmarks(exact:${literal(name)})`,
			`remote_bookmarks(exact:${literal(name)}, remote=exact:"origin")`,
		]),
	];
	// Empty commits (a fresh working-copy change, or one emptied by a rebase onto the merge) are not work.
	return `(::@ ~ ::(${heads.join(" | ")})) ~ empty()`;
}

async function jjUnpublished(session: PullRequestSession, runner: Runner): Promise<boolean> {
	// Snapshots the working copy, so uncommitted edits count. Callers only check idle sessions.
	const output = await runner(
		"jj",
		["log", "--no-graph", "--limit", "1", "-r", unpublishedRevset(session), "-T", 'commit_id ++ "\\n"'],
		session.cwd,
		30_000,
	);
	return output.split("\n").some((line) => COMMIT.test(line.trim()));
}

async function gitUnpublished(session: PullRequestSession, runner: Runner): Promise<boolean | undefined> {
	const cwd = session.cwd;
	if ((await runner("git", ["rev-parse", "--is-inside-work-tree"], cwd, 10_000)).trim() !== "true") return undefined;
	if ((await runner("git", ["status", "--porcelain", "-z", "--untracked-files=normal"], cwd, 30_000)).length)
		return true;
	const { base, baseBranch, branches } = publishedHeads(session);
	const refs = new Set(
		(await runner("git", ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin"], cwd, 10_000))
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean),
	);
	const published = [
		"refs/remotes/origin/HEAD",
		...(baseBranch ? [`refs/remotes/origin/${baseBranch}`] : []),
		...branches.flatMap((name) => [`refs/heads/${name}`, `refs/remotes/origin/${name}`]),
	].filter((ref) => refs.has(ref));
	const output = await runner(
		"git",
		["rev-list", "--max-count=1", "HEAD", "--not", ...(base ? [base] : []), ...published, "--"],
		cwd,
		30_000,
	);
	return output.split("\n").some((line) => COMMIT.test(line.trim()));
}

/**
 * True when the workspace has work outside the base and every PR head, false when it has none,
 * undefined when unknown (no isolated workspace, a reclaimed one, or a failed lookup).
 */
export async function hasUnpublishedWork(
	session: PullRequestSession,
	runner: Runner = run,
): Promise<boolean | undefined> {
	if (!session.workspace || session.workspaceRecovery) return undefined;
	try {
		if (existsSync(join(session.cwd, ".jj"))) return await jjUnpublished(session, runner);
		return await gitUnpublished(session, runner);
	} catch {
		return undefined;
	}
}
