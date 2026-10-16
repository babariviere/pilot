/**
 * Batched, read-only GitHub GraphQL lookups. A sync round costs one gh process per repository for PR
 * discovery and one for PR health, instead of one or two per branch and three or more per PR.
 * Never fetch comment bodies or perform mutations.
 */
import type { PullRequestReadiness, SessionPullRequest } from "@pilot/protocol";
import { mergeReadiness } from "./pull-request-readiness.ts";
import { execFileOffThread, ProcessFailed } from "./subprocess.ts";
import type { Runner } from "./workspaces.ts";

const maxOutputBytes = 4 * 1024 * 1024;
export const run: Runner = async (file, args, cwd, timeoutMs, signal, env) => {
	const stdout = await execFileOffThread(file, args, {
		cwd,
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
		maxBytes: maxOutputBytes,
		killSignal: "SIGKILL",
		...(signal ? { signal } : {}),
		...(env ? { env } : {}),
	});
	return stdout.trim();
};

const commandTimeoutMs = 20_000;
/** Branch heads per discovery query. Each costs two small connections. */
export const headsPerQuery = 20;
/** PR numbers per discovery query. */
export const numbersPerQuery = 20;
/** PRs per health query. Each costs about one GraphQL point (100 review threads). */
export const healthPerQuery = 10;
/** Historical candidates per head. The newest same-repository candidate wins. */
const candidatesPerHead = 20;

export interface Repository {
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

/** Hand-linked PR URLs are github.com only. Returns the repository and PR number. */
export function linkedPullRequest(raw: string): { repo: Repository; number: number } {
	const url = new URL(raw);
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
	if (!Number.isSafeInteger(number) || number > 2_147_483_647) throw new Error("Invalid linked pull request number");
	return { repo, number };
}

/** Aggregate commit status of an open PR's head, used only to pick a polling cadence. */
export type ChecksState = "pending" | "passing" | "failing";

export interface Candidate {
	number: number;
	url: string;
	title: string;
	state: "OPEN" | "MERGED" | "CLOSED";
	isDraft: boolean;
	headRefName: string;
	isCrossRepository: boolean;
	createdAt: string;
	mergedAt: string | null;
	checks?: ChecksState;
	stack?: SessionPullRequest["stack"];
}

function invalid(what = "pull request"): never {
	throw new Error(`Invalid GitHub ${what} response`);
}

function object(value: unknown, what?: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid(what);
	return value as Record<string, unknown>;
}

const rollupStates: Record<string, ChecksState> = {
	EXPECTED: "pending",
	PENDING: "pending",
	SUCCESS: "passing",
	ERROR: "failing",
	FAILURE: "failing",
};

function candidate(row: unknown, repo: Repository): Candidate {
	const pr = row as (Candidate & { commits?: unknown }) | null;
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
		invalid();
	let url: URL;
	try {
		url = new URL(pr.url);
	} catch {
		throw new Error("Invalid GitHub pull request URL");
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.hostname.toLowerCase() !== repo.host.toLowerCase() ||
		url.pathname.toLowerCase() !== `/${repo.owner}/${repo.name}/pull/${pr.number}`.toLowerCase()
	)
		throw new Error("Invalid GitHub pull request URL");
	const result: Candidate = {
		number: pr.number,
		url: pr.url,
		title: pr.title,
		state: pr.state,
		isDraft: pr.isDraft,
		headRefName: pr.headRefName,
		isCrossRepository: pr.isCrossRepository,
		createdAt: pr.createdAt,
		mergedAt: pr.mergedAt ?? null,
	};
	const commits = pr.commits as
		| { nodes?: { commit?: { statusCheckRollup?: { state?: unknown } | null } }[] }
		| undefined;
	const state = commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
	if (typeof state === "string" && rollupStates[state]) result.checks = rollupStates[state];
	// Stack fields are nullable during the preview and absent on older GitHub servers.
	const metadata = row as {
		stack?: { number?: number; size?: number; baseRefName?: string } | null;
		stackEntry?: { position?: number } | null;
	};
	const stack = metadata.stack;
	const position = metadata.stackEntry?.position;
	if (
		stack &&
		Number.isSafeInteger(stack.number) &&
		stack.number! > 0 &&
		Number.isSafeInteger(stack.size) &&
		stack.size! > 0 &&
		Number.isSafeInteger(position) &&
		position! > 0 &&
		position! <= stack.size! &&
		typeof stack.baseRefName === "string" &&
		stack.baseRefName
	) {
		result.stack = { number: stack.number!, size: stack.size!, position: position!, baseBranch: stack.baseRefName };
	}
	return result;
}

/**
 * Newest matching open/draft PR first, then newest historical one. Same-named fork branches are not this
 * session's branch. Deleted head branches remain identifiable by headRefName and isCrossRepository.
 */
export function selectCandidate(rows: unknown, branch: string | undefined, repo: Repository): Candidate | undefined {
	if (!Array.isArray(rows)) invalid();
	const matching: Candidate[] = [];
	for (const row of rows) {
		const pr = candidate(row, repo);
		if (branch !== undefined && (pr.headRefName !== branch || pr.isCrossRepository)) continue;
		matching.push(pr);
	}
	return matching.sort(
		(a, b) =>
			Number(b.state === "OPEN") - Number(a.state === "OPEN") ||
			Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
			b.number - a.number,
	)[0];
}

export function toSessionPullRequest(pr: Candidate, now = Date.now()): SessionPullRequest {
	return {
		number: pr.number,
		url: pr.url,
		title: pr.title,
		// A merged/closed PR can still carry isDraft=true. GitHub's terminal state wins.
		state: pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open",
		branch: pr.headRefName,
		...(pr.state === "MERGED" ? { mergedAt: Date.parse(pr.mergedAt!) } : {}),
		createdAt: Date.parse(pr.createdAt),
		checkedAt: now,
		...(pr.stack ? { stack: pr.stack } : {}),
	};
}

/** Per-host GraphQL budget. GitHub's limit is per user, so every lookup reports into one tracker. */
export class RateLimits {
	/** Schema capability only, not repository enablement. Re-probed after daemon restart. */
	readonly unsupportedStacks = new Set<string>();
	/** Unsupported optional health fields per host. Re-probed after restart. */
	readonly unsupportedReadiness = new Map<string, Set<string>>();
	private readonly hosts = new Map<string, { remaining: number; resetAt: number }>();
	/** Leave headroom for the user's own gh usage. */
	private readonly reserve: number;

