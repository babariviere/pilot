import assert from "node:assert/strict";
import { test } from "node:test";
import { githubRepository, lookupHealth, lookupPullRequests, RateLimits } from "./github.ts";
import type { Runner } from "./workspaces.ts";

const repo = githubRepository("git@github.com:octo/repo.git");

function variables(args: string[]): Map<string, string> {
	const values = new Map<string, string>();
	for (let i = 0; i < args.length; i++)
		if (args[i] === "-f" || args[i] === "-F") {
			const [name, ...rest] = args[++i]!.split("=");
			values.set(name!, rest.join("="));
		}
	return values;
}

function respond(
	repository: Record<string, unknown>,
	rateLimit = { remaining: 4_000, resetAt: "2100-01-01T00:00:00Z" },
) {
	return JSON.stringify({ data: { rateLimit, repository } });
}

function pr(number: number, head: string, extra: Record<string, unknown> = {}) {
	return {
		number,
		url: `https://github.com/octo/repo/pull/${number}`,
		title: "PR",
		state: "OPEN",
		isDraft: false,
		headRefName: head,
		isCrossRepository: false,
		createdAt: "2026-01-01T00:00:00Z",
		mergedAt: null,
		...extra,
	};
}

function health(number: number, extra: Record<string, unknown> = {}) {
	return {
		number,
		state: "OPEN",
		headRefName: `feat/${number}`,
		mergeable: "MERGEABLE",
		commits: {
			nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [], pageInfo: { hasNextPage: false } } } } }],
		},
		reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
		...extra,
	};
}

test("discovery chunks heads, prefers open PRs and reads the aggregate check state", async () => {
	const queries: Map<string, string>[] = [];
	const heads = Array.from({ length: 25 }, (_, i) => `feat/${i}`);
	const runner: Runner = async (_file, args) => {
		const vars = variables(args);
		queries.push(vars);
		const repository: Record<string, unknown> = {};
		for (const [key, head] of vars) {
			if (!/^h\d+$/.test(key)) continue;
			const index = key.slice(1);
			const number = Number(head.split("/")[1]) + 1;
			repository[`o${index}`] = {
				nodes:
					number === 1
						? [pr(1, head, { commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] } })]
						: [],
			};
			repository[`a${index}`] = {
				nodes: [
					pr(number, head, { state: "MERGED", mergedAt: "2026-01-02T00:00:00Z" }),
					pr(900 + number, head, { isCrossRepository: true }),
				],
			};
		}
		return respond(repository);
	};
	const result = await lookupPullRequests(repo, { heads }, "/clone", runner);
	assert.equal(queries.length, 2, "20 heads per request");
	assert.equal(result.heads.get("feat/0")?.number, 1);
	assert.equal(result.heads.get("feat/0")?.checks, "pending");
	assert.equal(result.heads.get("feat/24")?.number, 25);
	assert.equal(result.heads.get("feat/24")?.state, "MERGED", "same-named fork PRs are ignored");
});

test("known open PRs are read by number, and a settled or moved one falls back to a head search", async () => {
	const requests: Map<string, string>[] = [];
	const runner: Runner = async (_file, args) => {
		const vars = variables(args);
		requests.push(vars);
		const repository: Record<string, unknown> = {};
		for (const [key, value] of vars) {
			if (/^n\d+$/.test(key)) {
				const number = Number(value);
				repository[key] =
					number === 1
						? pr(1, "feat/open")
						: number === 2
							? pr(2, "feat/merged", { state: "MERGED", mergedAt: "2026-01-02T00:00:00Z" })
							: pr(3, "someone-else");
			} else if (/^h\d+$/.test(key)) {
				const index = key.slice(1);
				repository[`o${index}`] = { nodes: value === "feat/merged" ? [pr(9, value)] : [] };
				repository[`a${index}`] = { nodes: [] };
			}
		}
		return respond(repository);
	};
	const known = new Map([
		["feat/open", 1],
		["feat/merged", 2],
		["feat/moved", 3],
	]);
	const result = await lookupPullRequests(repo, { heads: [...known.keys()], known }, "/clone", runner);
	assert.equal(result.heads.get("feat/open")?.number, 1);
	assert.equal(result.heads.get("feat/merged")?.number, 9, "a reopened or newer PR on the head is found");
	assert.equal(result.heads.get("feat/moved"), undefined);
	assert.equal(requests.length, 2);
	assert.deepEqual(
		[...requests[0]!.keys()].filter((key) => /^[hn]\d+$/.test(key)),
		["n0", "n1", "n2"],
		"no head search while the known PR is open",
	);
	assert.deepEqual(
		[...requests[1]!].filter(([key]) => /^h\d+$/.test(key)).map(([, value]) => value),
		["feat/merged", "feat/moved"],
	);
});

