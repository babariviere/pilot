import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverPullRequestProblems } from "./pull-request-health.ts";
import type { Runner } from "./workspaces.ts";

const healthy = { failedChecks: [], reviewComments: 0, mergeConflicts: false };
const session = () => ({
	cwd: "/private/clone",
	workspace: { upstream: "git@github.com:octo/repo.git" },
	pullRequest: {
		number: 42,
		url: "https://github.com/octo/repo/pull/42",
		title: "Fix the bug",
		state: "open" as "open" | "draft" | "closed" | "merged",
		checkedAt: 1,
	},
});

function check(name: string, conclusion: string | null = "FAILURE", status = "COMPLETED") {
	return { __typename: "CheckRun", name, conclusion, status };
}

function context(name: string, state: string) {
	return { __typename: "StatusContext", context: name, state };
}

function view(statusCheckRollup: unknown = [], mergeable: unknown = "MERGEABLE") {
	return { statusCheckRollup, mergeable, state: "OPEN", headRefName: "fix-bug" };
}

function thread(id: string, overrides: Record<string, unknown> = {}) {
	return { id, isResolved: false, isOutdated: false, comments: { totalCount: 1 }, ...overrides };
}

function page(nodes: unknown[] = [], hasNextPage = false, endCursor: string | null = null) {
	return {
		data: { repository: { pullRequest: { reviewThreads: { nodes, pageInfo: { hasNextPage, endCursor } } } } },
	};
}

function responses(prView: unknown = view(), pages: unknown[] = [page()]): Runner {
	let index = 0;
	return async (file, args, cwd, timeout) => {
		assert.equal(file, "gh", "recorded upstream avoids local origin lookup");
		assert.equal(cwd, "/private/clone");
		assert.ok(timeout !== undefined && timeout > 0 && timeout <= 10_000);
		if (args[0] === "pr") return JSON.stringify(prView);
		assert.deepEqual(args.slice(0, 2), ["api", "graphql"]);
		assert.ok(index < pages.length, "unexpected extra page request");
		return JSON.stringify(pages[index++]);
	};
}

test("open and draft PR health uses explicit repository, hostname and typed GraphQL variables, without writes", async () => {
	for (const state of ["open", "draft"] as const) {
		const target = session();
		target.pullRequest.state = state;
		const before = structuredClone(target);
		const calls: string[][] = [];
		const result = await discoverPullRequestProblems(target, async (file, args, cwd, timeout) => {
			assert.equal(file, "gh");
			assert.equal(cwd, target.cwd);
			assert.ok(timeout !== undefined && timeout > 0 && timeout <= 10_000);
			calls.push(args);
			return JSON.stringify(args[0] === "pr" ? view([check("CI")], "CONFLICTING") : page([thread("T1")]));
		});
		assert.deepEqual(result, { failedChecks: ["CI"], reviewComments: 1, mergeConflicts: true });
		assert.deepEqual(target, before, "discovery cannot mutate cached metadata");
		assert.deepEqual(calls[0], [
			"pr",
			"view",
			"42",
			"--repo=github.com/octo/repo",
			"--json=statusCheckRollup,mergeable,state,headRefName",
		]);
		const graphql = calls[1]!;
		assert.deepEqual(graphql.slice(0, 3), ["api", "graphql", "--hostname=github.com"]);
		assert.ok(graphql.includes("owner=octo"));
		assert.ok(graphql.includes("name=repo"));
		assert.equal(graphql[graphql.indexOf("number=42") - 1], "-F");
		assert.ok(!graphql.some((arg) => arg.startsWith("cursor=")));
		const query = graphql.find((arg) => arg.startsWith("query="))!;
		assert.match(query, /reviewThreads\(first: 100, after: \$cursor\)/);
		assert.match(query, /comments\(first: 1\) \{ totalCount \}/);
		assert.doesNotMatch(query, /\bmutation\b|\bbody\b/);
		assert.equal(calls.length, 2);
	}
});

test("absent and settled PRs require no commands", async () => {
	const runner: Runner = async () => {
		assert.fail("must not query a settled or absent PR");
	};
	assert.deepEqual(await discoverPullRequestProblems({ cwd: "/clone" }, runner), healthy);
	for (const state of ["merged", "closed"] as const) {
		const target = session();
		target.pullRequest.state = state;
		assert.deepEqual(await discoverPullRequestProblems(target, runner), healthy);
	}
});