	constructor(reserve = 250) {
		this.reserve = reserve;
	}

	observe(host: string, value: unknown): void {
		if (!value || typeof value !== "object") return;
		const { remaining, resetAt } = value as { remaining?: unknown; resetAt?: unknown };
		const reset = typeof resetAt === "string" ? Date.parse(resetAt) : Number.NaN;
		if (typeof remaining !== "number" || !Number.isFinite(reset)) return;
		this.hosts.set(host, { remaining, resetAt: reset });
	}

	/** Epoch milliseconds before which this host should not be queried, or 0. Capped at one hour. */
	blockedUntil(host: string, now = Date.now()): number {
		const limit = this.hosts.get(host);
		if (!limit || limit.remaining > this.reserve || limit.resetAt <= now) return 0;
		return Math.min(limit.resetAt, now + 60 * 60_000);
	}
}

async function graphql(
	repo: Repository,
	query: string,
	variables: [flag: "-f" | "-F", name: string, value: string][],
	cwd: string,
	runner: Runner,
	limits?: RateLimits,
): Promise<Record<string, unknown>> {
	const output = await runner(
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
			...variables.flatMap(([flag, name, value]) => [flag, `${name}=${value}`]),
		],
		cwd,
		commandTimeoutMs,
	);
	if (Buffer.byteLength(output, "utf8") > maxOutputBytes) throw new Error("GitHub response exceeded 4 MiB");
	const response = object(JSON.parse(output));
	if (response.data && typeof response.data === "object")
		limits?.observe(repo.host, (response.data as Record<string, unknown>).rateLimit);
	// GraphQL can return partial data alongside errors, even with a successful exit status.
	if (response.errors !== undefined && (!Array.isArray(response.errors) || response.errors.length)) {
		const errors = Array.isArray(response.errors)
			? response.errors
					.map((error) => (typeof error?.message === "string" ? error.message : JSON.stringify(error)))
					.join("; ")
			: JSON.stringify(response.errors);
		throw new Error(`Invalid GitHub response: ${errors}`);
	}
	const data = object(response.data);
	return object(data.repository);
}

