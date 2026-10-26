/**
 * Paginated single-PR health lookup. The sync uses batched GraphQL (see github.ts) and falls back to this
 * only for PRs with more than one page of checks or review threads. Lookup failures must not masquerade as
 * a healthy PR.
 */
import type { SessionPullRequest } from "@pilot/protocol";
import {
	checksPending,
	checksRunning,
	failedChecks,
	githubRepository,
	type HealthResult,
	type PullRequestProblems,
	readinessFields,
	reviewCommentVersion,
	stackBaseFields,
	stackDivergence,
	unsupportedReadinessField,
} from "./github.ts";
import { mergeReadiness } from "./pull-request-readiness.ts";
import { execFileOffThread } from "./subprocess.ts";
import type { Runner } from "./workspaces.ts";

export type { PullRequestProblems } from "./github.ts";

const maxOutputBytes = 1024 * 1024;
const commandTimeoutMs = 10_000;
const maxPages = 20;
const pageSize = 100;
const run: Runner = async (file, args, cwd, timeoutMs, signal, env) => {
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

function invalid(): never {
	throw new Error("Invalid GitHub pull request health response");
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	return value as Record<string, unknown>;
}

function text(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) invalid();
	return value;
}

function parse(output: string): Record<string, unknown> {
	return object(JSON.parse(output));
}

