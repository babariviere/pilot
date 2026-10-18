/** Exact-head, read-only PR check details for the global control chat. */
import { githubRepository, run } from "./github.ts";
import type { Runner } from "./workspaces.ts";

const commandTimeoutMs = 10_000;
const pageSize = 100;
const maxPages = 5;
const maxChecks = 20;
const maxNameLength = 120;
const maxOutputBytes = 24_000;

const query = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
	repository(owner: $owner, name: $name) {
		pullRequest(number: $number) {
			headRefOid
			commits(last: 1) { nodes { commit {
				oid
				statusCheckRollup {
					contexts(first: ${pageSize}, after: $cursor) {
						nodes {
							__typename
							... on CheckRun { databaseId name status conclusion detailsUrl checkSuite { headSha } }
						}
						pageInfo { hasNextPage endCursor }
					}
				}
			} } }
		}
	}
}`;

type Check = {
	name: string;
	status: string;
	conclusion: string | null;
	runId: number;
	url: string;
	stale?: true;
	headSha?: string;
};

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid GitHub PR checks response");
	return value as Record<string, unknown>;
}

function sha(value: unknown): string {
	if (typeof value !== "string" || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value))
		throw new Error("Invalid GitHub PR checks response");
	return value;
}

function parsePrUrl(value: string): { host: string; owner: string; name: string; number: number } {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("pr must be a GitHub pull request URL");
	}
	if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash)
		throw new Error("pr must be a GitHub pull request URL");
	const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname);
	if (!match) throw new Error("pr must be a GitHub pull request URL");
	const repository = githubRepository(`https://${url.hostname}/${match[1]}/${match[2]}`);
	const number = Number(match[3]);
	if (!Number.isSafeInteger(number) || number > 2_147_483_647) throw new Error("Invalid pull request number");
	return { host: repository.host, owner: repository.owner, name: repository.name, number };
}

function parseCheck(node: Record<string, unknown>, headSha: string, includeStale: boolean): Check | undefined {
	if (node.__typename !== "CheckRun") return undefined;
	const suite = object(node.checkSuite);
	const checkSha = sha(suite.headSha);
	const stale = checkSha.toLowerCase() !== headSha.toLowerCase();
	if (stale && !includeStale) return undefined;
	if (!Number.isSafeInteger(node.databaseId) || (node.databaseId as number) <= 0)
		throw new Error("Invalid GitHub PR checks response");
	if (typeof node.name !== "string" || !node.name.trim() || typeof node.status !== "string" || !node.status.trim())
		throw new Error("Invalid GitHub PR checks response");
	if (node.conclusion !== null && typeof node.conclusion !== "string")
		throw new Error("Invalid GitHub PR checks response");
	if (typeof node.detailsUrl !== "string" || node.detailsUrl.length > 2048)
		throw new Error("Invalid GitHub PR checks response");
	let url: URL;
	try {
		url = new URL(node.detailsUrl);
	} catch {
		throw new Error("Invalid GitHub PR checks response");
	}
	if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid GitHub PR checks response");
	return {
		name: node.name.slice(0, maxNameLength),
		status: node.status.slice(0, 40),
		conclusion: node.conclusion === null ? null : node.conclusion.slice(0, 40),
		runId: node.databaseId as number,
		url: node.detailsUrl,
		...(stale ? { stale: true, headSha: checkSha } : {}),
	};
}

/** Fetches current-head check runs via GraphQL. Every result is tied to the PR's current head SHA. */
export async function pullRequestChecks(
	prUrl: string,
	includeStale = false,
	runner: Runner = run,
): Promise<{ untrusted: true; headSha: string; checks: Check[]; truncated: boolean }> {
	const pr = parsePrUrl(prUrl);
	const checks: Check[] = [];
	let headSha: string | undefined;
	let cursor: string | undefined;
	let truncated = false;
	let pageInfo: Record<string, unknown> | undefined;
	const cursors = new Set<string>();
	for (let page = 0; page < maxPages; page++) {
		const args = [
			"api",
			"graphql",
			`--hostname=${pr.host}`,
			"-f",
			`query=${query}`,
			"-f",
			`owner=${pr.owner}`,
			"-f",
			`name=${pr.name}`,
			"-F",
			`number=${pr.number}`,
			...(cursor === undefined ? [] : ["-f", `cursor=${cursor}`]),
		];
		const output = await runner("gh", args, process.cwd(), commandTimeoutMs);
		if (Buffer.byteLength(output, "utf8") > 4 * 1024 * 1024)
			throw new Error("GitHub PR checks response exceeded 4 MiB");
		let response: Record<string, unknown>;
		try {
			response = object(JSON.parse(output));
		} catch {
			throw new Error("Invalid GitHub PR checks response");
		}
		if (response.errors !== undefined && (!Array.isArray(response.errors) || response.errors.length > 0))
			throw new Error("GitHub GraphQL PR checks lookup failed");
		const repository = object(object(response.data).repository);
		const pullRequest = object(repository.pullRequest);
		const currentHead = sha(pullRequest.headRefOid);
		if (headSha !== undefined && currentHead.toLowerCase() !== headSha.toLowerCase())
			throw new Error("Pull request head changed while loading checks; retry for the latest head");
		headSha = currentHead;
		const commits = object(pullRequest.commits);
		if (!Array.isArray(commits.nodes) || commits.nodes.length !== 1)
			throw new Error("Invalid GitHub PR checks response");
		const commit = object(object(commits.nodes[0]).commit);
		if (sha(commit.oid).toLowerCase() !== currentHead.toLowerCase())
			throw new Error("Pull request head changed while loading checks; retry for the latest head");
		if (commit.statusCheckRollup === null) {
			if (cursor !== undefined) throw new Error("Invalid GitHub PR checks response");
			return { untrusted: true, headSha: currentHead, checks, truncated: false };
		}
		const connection = object(object(commit.statusCheckRollup).contexts);
		if (!Array.isArray(connection.nodes) || connection.nodes.length > pageSize)
			throw new Error("Invalid GitHub PR checks response");
		for (const raw of connection.nodes) {
			const check = parseCheck(object(raw), currentHead, includeStale);
			if (!check) continue;
			if (checks.length === maxChecks) {
				truncated = true;
				break;
			}
			checks.push(check);
		}
		pageInfo = object(connection.pageInfo);
		if (
			typeof pageInfo.hasNextPage !== "boolean" ||
			(pageInfo.endCursor !== null && typeof pageInfo.endCursor !== "string")
		)
			throw new Error("Invalid GitHub PR checks response");
		if (truncated || !pageInfo.hasNextPage) break;
		cursor = pageInfo.endCursor as string;
		if (!cursor || cursors.has(cursor)) throw new Error("Invalid GitHub PR checks pagination");
		cursors.add(cursor);
	}
	if (!truncated && pageInfo?.hasNextPage === true) truncated = true;
	const result = { untrusted: true as const, headSha: headSha!, checks, truncated };
	while (Buffer.byteLength(JSON.stringify(result), "utf8") > maxOutputBytes && result.checks.length) {
		result.checks.pop();
		result.truncated = true;
	}
	return result;
}