const fields = "number url title state isDraft headRefName isCrossRepository createdAt mergedAt";
const stackFields = "stack { number size baseRefName } stackEntry { position }";

/** Fall back only for schema absence, never hide network, permission or other lookup errors. */
function unsupportedStackFields(error: unknown): boolean {
	const message =
		error instanceof ProcessFailed ? error.stderr : error instanceof Error ? error.message : String(error);
	return /(?:Field ['"](?:stack|stackEntry)['"] doesn't exist on type ['"]PullRequest['"]|Cannot query field ['"](?:stack|stackEntry)['"] on type ['"]PullRequest['"])/i.test(
		message,
	);
}
const order = "orderBy: { field: CREATED_AT, direction: DESC }";

export interface PullRequestLookup {
	/** Selected PR per requested head, or undefined when GitHub has none. */
	heads: Map<string, Candidate | undefined>;
	/** PR per requested number. */
	numbers: Map<number, Candidate>;
}

/** Number lookups that failed alone, such as a deleted or inaccessible linked PR. */
export interface PullRequestBatch extends PullRequestLookup {
	numberErrors: Map<number, Error>;
}

/**
 * One GraphQL request for up to {@link headsPerQuery} branch heads and {@link numbersPerQuery} PR numbers.
 * Active PRs are queried separately so a long history cannot hide an open PR.
 */
async function lookupChunk(
	repo: Repository,
	heads: string[],
	numbers: number[],
	cwd: string,
	runner: Runner,
	limits?: RateLimits,
): Promise<PullRequestLookup> {
	const declarations = [
		"$owner: String!",
		"$name: String!",
		...heads.map((_, i) => `$h${i}: String!`),
		...numbers.map((_, i) => `$n${i}: Int!`),
	];
	const selections = [
		...heads.flatMap((_, i) => [
			`o${i}: pullRequests(headRefName: $h${i}, states: [OPEN], first: ${candidatesPerHead}, ${order}) { nodes { ...Open } }`,
			`a${i}: pullRequests(headRefName: $h${i}, first: ${candidatesPerHead}, ${order}) { nodes { ...Fields } }`,
		]),
		...numbers.map((_, i) => `n${i}: pullRequest(number: $n${i}) { ...Open }`),
	];
	const query = [
		`query PilotPullRequests(${declarations.join(", ")}) {`,
		"rateLimit { remaining resetAt }",
		"repository(owner: $owner, name: $name) {",
		...selections,
		"}",
		"}",
		`fragment Fields on PullRequest { ${fields} ${limits?.unsupportedStacks.has(repo.host) ? "" : stackFields} }`,
		"fragment Open on PullRequest { ...Fields commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }",
	].join("\n");
	const variables: ["-f" | "-F", string, string][] = [
		...heads.map((head, i): ["-f", string, string] => ["-f", `h${i}`, head]),
		...numbers.map((number, i): ["-F", string, string] => ["-F", `n${i}`, String(number)]),
	];
	let repository: Record<string, unknown>;
	try {
		repository = await graphql(repo, query, variables, cwd, runner, limits);
	} catch (error) {
		if (!query.includes(stackFields) || !unsupportedStackFields(error)) throw error;
		limits?.unsupportedStacks.add(repo.host);
		repository = await graphql(repo, query.replace(stackFields, ""), variables, cwd, runner, limits);
	}
	const result: PullRequestLookup = { heads: new Map(), numbers: new Map() };
	heads.forEach((head, i) => {
		const open = selectCandidate(object(repository[`o${i}`]).nodes, head, repo);
		result.heads.set(head, open ?? selectCandidate(object(repository[`a${i}`]).nodes, head, repo));
	});
	numbers.forEach((number, i) => {
		const pr = candidate(repository[`n${i}`], repo);
		if (pr.number !== number) throw new Error("Invalid linked pull request response");
		result.numbers.set(number, pr);
	});
	return result;
}

/**
 * Discover PRs for many heads and numbers of one repository, chunked. A failing number lookup is retried
 * alone so it cannot poison the rest of the batch. Head lookup failures reject the whole call.
 *
 * Heads with a known open PR (`known`, head to number) are looked up by number, which is cheaper than a
 * head search and survives renamed or deleted branches. Only when that PR is no longer open on the same
 * head (merged, closed, reassigned or unreadable) is the head searched, to find a reopened or newer PR.
 */
export async function lookupPullRequests(
	repo: Repository,
	request: { heads?: Iterable<string>; numbers?: Iterable<number>; known?: ReadonlyMap<string, number> },
	cwd: string,
	runner: Runner = run,
	limits?: RateLimits,
): Promise<PullRequestBatch> {
	const requested = [...new Set(request.heads ?? [])];
	const known = new Map(
		requested.flatMap((head) => (request.known?.has(head) ? [[head, request.known.get(head)!]] : [])),
	);
	const result = await lookupBatch(
		repo,
		requested.filter((head) => !known.has(head)),
		[...new Set([...(request.numbers ?? []), ...known.values()])],
		cwd,
		runner,
		limits,
	);
	const search: string[] = [];
	for (const [head, number] of known) {
		const pr = result.numbers.get(number);
		if (pr?.state === "OPEN" && pr.headRefName === head && !pr.isCrossRepository) result.heads.set(head, pr);
		else search.push(head);
	}
	if (search.length) {
		const searched = await lookupBatch(repo, search, [], cwd, runner, limits);
		for (const [head, pr] of searched.heads) result.heads.set(head, pr);
	}
	return result;
}

async function lookupBatch(
	repo: Repository,
	heads: string[],
	numbers: number[],
	cwd: string,
	runner: Runner,
	limits?: RateLimits,
): Promise<PullRequestBatch> {
	const result: PullRequestBatch = { heads: new Map(), numbers: new Map(), numberErrors: new Map() };
	const merge = (part: PullRequestLookup) => {
		for (const [key, value] of part.heads) result.heads.set(key, value);
		for (const [key, value] of part.numbers) result.numbers.set(key, value);
	};
	const failure = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));
	const chunks = Math.max(Math.ceil(heads.length / headsPerQuery), Math.ceil(numbers.length / numbersPerQuery));
	for (let chunk = 0; chunk < chunks; chunk++) {
		const chunkHeads = heads.slice(chunk * headsPerQuery, (chunk + 1) * headsPerQuery);
		const chunkNumbers = numbers.slice(chunk * numbersPerQuery, (chunk + 1) * numbersPerQuery);
		try {
			merge(await lookupChunk(repo, chunkHeads, chunkNumbers, cwd, runner, limits));
		} catch (error) {
			if (chunkNumbers.length + (chunkHeads.length ? 1 : 0) <= 1) {
				if (chunkHeads.length) throw error;
				result.numberErrors.set(chunkNumbers[0]!, failure(error));
				continue;
			}
			// Isolate the failure: heads together, then each number alone.
			if (chunkHeads.length) merge(await lookupChunk(repo, chunkHeads, [], cwd, runner, limits));
			for (const number of chunkNumbers)
				try {
					merge(await lookupChunk(repo, [], [number], cwd, runner, limits));
				} catch (single) {
					result.numberErrors.set(number, failure(single));
				}
		}
	}
	return result;
}