test("PRs closed or merged during discovery cannot report problems or request review threads", async () => {
	for (const state of ["CLOSED", "MERGED"]) {
		const target = session();
		let calls = 0;
		const result = await discoverPullRequestProblems(target, async (_file, args) => {
			assert.equal(args[0], "pr", "a settled PR must not request review threads");
			calls++;
			return JSON.stringify({ ...view([check("CI")], "CONFLICTING"), state });
		});
		assert.deepEqual(result, healthy);
		assert.equal(calls, 1);
		assert.equal(target.pullRequest.state, "open", "discovery does not update the cached state");
	}
});

test("validates authoritative state and the workspace branch before querying review threads", async () => {
	for (const state of [undefined, null, 1, "open", "DRAFT", "UNKNOWN"]) {
		await assert.rejects(discoverPullRequestProblems(session(), responses({ ...view(), state })), /Invalid GitHub/);
	}
	for (const headRefName of [undefined, null, 1, ""]) {
		await assert.rejects(
			discoverPullRequestProblems(session(), responses({ ...view(), headRefName })),
			/Invalid GitHub/,
		);
	}
	const target = { ...session(), workspace: { ...session().workspace, branch: "fix-bug" } };
	assert.deepEqual(await discoverPullRequestProblems(target, responses()), healthy);
	target.workspace.branch = "new-task";
	let calls = 0;
	await assert.rejects(
		discoverPullRequestProblems(target, async (_file, args) => {
			assert.equal(args[0], "pr");
			calls++;
			return JSON.stringify(view([check("CI")], "CONFLICTING"));
		}),
		/does not match the session workspace branch/,
	);
	assert.equal(calls, 1);
});

test("legacy upstream lookup is read-only, enterprise hosts are explicit, and no workspace is required", async () => {
	const target = session();
	target.pullRequest.url = "https://git.example.com/team/project/pull/42";
	const { workspace: _workspace, ...legacy } = target;
	const calls: string[][] = [];
	assert.deepEqual(
		await discoverPullRequestProblems(legacy, async (file, args, cwd, timeout) => {
			assert.equal(cwd, target.cwd);
			assert.ok(timeout !== undefined && timeout > 0 && timeout <= 10_000);
			calls.push(args);
			if (file === "git") {
				assert.deepEqual(args, ["remote", "get-url", "origin"]);
				return "ssh://git@git.example.com/team/project.git\n";
			}
			assert.equal(file, "gh");
			if (args[0] === "pr") {
				assert.ok(args.includes("--repo=git.example.com/team/project"));
				return JSON.stringify(view());
			}
			assert.ok(args.includes("--hostname=git.example.com"));
			assert.ok(args.includes("owner=team"));
			assert.ok(args.includes("name=project"));
			return JSON.stringify(page());
		}),
		healthy,
	);
	assert.equal(calls.length, 3);
});

test("only failed terminal checks and legacy FAILURE/ERROR count, with stable unique names", async () => {
	const rollup = [
		...["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED"].map((value) => check(value, value)),
		...["SUCCESS", "NEUTRAL", "CANCELLED", "SKIPPED", "STALE"].map((value) => check(value, value)),
		...["IN_PROGRESS", "QUEUED", "REQUESTED", "WAITING", "PENDING"].map((value) => check(value, null, value)),
		check("not terminal", "FAILURE", "IN_PROGRESS"),
		check("gh pending empty conclusion", "", "IN_PROGRESS"),
		context("legacy failure", "FAILURE"),
		context("legacy error", "ERROR"),
		context("legacy pending", "PENDING"),
		context("legacy expected", "EXPECTED"),
		context("legacy success", "SUCCESS"),
		check("FAILURE"),
		context("legacy failure", "FAILURE"),
	];
	assert.deepEqual(await discoverPullRequestProblems(session(), responses(view(rollup))), {
		...healthy,
		failedChecks: ["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED", "legacy failure", "legacy error"],
	});
});

test("no checks and unknown mergeability are not problems", async () => {
	for (const rollup of [[], null]) {
		for (const mergeable of ["MERGEABLE", "UNKNOWN", "FUTURE_VALUE"])
			assert.deepEqual(await discoverPullRequestProblems(session(), responses(view(rollup, mergeable))), healthy);
	}
});