test("one unreadable linked PR is isolated, while head lookup failures fail the request", async () => {
	let calls = 0;
	const runner: Runner = async (_file, args) => {
		calls++;
		const vars = variables(args);
		const numbers = [...vars].filter(([key]) => /^n\d+$/.test(key));
		if (numbers.some(([, value]) => value === "43")) throw new Error("Could not resolve to a PullRequest");
		return respond(Object.fromEntries(numbers.map(([key, value]) => [key, pr(Number(value), "external")])));
	};
	const result = await lookupPullRequests(repo, { numbers: [42, 43, 44] }, "/project", runner);
	assert.deepEqual([...result.numbers.keys()].sort(), [42, 44]);
	assert.match(result.numberErrors.get(43)!.message, /Could not resolve/);
	assert.equal(calls, 4, "the combined request, then each number alone");
	await assert.rejects(
		lookupPullRequests(repo, { heads: ["feat/a"], numbers: [1] }, "/clone", async () => {
			throw new Error("offline");
		}),
		/offline/,
	);
});

test("health reports failed checks, live review threads and conflicts, and flags very busy PRs", async () => {
	const runner: Runner = async () =>
		respond({
			p0: health(1, {
				mergeable: "CONFLICTING",
				commits: {
					nodes: [
						{
							commit: {
								statusCheckRollup: {
									contexts: {
										nodes: [
											{ __typename: "CheckRun", name: "tests", status: "COMPLETED", conclusion: "FAILURE" },
											{ __typename: "CheckRun", name: "lint", status: "IN_PROGRESS", conclusion: null },
											{ __typename: "StatusContext", context: "ci/legacy", state: "ERROR" },
										],
										pageInfo: { hasNextPage: false },
									},
								},
							},
						},
					],
				},
				reviewThreads: {
					nodes: [
						{ id: "t1", isResolved: false, isOutdated: false, comments: { totalCount: 2 } },
						{ id: "t2", isResolved: true, isOutdated: false, comments: { totalCount: 1 } },
						{ id: "t3", isResolved: false, isOutdated: true, comments: { totalCount: 1 } },
					],
					pageInfo: { hasNextPage: false },
				},
			}),
			p1: health(2, { reviewThreads: { nodes: [], pageInfo: { hasNextPage: true } } }),
			p2: health(3, { headRefName: "someone-else" }),
			p3: health(4, { state: "MERGED", mergeable: undefined }),
			p4: health(5, { commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }),
		});
	const results = await lookupHealth(
		repo,
		[1, 2, 3, 4, 5].map((number) => ({ number, branch: `feat/${number}` })),
		"/clone",
		runner,
	);
	assert.deepEqual(results.get(1), {
		problems: { failedChecks: ["tests", "ci/legacy"], reviewComments: 1, mergeConflicts: true },
	});
	assert.deepEqual(results.get(2), { overflow: true });
	assert.match((results.get(3) as { error: Error }).error.message, /head does not match/);
	assert.deepEqual(results.get(4), { problems: { failedChecks: [], reviewComments: 0, mergeConflicts: false } });
	assert.deepEqual(results.get(5), { problems: { failedChecks: [], reviewComments: 0, mergeConflicts: false } });
});

test("a failing health request is retried per PR, and GraphQL errors are never read as healthy", async () => {
	const runner: Runner = async (_file, args) => {
		const numbers = [...variables(args)].filter(([key]) => /^p\d+$/.test(key));
		if (numbers.length > 1) throw new Error("partial failure");
		const [key, value] = numbers[0]!;
		if (value === "2") return JSON.stringify({ data: { repository: { [key]: null } }, errors: [{ message: "x" }] });
		return respond({ [key]: health(Number(value)) });
	};
	const results = await lookupHealth(repo, [{ number: 1 }, { number: 2 }], "/clone", runner);
	assert.ok("problems" in results.get(1)!);
	assert.ok("error" in results.get(2)!);
});

test("rate limits pause a host near exhaustion until the reset, capped at an hour", () => {
	const limits = new RateLimits(100);
	const now = Date.parse("2026-01-01T00:00:00Z");
	limits.observe("github.com", { remaining: 50, resetAt: "2026-01-01T00:10:00Z" });
	assert.equal(limits.blockedUntil("github.com", now), Date.parse("2026-01-01T00:10:00Z"));
	assert.equal(limits.blockedUntil("github.example.com", now), 0);
	limits.observe("github.com", { remaining: 50, resetAt: "2026-01-01T05:00:00Z" });
	assert.equal(limits.blockedUntil("github.com", now), now + 60 * 60_000);
	limits.observe("github.com", { remaining: 4_000, resetAt: "2026-01-01T05:00:00Z" });
	assert.equal(limits.blockedUntil("github.com", now), 0);
	limits.observe("github.com", { remaining: "lots" });
	assert.equal(limits.blockedUntil("github.com", now), 0, "malformed limits are ignored");
});