export interface PullRequestProblems {
	failedChecks: string[];
	/** Unresolved, current review threads with at least one comment, not individual comments. */
	reviewComments: number;
	/** Identity and latest-comment modification time, without fetching review text. */
	reviewThreads?: { id: string; commentId: string; updatedAt: number }[];
	mergeConflicts: boolean;
	/**
	 * Set for a stacked PR whose head no longer contains its base branch (the PR below it in the stack, or the
	 * stack's base for the bottom PR), which GitHub reports as "Some branches in this stack have diverged and must
	 * be rebased". Names that base branch.
	 */
	divergedFrom?: string;
}

const healthWhat = "pull request health";
const failedConclusions = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED"]);
const conclusions = new Set([...failedConclusions, "SUCCESS", "NEUTRAL", "CANCELLED", "SKIPPED", "STALE"]);
const checkStatuses = new Set(["COMPLETED", "IN_PROGRESS", "QUEUED", "REQUESTED", "WAITING", "PENDING"]);
const contextStates = new Set(["ERROR", "EXPECTED", "FAILURE", "PENDING", "SUCCESS"]);

function text(value: unknown, what = healthWhat): string {
	if (typeof value !== "string" || !value.trim()) invalid(what);
	return value;
}

/** Names of failed check runs and status contexts. Accepts GraphQL rollup nodes and gh's statusCheckRollup. */
export function failedChecks(rollup: unknown): string[] {
	// GitHub represents a PR without any checks as either null or an empty list.
	if (rollup === null) return [];
	if (!Array.isArray(rollup)) invalid(healthWhat);
	const failed = new Set<string>();
	for (const item of rollup) {
		const check = object(item, healthWhat);
		if (check.__typename === "CheckRun") {
			const name = text(check.name);
			if (!checkStatuses.has(text(check.status))) invalid(healthWhat);
			// gh serializes a nullable GraphQL conclusion as an empty Go string while pending.
			if (check.conclusion !== null && check.conclusion !== "" && !conclusions.has(text(check.conclusion)))
				invalid(healthWhat);
			if (check.status === "COMPLETED") {
				if (check.conclusion === null || check.conclusion === "") invalid(healthWhat);
				if (failedConclusions.has(check.conclusion as string)) failed.add(name);
			}
		} else if (check.__typename === "StatusContext") {
			const name = text(check.context);
			if (!contextStates.has(text(check.state))) invalid(healthWhat);
			if (check.state === "FAILURE" || check.state === "ERROR") failed.add(name);
		} else invalid(healthWhat);
	}
	return [...failed];
}

