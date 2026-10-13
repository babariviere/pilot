import assert from "node:assert/strict";
import { test } from "node:test";
import { githubRepository, lookupHealth, lookupPullRequests, RateLimits, toSessionPullRequest } from "./github.ts";
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

test("batched PR lookups carry one-based stack membership and clear it when unlinked", async () => {
	let stacked = true;
	let calls = 0;
	const runner: Runner = async (_file, args) => {
		calls++;
		assert.match(variables(args).get("query")!, /stack \{ number size baseRefName \} stackEntry \{ position \}/);
		return respond({
			n0: pr(42, "feat/top", {
				stack: stacked ? { number: 9, size: 3, baseRefName: "main" } : null,
				stackEntry: stacked ? { position: 2 } : null,
			}),
		});
	};
	const lookup = async () =>
		toSessionPullRequest((await lookupPullRequests(repo, { numbers: [42] }, "/workspace", runner)).numbers.get(42)!);
	assert.deepEqual((await lookup()).stack, { number: 9, size: 3, position: 2, baseBranch: "main" });
	stacked = false;
	assert.equal((await lookup()).stack, undefined);
	assert.equal(calls, 2, "no per-PR or per-stack process is needed");
});

test("servers without stack schema retry normal PR metadata and remember the host capability", async () => {
	for (const message of [
		"Field 'stack' doesn't exist on type 'PullRequest'",
		'Cannot query field "stackEntry" on type "PullRequest".',
	]) {
		const limits = new RateLimits();
		let calls = 0;
		const runner: Runner = async (_file, args) => {
			calls++;
			if (variables(args).get("query")!.includes("stackEntry")) throw new Error(message);
			return respond({ n0: pr(42, "feat/top") });
		};
		for (let i = 0; i < 2; i++) {
			const result = await lookupPullRequests(repo, { numbers: [42] }, "/workspace", runner, limits);
			assert.equal(result.numbers.get(42)?.number, 42);
			assert.equal(result.numbers.get(42)?.stack, undefined);
		}
		assert.equal(calls, 3);
	}
});

test("malformed optional stack data never creates a misleading position", async () => {
	for (const position of [0, -1, 4, 1.5, "2", null]) {
		const result = await lookupPullRequests(repo, { numbers: [42] }, "/workspace", async () =>
			respond({
				n0: pr(42, "feat/top", { stack: { number: 9, size: 3, baseRefName: "main" }, stackEntry: { position } }),
			}),
		);
		assert.equal(result.numbers.get(42)?.stack, undefined);
	}
});

test("partial GraphQL schema errors fall back, but permissions and network errors do not", async () => {
	let calls = 0;
	const runner: Runner = async (_file, args) => {
		calls++;
		return variables(args).get("query")!.includes("stackEntry")
			? JSON.stringify({
					data: null,
					errors: [{ message: 'Cannot query field "stack" on type "PullRequest".' }],
				})
			: respond({ n0: pr(42, "feat/top") });
	};
	assert.equal((await lookupPullRequests(repo, { numbers: [42] }, "/workspace", runner)).numbers.get(42)?.number, 42);
	assert.equal(calls, 2);
	for (const message of ["Resource not accessible by integration", "network unavailable"]) {
		calls = 0;
		const result = await lookupPullRequests(repo, { numbers: [42] }, "/workspace", async () => {
			calls++;
			throw new Error(message);
		});
		assert.equal(calls, 1);
		assert.equal(result.numberErrors.get(42)?.message, message);
	}
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

test("stacked PR health reports a head that no longer contains its base branch", async () => {
	const seen: Map<string, string>[] = [];
	const runner: Runner = async (_file, args) => {
		seen.push(variables(args));
		const compare = (behindBy: unknown) => ({ baseRefName: "feat/bottom", baseRef: { compare: { behindBy } } });
		return respond({
			p0: health(1, compare(1)),
			p1: health(2, compare(0)),
			p2: health(3, { baseRefName: "feat/gone", baseRef: null }),
			p3: health(4),
			p4: health(5, compare(-1)),
		});
	};
	const results = await lookupHealth(
		repo,
		[
			{ number: 1, branch: "feat/1", stacked: true },
			{ number: 2, branch: "feat/2", stacked: true },
			{ number: 3, branch: "feat/3", stacked: true },
			{ number: 4, branch: "feat/4" },
			{ number: 5, branch: "feat/5", stacked: true },
		],
		"/clone",
		runner,
	);
	const healthy = { failedChecks: [], reviewComments: 0, mergeConflicts: false };
	assert.deepEqual(results.get(1), { problems: { ...healthy, divergedFrom: "feat/bottom" } });
	assert.deepEqual(results.get(2), { problems: healthy });
	assert.deepEqual(results.get(3), { problems: healthy }, "a deleted base is not evidence of divergence");
	assert.deepEqual(results.get(4), { problems: healthy });
	assert.ok("error" in results.get(5)!, "an invalid comparison is never read as healthy");
	const query = seen[0]!.get("query")!;
	assert.match(query, /\$h0: String!/);
	assert.match(query, /p0: pullRequest\(number: \$p0\) \{[^\n]*baseRef \{ compare\(headRef: \$h0\) \{ behindBy \} \}/);
	assert.doesNotMatch(query, /\$h3/, "unstacked PRs skip the comparison");
	assert.equal(seen[0]!.get("h0"), "refs/heads/feat/1");
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

test("large stacked-PR discovery retains the existing bounded batch count", async () => {
	let calls = 0;
	const heads = Array.from({ length: 100 }, (_, i) => `feat/${i}`);
	const numbers = Array.from({ length: 100 }, (_, i) => i + 1);
	const runner: Runner = async (_file, args) => {
		calls++;
		const repository: Record<string, unknown> = {};
		const stacked = (number: number, head: string, position: number) =>
			pr(number, head, {
				stack: { number: 101, size: 100, baseRefName: "main" },
				stackEntry: { position },
			});
		for (const [key, value] of variables(args)) {
			if (/^h\d+$/.test(key)) {
				const position = Number(value.split("/")[1]) + 1;
				repository[`o${key.slice(1)}`] = { nodes: [] };
				repository[`a${key.slice(1)}`] = {
					nodes: Array.from({ length: 20 }, (_, i) => stacked(1000 + position * 20 + i, value, position)),
				};
			} else if (/^n\d+$/.test(key))
				repository[key] = stacked(Number(value), `feat/${Number(value) - 1}`, Number(value));
		}
		return respond(repository);
	};
	const result = await lookupPullRequests(repo, { heads, numbers }, "/workspace", runner);
	assert.equal(calls, 5, "100 heads and 100 hand-linked PRs need five existing batches, not per-stack requests");
	assert.equal(result.heads.size, 100);
	assert.equal(result.numbers.size, 100);
	assert.equal(result.heads.get("feat/99")?.stack?.position, 100);
	assert.equal(result.numbers.get(1)?.stack?.position, 1);
});
