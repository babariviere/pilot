/** Read-only PR discovery for session branches, independent of a client or kernel. */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SessionPullRequest } from "@pilot/protocol";
import {
	type Candidate,
	type ChecksState,
	githubRepository,
	linkedPullRequest,
	lookupPullRequests,
	type RateLimits,
	type Repository,
	run,
	toSessionPullRequest,
} from "./github.ts";
import { type Runner, workspaceBranch } from "./workspaces.ts";

export { githubRepository } from "./github.ts";

export interface PullRequestSession {
	id: string;
	cwd: string;
	archivedAt?: number;
	/** Last agent or user activity. Older sessions without a PR are checked less often. */
	updatedAt?: number;
	workspaceRecovery?: unknown;
	workspace?: { branch?: string; upstream?: string; base?: string; baseBranch?: string; shared?: { name: string } };
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
	/** Other branches the session created locally (private clone branches or shared-workspace bookmarks). */
	branches?: string[];
	error?: string;
}

export interface PullRequestOptions {
	runner?: Runner;
	/**
	 * Base polling cadence. Open PRs with pending checks poll at half of it, other open PRs at twice it,
	 * and sessions without a PR back off with inactivity. Defaults to one minute.
	 */
	intervalMs?: number;
	/** Concurrent sync jobs, and so concurrent git, jj and gh processes. Defaults to 3. */
	concurrency?: number;
}

export function isTerminalPullRequest(pr: SessionPullRequest | undefined): boolean {
	return pr?.state === "merged" || pr?.state === "closed";
}

/** Current branch PR first, then earlier branches' PRs. */
export function sessionPullRequests(session: PullRequestSession): SessionPullRequest[] {
	return [...(session.pullRequest ? [session.pullRequest] : []), ...(session.previousPullRequests ?? [])];
}

/** Every branch the session created or used: the current one first, then PR heads, then branches without a PR. */
export function sessionBranches(session: PullRequestSession): string[] {
	const names = [
		session.workspace?.branch ?? session.pullRequest?.branch,
		...sessionPullRequests(session).map((pr) => pr.branch),
		...(session.previousBranches ?? []),
	];
	return [...new Set(names.filter((name): name is string => !!name))];
}

export interface LinkedPullRequest {
	url: string;
	cwd: string;
	pullRequest?: SessionPullRequest;
}

export interface LinkedPullRequestTracking {
	targets(): Iterable<LinkedPullRequest>;
	apply(pr: SessionPullRequest): void;
}

/** Number-based lookup for one hand-linked PR, including fork heads unrelated to any chat branch. */
export async function discoverLinkedPullRequest(
	target: LinkedPullRequest,
	runner: Runner = run,
): Promise<SessionPullRequest> {
	const { repo, number } = linkedPullRequest(target.url);
	const batch = await lookupPullRequests(repo, { numbers: [number] }, target.cwd, runner);
	const error = batch.numberErrors.get(number);
	if (error) throw error;
	return toSessionPullRequest(batch.numbers.get(number)!);
}