/** Pending checks from a rollup already validated with failedChecks. They are not blockers, but prevent ready. */
export function checksPending(rollup: unknown): boolean {
	return (
		Array.isArray(rollup) &&
		rollup.some((check) =>
			check.__typename === "CheckRun" ? check.status !== "COMPLETED" : ["PENDING", "EXPECTED"].includes(check.state),
		)
	);
}

export const readinessFields = ["mergeStateStatus", "reviewDecision"] as const;
/** Fall back for schema absence only, never permission or network errors. */
export function unsupportedReadinessField(error: unknown): string | undefined {
	const message =
		error instanceof ProcessFailed ? error.stderr : error instanceof Error ? error.message : String(error);
	return readinessFields.find((field) =>
		new RegExp(
			`(?:Field ['"]${field}['"] doesn't exist on type ['"]PullRequest['"]|Cannot query field ['"]${field}['"] on type ['"]PullRequest['"])`,
			"i",
		).test(message),
	);
}

export interface HealthRequest {
	number: number;
	/** Expected head branch. A different head means the PR is not the one this session tracks. */
	branch?: string;
	/** Part of a stack. Its head must contain its base branch, which needs the head branch. */
	stacked?: boolean;
}

export type HealthResult =
	| { problems: PullRequestProblems; readiness?: PullRequestReadiness }
	/** More than one page of checks or review threads. Use the paginated single-PR lookup instead. */
	| { overflow: true }
	| { error: Error };