// Only identity/version metadata is needed. Never fetch comment bodies or perform mutations.
const reviewQuery = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
	repository(owner: $owner, name: $name) {
		pullRequest(number: $number) {
			reviewThreads(first: ${pageSize}, after: $cursor) {
				nodes { id isResolved isOutdated comments(last: 1) { totalCount nodes { id updatedAt } } }
				pageInfo { hasNextPage endCursor }
			}
		}
	}
}`;

const stackQuery = `query($owner: String!, $name: String!, $number: Int!, $head: String!) {
	repository(owner: $owner, name: $name) {
		pullRequest(number: $number) { ${stackBaseFields("$head")} }
	}
}`;

export async function discoverPullRequestProblems(
	session: { cwd: string; workspace?: { upstream?: string; branch?: string }; pullRequest?: SessionPullRequest },
	runner: Runner = run,
): Promise<PullRequestProblems> {
	return (await discoverPullRequestHealth(session, runner)).problems;
}

export async function discoverPullRequestHealth(
	session: { cwd: string; workspace?: { upstream?: string; branch?: string }; pullRequest?: SessionPullRequest },
	runner: Runner = run,
	unsupported = new Set<string>(),
): Promise<Extract<HealthResult, { problems: PullRequestProblems }>> {
	const pr = session.pullRequest;
	if (!pr || pr.state === "merged" || pr.state === "closed")
		return { problems: { failedChecks: [], reviewComments: 0, mergeConflicts: false } };
	if (
		(pr.state !== "open" && pr.state !== "draft") ||
		!Number.isSafeInteger(pr.number) ||
		pr.number <= 0 ||
		pr.number > 2_147_483_647
	)
		throw new Error("Invalid open pull request for health discovery");

	// Both a per-command timeout and a sweep budget apply, including to legacy origin lookup.
	const deadline = Date.now() + 60_000;
	const command = async (file: string, args: string[]) => {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error("Pull request health lookup timed out");
		const output = await runner(file, args, session.cwd, Math.min(commandTimeoutMs, remaining));
		if (Buffer.byteLength(output, "utf8") > maxOutputBytes)
			throw new Error("Pull request health output exceeded 1 MiB");
		if (Date.now() > deadline) throw new Error("Pull request health lookup timed out");
		return output;
	};
	const upstream = session.workspace?.upstream ?? (await command("git", ["remote", "get-url", "origin"]));
	const repo = githubRepository(upstream.trim());
	const url = new URL(pr.url);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.port ||
		url.search ||
		url.hash ||
		url.hostname.toLowerCase() !== repo.host.toLowerCase() ||
		url.pathname.toLowerCase() !== `/${repo.owner}/${repo.name}/pull/${pr.number}`.toLowerCase()
	)
		throw new Error("Invalid GitHub pull request URL for health discovery");

	let view: Record<string, unknown>;
	for (;;) {
		try {
			view = parse(
				await command("gh", [
					"pr",
					"view",
					String(pr.number),
					`--repo=${repo.identity}`,
					`--json=statusCheckRollup,mergeable,state,headRefName,isDraft${readinessFields
						.filter((field) => !unsupported.has(field))
						.map((field) => `,${field}`)
						.join("")}`,
				]),
			);
			break;
		} catch (error) {
			const field = unsupportedReadinessField(error);
			if (!field || unsupported.has(field)) throw error;
			unsupported.add(field);
		}
	}
	if (view.state !== "OPEN" && view.state !== "CLOSED" && view.state !== "MERGED") invalid();
	if (view.state !== "OPEN") return { problems: { failedChecks: [], reviewComments: 0, mergeConflicts: false } };
	const head = text(view.headRefName);
	if (session.workspace?.branch !== undefined && head !== session.workspace.branch)
		throw new Error("GitHub pull request head does not match the session workspace branch");
	const checks = failedChecks(view.statusCheckRollup);
	if (typeof view.mergeable !== "string") invalid();
	// UNKNOWN (and future mergeability values) are not evidence of a conflict.
	const mergeConflicts = view.mergeable === "CONFLICTING";
	let divergedFrom: string | undefined;
	if (pr.stack) {
		const response = parse(
			await command("gh", [
				"api",
				"graphql",
				`--hostname=${repo.host}`,
				"-f",
				`query=${stackQuery}`,
				"-f",
				`owner=${repo.owner}`,
				"-f",
				`name=${repo.name}`,
				"-F",
				`number=${pr.number}`,
				"-f",
				`head=refs/heads/${head}`,
			]),
		);
		if (response.errors !== undefined && (!Array.isArray(response.errors) || response.errors.length)) invalid();
		divergedFrom = stackDivergence(object(object(object(response.data).repository).pullRequest), pr.stack.baseBranch);
	}
	const problems = (reviewComments: number): PullRequestProblems => ({
		failedChecks: checks,
		reviewComments,
		mergeConflicts,
		...(reviewThreads.length ? { reviewThreads } : {}),
		...(divergedFrom ? { divergedFrom } : {}),
		...(checksRunning(view.statusCheckRollup) ? { checksRunning: true as const } : {}),
	});
	let reviewComments = 0;
	const reviewThreads: NonNullable<PullRequestProblems["reviewThreads"]> = [];
	let cursor: string | undefined;
	const cursors = new Set<string>();
	const threads = new Set<string>();
	for (let page = 0; page < maxPages; page++) {
		const response = parse(
			await command("gh", [
				"api",
				"graphql",
				`--hostname=${repo.host}`,
				"-f",
				`query=${reviewQuery}`,
				"-f",
				`owner=${repo.owner}`,
				"-f",
				`name=${repo.name}`,
				"-F",
				`number=${pr.number}`,
				...(cursor === undefined ? [] : ["-f", `cursor=${cursor}`]),
			]),
		);
		// GraphQL can return partial data alongside errors, even with a successful exit status.
		if (response.errors !== undefined && (!Array.isArray(response.errors) || response.errors.length)) invalid();
		const connection = object(object(object(object(response.data).repository).pullRequest).reviewThreads);
		if (!Array.isArray(connection.nodes) || connection.nodes.length > pageSize) invalid();
		for (const node of connection.nodes) {
			const thread = object(node);
			const id = text(thread.id);
			if (threads.has(id) || typeof thread.isResolved !== "boolean" || typeof thread.isOutdated !== "boolean")
				invalid();
			threads.add(id);
			const comments = object(thread.comments);
			if (!Number.isSafeInteger(comments.totalCount) || (comments.totalCount as number) < 0) invalid();
			if (!thread.isResolved && !thread.isOutdated && (comments.totalCount as number) > 0) {
				reviewComments++;
				reviewThreads.push({ id, ...reviewCommentVersion(comments) });
			}
		}
		const pageInfo = object(connection.pageInfo);
		if (typeof pageInfo.hasNextPage !== "boolean") invalid();
		if (pageInfo.endCursor !== null && typeof pageInfo.endCursor !== "string") invalid();
		if (!pageInfo.hasNextPage) {
			const result = problems(reviewComments);
			return {
				problems: result,
				readiness: mergeReadiness({ state: view.state, ...view }, result, checksPending(view.statusCheckRollup)),
			};
		}
		cursor = text(pageInfo.endCursor);
		if (!connection.nodes.length || cursors.has(cursor)) invalid();
		cursors.add(cursor);
	}
	throw new Error("Pull request review thread pagination exceeded 20 pages");
}