test("counts current unresolved threads with comments across explicit cursor pages, not individual comments", async () => {
	const pages = [
		page(
			[
				thread("one"),
				thread("many", { comments: { totalCount: 50 } }),
				thread("resolved", { isResolved: true }),
				thread("outdated", { isOutdated: true }),
				thread("both", { isResolved: true, isOutdated: true }),
				thread("empty", { comments: { totalCount: 0 } }),
			],
			true,
			"cursor/one+=",
		),
		page([thread("last")], false, "cursor/two"),
	];
	const runner = responses(view(), pages);
	let count = 0;
	const result = await discoverPullRequestProblems(session(), async (...args) => {
		if (args[1][0] === "api") {
			if (count++ === 0) assert.ok(!args[1].some((arg) => arg.startsWith("cursor=")));
			else {
				assert.ok(args[1].includes("cursor=cursor/one+="));
				assert.equal(args[1][args[1].indexOf("cursor=cursor/one+=") - 1], "-f");
			}
		}
		return runner(...args);
	});
	assert.deepEqual(result, { ...healthy, reviewComments: 3 });
	assert.equal(count, 2);
});

test("rejects invalid PR identity before any GitHub request", async () => {
	const invalidNumbers = [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, 2_147_483_648];
	for (const number of invalidNumbers) {
		const target = session();
		target.pullRequest.number = number;
		await assert.rejects(discoverPullRequestProblems(target, async () => assert.fail("unexpected request")));
	}
	for (const url of [
		"not a URL",
		"http://github.com/octo/repo/pull/42",
		"https://github.com/other/repo/pull/42",
		"https://github.com/octo/other/pull/42",
		"https://other.example/octo/repo/pull/42",
		"https://github.com/octo/repo/pull/41",
		"https://github.com/octo/repo/pull/42/extra",
		"https://user:secret@github.com/octo/repo/pull/42",
		"https://github.com:1234/octo/repo/pull/42",
		"https://github.com/octo/repo/pull/42?foo=bar",
		"https://github.com/octo/repo/pull/42#comment",
	]) {
		const target = session();
		target.pullRequest.url = url;
		await assert.rejects(discoverPullRequestProblems(target, async () => assert.fail("unexpected request")));
	}
	for (const upstream of ["/local/repo", "--repo=evil", "file:///repo", "https://github.com/-owner/repo"]) {
		const target = session();
		target.workspace.upstream = upstream;
		await assert.rejects(discoverPullRequestProblems(target, async () => assert.fail("unexpected request")));
	}
	const target = session();
	Object.assign(target.pullRequest, { state: "unexpected" });
	await assert.rejects(discoverPullRequestProblems(target, async () => assert.fail("unexpected request")));
});

test("malformed checks and missing fields fail closed, including non-failing entries", async () => {
	for (const malformed of [
		null,
		[],
		{},
		{ mergeable: "MERGEABLE" },
		{ statusCheckRollup: [] },
		view({}, "MERGEABLE"),
		view([], null),
		view([], true),
		...[
			null,
			{},
			{ __typename: "Other" },
			check(""),
			check("CI", null),
			check("CI", ""),
			check("CI", "NEW_RESULT"),
			check("CI", "SUCCESS", "NEW_STATUS"),
			{ ...check("CI"), conclusion: undefined },
			{ ...check("CI"), status: undefined },
			{ ...check("CI"), name: 1 },
			context("", "SUCCESS"),
			context("CI", "UNKNOWN"),
			{ ...context("CI", "SUCCESS"), state: undefined },
		].map((item) => view([item])),
	])
		await assert.rejects(discoverPullRequestProblems(session(), responses(malformed)), /Invalid GitHub/);
});