const healthFields = [
	"number state headRefName mergeable isDraft",
	"commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) {",
	"nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } }",
	"pageInfo { hasNextPage } } } } } }",
	"reviewThreads(first: 100) { nodes { id isResolved isOutdated comments(last: 1) { totalCount nodes { id updatedAt } } } pageInfo { hasNextPage } }",
].join(" ");

export const noProblems = (): PullRequestProblems => ({ failedChecks: [], reviewComments: 0, mergeConflicts: false });

/** GraphQL selection comparing a PR's base branch with its head, given a String! variable holding the head ref. */
export const stackBaseFields = (variable: string) =>
	`baseRefName baseRef { compare(headRef: ${variable}) { behindBy } }`;

/**
 * The base branch a stacked PR must be rebased onto, from {@link stackBaseFields}, or undefined when its head
 * contains the base. A deleted base branch is not evidence of divergence.
 */
export function stackDivergence(pr: Record<string, unknown>, what = healthWhat): string | undefined {
	if (pr.baseRef === null) return undefined;
	const compare = object(object(pr.baseRef, what).compare, what);
	if (!Number.isSafeInteger(compare.behindBy) || (compare.behindBy as number) < 0) invalid(what);
	return (compare.behindBy as number) > 0 ? text(pr.baseRefName, what) : undefined;
}

function stackedHead(request: HealthRequest): string | undefined {
	return request.stacked && request.branch ? `refs/heads/${request.branch}` : undefined;
}

function parseHealth(value: unknown, request: HealthRequest): HealthResult {
	const pr = object(value, healthWhat);
	if (pr.number !== request.number) invalid(healthWhat);
	if (pr.state !== "OPEN" && pr.state !== "CLOSED" && pr.state !== "MERGED") invalid(healthWhat);
	if (pr.state !== "OPEN") return { problems: noProblems() };
	const head = text(pr.headRefName);
	if (request.branch !== undefined && head !== request.branch)
		throw new Error("GitHub pull request head does not match the session workspace branch");
	if (typeof pr.mergeable !== "string") invalid(healthWhat);
	const commits = object(pr.commits, healthWhat);
	if (!Array.isArray(commits.nodes) || commits.nodes.length !== 1) invalid(healthWhat);
	const commit = object(object(commits.nodes[0], healthWhat).commit, healthWhat);
	if (!("statusCheckRollup" in commit)) invalid(healthWhat);
	const rollup = commit.statusCheckRollup;
	let checks: string[] = [];
	let pending = false;
	if (rollup !== undefined && rollup !== null) {
		const contexts = object(object(rollup, healthWhat).contexts, healthWhat);
		const hasNextPage = object(contexts.pageInfo, healthWhat).hasNextPage;
		if (typeof hasNextPage !== "boolean") invalid(healthWhat);
		if (hasNextPage) return { overflow: true };
		checks = failedChecks(contexts.nodes);
		pending = checksPending(contexts.nodes);
	}
	const threads = object(pr.reviewThreads, healthWhat);
	if (!Array.isArray(threads.nodes)) invalid(healthWhat);
	const hasNextPage = object(threads.pageInfo, healthWhat).hasNextPage;
	if (typeof hasNextPage !== "boolean") invalid(healthWhat);
	if (hasNextPage) return { overflow: true };
	let reviewComments = 0;
	const reviewThreads: NonNullable<PullRequestProblems["reviewThreads"]> = [];
	const ids = new Set<string>();
	for (const node of threads.nodes) {
		const thread = object(node, healthWhat);
		const id = text(thread.id);
		if (ids.has(id) || typeof thread.isResolved !== "boolean" || typeof thread.isOutdated !== "boolean")
			invalid(healthWhat);
		ids.add(id);
		const comments = object(thread.comments, healthWhat);
		if (!Number.isSafeInteger(comments.totalCount) || (comments.totalCount as number) < 0) invalid(healthWhat);
		if (!thread.isResolved && !thread.isOutdated && (comments.totalCount as number) > 0) {
			reviewComments++;
			reviewThreads.push({ id, ...reviewCommentVersion(comments) });
		}
	}
	const divergedFrom = stackedHead(request) ? stackDivergence(pr) : undefined;
	// UNKNOWN (and future mergeability values) are not evidence of a conflict.
	const problems = {
		failedChecks: checks,
		reviewComments,
		...(reviewThreads.length ? { reviewThreads } : {}),
		mergeConflicts: pr.mergeable === "CONFLICTING",
		...(divergedFrom ? { divergedFrom } : {}),
	};
	return { problems, readiness: mergeReadiness({ state: pr.state, ...pr }, problems, pending) };
}