function validBranch(name: string): boolean {
	return !!name && !name.startsWith("-") && !/[\s\x00-\x1f\x7f:~^?*[\\]/.test(name);
}

/** Operations are immutable, so each bookmark operation's created names are read once. */
const createdByOperation = new Map<string, string[]>();

/** Local bookmarks an `op show` diff created (absent before the operation), in output order. */
export function createdBookmarks(opDiff: string): string[] {
	const names: string[] = [];
	let local = false;
	let current: string | undefined;
	for (const line of opDiff.split("\n")) {
		if (/^Changed .*:$/.test(line)) {
			local = line === "Changed local bookmarks:";
			current = undefined;
		} else if (local && /^[^\s+-][^\s]*:$/.test(line)) current = line.slice(0, -1);
		else if (local && current && line.trim() === "- (absent)") {
			names.push(current);
			current = undefined;
		}
	}
	return names;
}

/**
 * Bookmarks the session's own jj workspace created, newest first. The shared repository's operation log
 * records each operation's workspace, so sibling sessions' bookmarks are never attributed to this one.
 */
export async function workspaceBookmarks(cwd: string, workspace: string, runner: Runner = run): Promise<string[]> {
	// The shared operation log grows with every session's history. Read only operations newer than the
	// last one seen, widening the window when many happened, and fall back to a full read when the log
	// was rewritten (for example by `jj op abandon`).
	const key = `${cwd}\0${workspace}`;
	const seen = scannedOperations.get(key);
	let ops: Operation[] = [];
	let names: string[] | undefined;
	for (const limit of seen ? [32, 512, undefined] : [undefined]) {
		ops = await operations(cwd, runner, limit);
		const known = seen ? ops.findIndex((op) => op.id === seen.head) : -1;
		if (seen && known >= 0) {
			names = [...(await createdBy(ops.slice(0, known), workspace, cwd, runner)), ...seen.names];
			break;
		}
		if (limit === undefined || ops.length < limit) {
			names = await createdBy(ops, workspace, cwd, runner);
			break;
		}
	}
	const unique = [...new Set(names)];
	if (scannedOperations.size > 1024) scannedOperations.clear();
	if (ops[0]) scannedOperations.set(key, { head: ops[0].id, names: unique });
	return unique;
}

interface Operation {
	id: string;
	workspace: unknown;
	bookmarks: boolean;
}

/** Newest operation and the names it implies, per workspace. Operations are immutable. */
const scannedOperations = new Map<string, { head: string; names: string[] }>();

/** Newest first. Every operation is listed so the newest one can anchor incremental reads. */
async function operations(cwd: string, runner: Runner, limit?: number): Promise<Operation[]> {
	const output = await runner(
		"jj",
		[
			"op",
			"log",
			"--ignore-working-copy",
			"--no-graph",
			...(limit === undefined ? [] : ["--limit", String(limit)]),
			"-T",
			'self.id() ++ "\\t" ++ json(self.workspace_name()) ++ "\\t" ++ if(self.description().contains("bookmark"), "b", "-") ++ "\\n"',
		],
		cwd,
		10_000,
	);
	const ops: Operation[] = [];
	for (const line of output.split("\n")) {
		const [id, raw, kind] = line.split("\t");
		if (!id || !raw) continue;
		let workspace: unknown;
		try {
			workspace = JSON.parse(raw);
		} catch {
			continue;
		}
		ops.push({ id, workspace, bookmarks: kind !== "-" });
	}
	return ops;
}

async function createdBy(ops: Operation[], workspace: string, cwd: string, runner: Runner): Promise<string[]> {
	const names: string[] = [];
	for (const op of ops) {
		// jj renders workspace names with a trailing "@".
		if (!op.bookmarks || (op.workspace !== workspace && op.workspace !== `${workspace}@`)) continue;
		let created = createdByOperation.get(op.id);
		if (!created) {
			created = createdBookmarks(
				await runner("jj", ["op", "show", "--ignore-working-copy", "--no-graph", "-T", "", op.id], cwd, 10_000),
			);
			if (createdByOperation.size > 4096) createdByOperation.clear();
			createdByOperation.set(op.id, created);
		}
		names.push(...created);
	}
	return names;
}

/**
 * Local branches of a private clone are the agent's own, so a session that opened several PRs in one
 * run is still discovered. Shared jj repositories hold sibling sessions' bookmarks, so only bookmarks
 * created from the session's own workspace count.
 */
async function localBranches(session: PullRequestSession, runner: Runner): Promise<string[]> {
	const shared = session.workspace?.shared;
	if (shared) return workspaceBookmarks(session.cwd, shared.name, runner);
	const output = await runner("git", ["branch", "--format=%(refname:short)"], session.cwd, 10_000);
	return output
		.split("\n")
		.map((name) => name.trim())
		.filter(Boolean);
}

function failure(error: unknown): string {
	return `Pull request lookup failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 512);
}

/**
 * The local half of discovery: which heads to ask GitHub about. Runs only git/jj, never gh, so a sync
 * round can batch every session's heads of one repository into a single GitHub request.
 */
export interface WorkspaceInspection {
	/** Final result when GitHub is not needed or local inspection failed. */
	result?: PullRequestResult;
	repo?: Repository;
	branch?: string;
	/** The current branch, when it is a PR head (not the base branch). */
	current?: string;
	/** Other non-terminal heads to check. */
	others: string[];
	/** Other branches the session created locally. */
	created: string[];
	/** Local branch listing failed. The current branch is still checked. */
	error?: string;
}

export async function inspectWorkspace(
	session: PullRequestSession,
	runner: Runner = run,
): Promise<WorkspaceInspection> {
	const none = (result: PullRequestResult): WorkspaceInspection => ({
		result,
		others: [],
		created: [],
	});
	if (!session.workspace) return none({});
	if (session.workspaceRecovery) return none(session.workspace.branch ? { branch: session.workspace.branch } : {});
	const workspace = session.workspace;
	let branch = workspace.branch;
	// Direct delivery on the default branch is not a session PR. Avoid matching unrelated
	// historical PRs (and potentially auto-archiving the session based on their merge time).
	const isBase = (name: string) => workspace.base === `origin/${name}` || workspace.baseBranch === name;
	try {
		const validate = (name: string | undefined) => {
			if (name !== undefined && !validBranch(name))
				throw new Error("Invalid workspace branch for pull request discovery");
		};
		validate(branch);
		// Keep the recorded name if a merged/deleted branch no longer has a local ref.
		branch = (await workspaceBranch(session.cwd, branch, runner)) ?? branch;
		validate(branch);
	} catch (error) {
		return none({ ...(branch ? { branch } : {}), error: failure(error) });
	}
	const inspection: WorkspaceInspection = {
		...(branch !== undefined ? { branch } : {}),
		...(branch !== undefined && !isBase(branch) ? { current: branch } : {}),
		others: [],
		created: [],
	};
	// The session's other branches: earlier PR heads, earlier observed branches and private local branches.
	try {
		const cached = new Map((session.previousPullRequests ?? []).map((pr) => [pr.branch, pr]));
		// Direct delivery to the default branch does not open PRs from other local branches.
		const local = branch !== undefined && isBase(branch) ? [] : await localBranches(session, runner);
		inspection.created = local.filter((name) => name !== branch && validBranch(name) && !isBase(name));
		const names = new Set<string>([
			...(session.previousPullRequests ?? []).flatMap((pr) => (pr.branch ? [pr.branch] : [])),
			...(session.previousBranches ?? []),
			...inspection.created,
		]);
		for (const name of names) {
			if (name === branch || !validBranch(name) || isBase(name)) continue;
			// Merged and closed PRs never poll again, like the current branch's.
			if (isTerminalPullRequest(cached.get(name))) continue;
			inspection.others.push(name);
		}
	} catch (error) {
		inspection.error = failure(error);
	}
	if (inspection.current === undefined && !inspection.others.length) {
		inspection.result = {
			...(branch !== undefined ? { branch } : {}),
			...(inspection.created.length ? { branches: inspection.created } : {}),
			...(inspection.error ? { error: inspection.error } : {}),
		};
		return inspection;
	}
	try {
		inspection.repo = githubRepository(
			(workspace.upstream ?? (await runner("git", ["remote", "get-url", "origin"], session.cwd, 10_000))).trim(),
		);
	} catch (error) {
		inspection.result = { ...(branch ? { branch } : {}), error: failure(error) };
	}
	return inspection;
}

/** Heads GitHub must answer for an inspection that still needs a lookup. */
export function inspectionHeads(inspection: WorkspaceInspection): string[] {
	if (inspection.result) return [];
	return [...(inspection.current !== undefined ? [inspection.current] : []), ...inspection.others];
}

/** Heads whose cached PR is still open, looked up by number instead of a head search. */
export function knownPullRequests(session: PullRequestSession, inspection: WorkspaceInspection): Map<string, number> {
	const known = new Map<string, number>();
	if (inspection.result) return known;
	const current = session.pullRequest;
	if (
		inspection.current !== undefined &&
		current &&
		!isTerminalPullRequest(current) &&
		(current.branch ?? session.workspace?.branch) === inspection.current
	)
		known.set(inspection.current, current.number);
	for (const pr of session.previousPullRequests ?? [])
		if (pr.branch && !isTerminalPullRequest(pr) && inspection.others.includes(pr.branch))
			known.set(pr.branch, pr.number);
	return known;
}

/** Combine a local inspection with GitHub's answers, or its lookup failure. */
export function resolvePullRequests(
	session: PullRequestSession,
	inspection: WorkspaceInspection,
	found: ReadonlyMap<string, Candidate | undefined> | Error,
	now = Date.now(),
): PullRequestResult {
	if (inspection.result) return inspection.result;
	const { branch } = inspection;
	if (found instanceof Error) return { ...(branch ? { branch } : {}), error: failure(found) };
	const result: PullRequestResult = branch !== undefined ? { branch } : {};
	if (inspection.current !== undefined) {
		const pr = found.get(inspection.current);
		if (pr) {
			result.pullRequest = toSessionPullRequest(pr, now);
			if (result.pullRequest.mergedAt !== undefined) result.mergedAt = result.pullRequest.mergedAt;
		} else if (session.pullRequest && session.workspace?.branch === branch) {
			result.error = "No matching pull request found; keeping last known status";
		}
	}
	if (inspection.created.length) result.branches = inspection.created;
	const others = inspection.others.flatMap((name) => {
		const pr = found.get(name);
		return pr ? [toSessionPullRequest(pr, now)] : [];
	});
	if (others.length) result.others = others;
	if (inspection.error) result.error = inspection.error;
	return result;
}

/** Aggregate check state of the inspection's open PRs: pending wins, then failing. */
export function checksState(
	inspection: WorkspaceInspection,
	found: ReadonlyMap<string, Candidate | undefined>,
): ChecksState | undefined {
	let state: ChecksState | undefined;
	for (const head of inspectionHeads(inspection)) {
		const pr = found.get(head);
		if (pr?.state !== "OPEN" || !pr.checks) continue;
		if (pr.checks === "pending") return "pending";
		if (pr.checks === "failing" || !state) state = pr.checks;
	}
	return state;
}

/** One-off discovery of a single session: local inspection, then one batched GitHub request. */
export async function discoverPullRequest(
	session: PullRequestSession,
	runner: Runner = run,
	limits?: RateLimits,
): Promise<PullRequestResult> {
	const inspection = await inspectWorkspace(session, runner);
	if (inspection.result) return inspection.result;
	let found: ReadonlyMap<string, Candidate | undefined> | Error;
	try {
		found = (
			await lookupPullRequests(
				inspection.repo!,
				{ heads: inspectionHeads(inspection), known: knownPullRequests(session, inspection) },
				session.cwd,
				runner,
				limits,
			)
		).heads;
	} catch (error) {
		found = error instanceof Error ? error : new Error(String(error));
	}
	return resolvePullRequests(session, inspection, found);
}

/** Loose ref files read for a git fingerprint. Beyond this, skip caching rather than walk a huge tree. */
const maxRefFiles = 2_000;

/**
 * A fingerprint of everything workspace inspection reads from the repository, without starting a process:
 * jj's operation heads (bookmarks and the working-copy commit only change through operations, and
 * inspection ignores the working copy), or git's HEAD and local branch refs. Undefined when unknown.
 */
export async function repositoryState(cwd: string): Promise<string | undefined> {
	try {
		const jj = join(cwd, ".jj", "repo");
		const info = await stat(jj).catch(() => undefined);
		if (info) {
			// Secondary workspaces store the repository path, relative to their .jj directory.
			const repo = info.isDirectory() ? jj : resolve(join(cwd, ".jj"), (await readFile(jj, "utf8")).trim());
			return `jj:${(await readdir(join(repo, "op_heads", "heads"))).sort().join(",")}`;
		}
		const git = join(cwd, ".git");
		if (!(await stat(git)).isDirectory()) return undefined;
		const parts = [`HEAD=${(await readFile(join(git, "HEAD"), "utf8")).trim()}`];
		for (const file of ["packed-refs", "config"]) {
			const info = await stat(join(git, file)).catch(() => undefined);
			parts.push(`${file}=${info ? `${info.mtimeMs}:${info.size}` : "-"}`);
		}
		const walk = async (dir: string): Promise<boolean> => {
			for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) {
					if (!(await walk(path))) return false;
				} else {
					const info = await stat(path);
					parts.push(`${path.slice(git.length)}=${info.mtimeMs}:${info.size}`);
					if (parts.length > maxRefFiles) return false;
				}
			}
			return true;
		};
		if (!(await walk(join(git, "refs", "heads")))) return undefined;
		return `git:${parts.join("\n")}`;
	} catch {
		return undefined;
	}
}

/** Session fields inspection depends on, besides the repository. Earlier PRs only matter once settled. */
export function inspectionInputs(session: PullRequestSession): string {
	return JSON.stringify([
		session.workspace,
		!!session.workspaceRecovery,
		session.previousPullRequests?.map((pr) => [pr.branch, isTerminalPullRequest(pr)]),
		session.previousBranches,
	]);
}