test("malformed and partial GraphQL responses fail closed, never returning partial health", async () => {
	const badThreads = [
		null,
		{},
		thread(""),
		thread("T", { isResolved: "false" }),
		thread("T", { isOutdated: undefined }),
		thread("T", { comments: null }),
		thread("T", { comments: {} }),
		thread("T", { comments: { totalCount: -1 } }),
		thread("T", { comments: { totalCount: 1.5 } }),
		thread("T", { comments: { totalCount: "1" } }),
		thread("T", { isResolved: true, comments: { totalCount: -1 } }),
	];
	const malformed: unknown[] = [
		null,
		[],
		{},
		{ data: null },
		{ data: { repository: null } },
		{ data: { repository: { pullRequest: null } } },
		{ ...page(), errors: [{ message: "permission denied" }] },
		{ ...page(), errors: {} },
		...badThreads.map((item) => page([item])),
		page([thread("duplicate"), thread("duplicate")]),
		page(Array.from({ length: 101 }, (_, index) => thread(String(index)))),
	];
	for (const response of malformed)
		await assert.rejects(
			discoverPullRequestProblems(session(), responses(view([check("CI")]), [response])),
			/Invalid GitHub/,
		);
	for (const connection of [
		{},
		{ nodes: null, pageInfo: { hasNextPage: false, endCursor: null } },
		{ nodes: [], pageInfo: null },
		{ nodes: [], pageInfo: { hasNextPage: "false", endCursor: null } },
		{ nodes: [], pageInfo: { hasNextPage: false } },
		{ nodes: [], pageInfo: { hasNextPage: false, endCursor: 1 } },
	]) {
		const response = { data: { repository: { pullRequest: { reviewThreads: connection } } } };
		await assert.rejects(discoverPullRequestProblems(session(), responses(view(), [response])), /Invalid GitHub/);
	}
});

test("pagination requires progressing cursors and distinct thread IDs", async () => {
	for (const pages of [
		[page([thread("T")], true, null)],
		[page([thread("T")], true, "")],
		[page([], true, "cursor")],
		[page([thread("T")], true, "cursor"), page([thread("T2")], true, "cursor")],
		[page([thread("T")], true, "cursor"), page([thread("T")])],
		[page([thread("T")], true, "one"), page([thread("T2")], true, "two"), page([thread("T3")], true, "one")],
	])
		await assert.rejects(discoverPullRequestProblems(session(), responses(view(), pages)), /Invalid GitHub/);
});

test("pagination stops at a bounded page limit rather than silently truncating results", async () => {
	const pages = Array.from({ length: 20 }, (_, index) => page([thread(`T${index}`)], true, `cursor${index}`));
	await assert.rejects(
		discoverPullRequestProblems(session(), responses(view(), pages)),
		/pagination exceeded 20 pages/,
	);
	pages[19] = page([thread("T19")]);
	assert.deepEqual(await discoverPullRequestProblems(session(), responses(view(), pages)), {
		...healthy,
		reviewComments: 20,
	});
});

test("origin, view and later-page lookup failures throw without a healthy or partial result", async () => {
	for (const failingStep of ["origin", "view", "graphql", "later-page"]) {
		const target = session();
		if (failingStep === "origin") Object.assign(target.workspace, { upstream: undefined });
		let pageNumber = 0;
		const failure = new Error(`lookup failed: ${failingStep}`);
		await assert.rejects(
			discoverPullRequestProblems(target, async (file, args) => {
				if (file === "git") throw failure;
				if (args[0] === "pr") {
					if (failingStep === "view") throw failure;
					return JSON.stringify(view([check("CI")], "CONFLICTING"));
				}
				if (failingStep === "graphql" || pageNumber++ > 0) throw failure;
				return JSON.stringify(page([thread("T")], true, "cursor"));
			}),
			(error) => error === failure,
		);
	}
	for (const command of ["pr", "api"])
		await assert.rejects(
			discoverPullRequestProblems(session(), async (_file, args) =>
				args[0] === command ? "not JSON" : JSON.stringify(view()),
			),
			SyntaxError,
		);
});

test("bounds UTF-8 output for every command, including supplied runners", async () => {
	for (const command of ["git", "pr", "api"]) {
		const target = session();
		if (command === "git") Object.assign(target.workspace, { upstream: undefined });
		await assert.rejects(
			discoverPullRequestProblems(target, async (file, args) => {
				if (file === command || args[0] === command) return "é".repeat(524_289);
				return JSON.stringify(view());
			}),
			/output exceeded 1 MiB/,
		);
	}
});

test("a total lookup deadline bounds slow pagination and shrinks command timeouts", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
	let pageNumber = 0;
	await assert.rejects(
		discoverPullRequestProblems(session(), async (_file, args, _cwd, timeout) => {
			if (args[0] === "pr") return JSON.stringify(view());
			if (pageNumber === 0) {
				assert.equal(timeout, 10_000);
				t.mock.timers.tick(55_000);
				pageNumber++;
				return JSON.stringify(page([thread("T")], true, "cursor"));
			}
			assert.equal(timeout, 5_000);
			t.mock.timers.tick(5_001);
			pageNumber++;
			return JSON.stringify(page([thread("T2")]));
		}),
		/timed out/,
	);
	assert.equal(pageNumber, 2);
});