/** Validate the one newest comment's version. Missing metadata must not silently suppress feedback. */
export function reviewCommentVersion(comments: Record<string, unknown>): { commentId: string; updatedAt: number } {
	if (!Array.isArray(comments.nodes) || comments.nodes.length !== 1) invalid(healthWhat);
	const comment = object(comments.nodes[0], healthWhat);
	const updatedAt = Date.parse(text(comment.updatedAt, healthWhat));
	if (!Number.isFinite(updatedAt)) invalid(healthWhat);
	return { commentId: text(comment.id, healthWhat), updatedAt };
}

/**
 * Failed checks, unresolved review threads and merge conflicts for several PRs of one repository, one
 * GraphQL request per {@link healthPerQuery} PRs. Failures are per PR and never read as healthy.
 */
export async function lookupHealth(
	repo: Repository,
	requests: HealthRequest[],
	cwd: string,
	runner: Runner = run,
	limits?: RateLimits,
): Promise<Map<number, HealthResult>> {
	const results = new Map<number, HealthResult>();
	const unique = [...new Map(requests.map((request) => [request.number, request])).values()];
	const failure = (error: unknown) => ({ error: error instanceof Error ? error : new Error(String(error)) });
	const unsupported = limits?.unsupportedReadiness.get(repo.host) ?? new Set<string>();
	const lookup = async (chunk: HealthRequest[]): Promise<void> => {
		const heads = chunk.map(stackedHead);
		const query = [
			`query PilotPullRequestHealth($owner: String!, $name: String!, ${chunk
				.flatMap((_, i) => [`$p${i}: Int!`, ...(heads[i] ? [`$h${i}: String!`] : [])])
				.join(", ")}) {`,
			"rateLimit { remaining resetAt }",
			"repository(owner: $owner, name: $name) {",
			...chunk.map(
				(_, i) =>
					`p${i}: pullRequest(number: $p${i}) { ${healthFields} ${readinessFields.filter((field) => !unsupported.has(field)).join(" ")}${heads[i] ? ` ${stackBaseFields(`$h${i}`)}` : ""} }`,
			),
			"}",
			"}",
		].join("\n");
		let repository: Record<string, unknown>;
		try {
			repository = await graphql(
				repo,
				query,
				chunk.flatMap((request, i): [flag: "-f" | "-F", name: string, value: string][] => [
					["-F", `p${i}`, String(request.number)],
					...(heads[i] ? [["-f", `h${i}`, heads[i]!] as ["-f", string, string]] : []),
				]),
				cwd,
				runner,
				limits,
			);
		} catch (error) {
			const field = unsupportedReadinessField(error);
			if (!field || unsupported.has(field)) throw error;
			unsupported.add(field);
			limits?.unsupportedReadiness.set(repo.host, unsupported);
			return lookup(chunk);
		}
		chunk.forEach((request, i) => {
			try {
				results.set(request.number, parseHealth(repository[`p${i}`], request));
			} catch (error) {
				results.set(request.number, failure(error));
			}
		});
	};
	for (let start = 0; start < unique.length; start += healthPerQuery) {
		const chunk = unique.slice(start, start + healthPerQuery);
		try {
			await lookup(chunk);
		} catch (error) {
			// One deleted or inaccessible PR fails the whole request. Isolate it so others still report.
			if (chunk.length === 1) results.set(chunk[0]!.number, failure(error));
			else
				for (const request of chunk)
					try {
						await lookup([request]);
					} catch (single) {
						results.set(request.number, failure(single));
					}
		}
	}
	return results;
}
