import assert from "node:assert/strict";
import { test } from "node:test";
import { createPilotTool } from "../../kernel/src/pilot-tool.ts";
import { ControlPilot } from "./control-pilot.ts";
import { pullRequestChecks } from "./control-pr-checks.ts";
import type { Runner } from "./workspaces.ts";

const head = "a".repeat(40);
const olderHead = "b".repeat(40);
const url = "https://github.com/octo/repo/pull/42";

function check(name: string, status = "COMPLETED", conclusion: string | null = "SUCCESS", headSha = head, index = 1) {
	return {
		__typename: "CheckRun",
		databaseId: index,
		name,
		status,
		conclusion,
		detailsUrl: `https://github.com/octo/repo/actions/runs/${index}`,
		checkSuite: { headSha },
	};
}

function response(
	checks: unknown[] | null = [],
	options: { headSha?: string; commitSha?: string; hasNextPage?: boolean; endCursor?: string | null } = {},
) {
	const oid = options.headSha ?? head;
	return {
		data: {
			repository: {
				pullRequest: {
					headRefOid: oid,
					commits: {
						nodes: [
							{
								commit: {
									oid: options.commitSha ?? oid,
									statusCheckRollup:
										checks === null
											? null
											: {
													contexts: {
														nodes: checks,
														pageInfo: {
															hasNextPage: options.hasNextPage ?? false,
															endCursor: options.endCursor ?? null,
														},
													},
												},
								},
							},
						],
					},
				},
			},
		},
	};
}

function runner(responses: unknown[], inspect?: (args: string[]) => void): Runner {
	let index = 0;
	return async (file, args, cwd, timeout) => {
		assert.equal(file, "gh");
		assert.ok(cwd.length > 0);
		assert.equal(timeout, 10_000);
		inspect?.(args);
		const item = responses[index++];
		assert.notEqual(item, undefined, "unexpected extra GraphQL request");
		return JSON.stringify(item);
	};
}

test("checks are read with GraphQL and only current-head runs are returned by default", async () => {
	const result = await pullRequestChecks(
		url,
		false,
		runner([response([check("build"), check("old build", "COMPLETED", "SUCCESS", olderHead, 2)])], (args) => {
			assert.deepEqual(args.slice(0, 3), ["api", "graphql", "--hostname=github.com"]);
			assert.ok(args.includes("owner=octo"));
			assert.ok(args.includes("name=repo"));
			assert.ok(args.includes("number=42"));
			const query = args.find((arg) => arg.startsWith("query="))!;
			assert.match(query, /headRefOid/);
			assert.match(query, /checkSuite \{ headSha \}/);
			assert.doesNotMatch(query, /mutation/);
		}),
	);
	assert.deepEqual(result, {
		untrusted: true,
		headSha: head,
		checks: [
			{
				name: "build",
				status: "COMPLETED",
				conclusion: "SUCCESS",
				runId: 1,
				url: "https://github.com/octo/repo/actions/runs/1",
			},
		],
		truncated: false,
	});
});

test("pending and failed check runs preserve status and conclusion", async () => {
	const result = await pullRequestChecks(
		url,
		false,
		runner([
			response([check("running", "IN_PROGRESS", null, head, 1), check("tests", "COMPLETED", "FAILURE", head, 2)]),
		]),
	);
	assert.deepEqual(
		result.checks.map(({ name, status, conclusion }) => ({ name, status, conclusion })),
		[
			{ name: "running", status: "IN_PROGRESS", conclusion: null },
			{ name: "tests", status: "COMPLETED", conclusion: "FAILURE" },
		],
	);
});

test("missing checks return the current head with an empty check list", async () => {
	for (const missing of [response(null), response([])]) {
		const result = await pullRequestChecks(url, false, runner([missing]));
		assert.equal(result.headSha, head);
		assert.deepEqual(result.checks, []);
		assert.equal(result.truncated, false);
	}
});

test("a head change during pagination fails rather than mixing runs from two commits", async () => {
	await assert.rejects(
		pullRequestChecks(
			url,
			false,
			runner([response([], { hasNextPage: true, endCursor: "next" }), response([], { headSha: olderHead })]),
		),
		/Pull request head changed/,
	);
});

test("stale runs are optionally returned with their old head SHA and a stale label", async () => {
	const result = await pullRequestChecks(
		url,
		true,
		runner([response([check("old", "COMPLETED", "FAILURE", olderHead)])]),
	);
	assert.deepEqual(result.checks, [
		{
			name: "old",
			status: "COMPLETED",
			conclusion: "FAILURE",
			runId: 1,
			url: "https://github.com/octo/repo/actions/runs/1",
			stale: true,
			headSha: olderHead,
		},
	]);
});

test("check output is capped and reports truncation", async () => {
	const runs = Array.from({ length: 30 }, (_, index) =>
		check(`check ${index}`, "COMPLETED", "SUCCESS", head, index + 1),
	);
	const result = await pullRequestChecks(url, false, runner([response(runs)]));
	assert.equal(result.checks.length, 20);
	assert.equal(result.truncated, true);
	assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") < 24_000);
});

test("invalid pull request URLs are rejected before running gh", async () => {
	for (const invalid of [
		"https://github.com/octo/repo/issues/42",
		"https://attacker@example.com/octo/repo/pull/42",
		"http://github.com/octo/repo/pull/42",
	]) {
		await assert.rejects(pullRequestChecks(invalid, false, runner([])), /pull request URL/);
	}
});

test("pilot checks action is control-only and forwards the requested stale option", async () => {
	const calls: Array<[string, boolean]> = [];
	const pilot = new ControlPilot({
		isControl: (id) => id === "control",
		sessions: { list: () => [], get: () => undefined, history: async () => ({ entries: [], more: false }) } as never,
		projects: () => [],
		missions: () => [],
		linear: () => [],
		checks: async (pr, includeStale) => {
			calls.push([pr, includeStale]);
			return { headSha: head };
		},
	});
	assert.deepEqual(await pilot.call("control", "checks", { pr: url, includeStale: true }), { headSha: head });
	assert.deepEqual(calls, [[url, true]]);
	await assert.rejects(pilot.call("other", "checks", { pr: url }), /Only the control chat/);
	await assert.rejects(pilot.call("control", "checks", { pr: url, includeStale: "yes" }), /includeStale/);
	const toolCalls: unknown[] = [];
	const tool = createPilotTool(async (action, args) => {
		toolCalls.push([action, args]);
		return { headSha: head };
	});
	await tool.execute(
		"check-call",
		{ action: "checks", pr: url, includeStale: true },
		undefined,
		undefined,
		{} as never,
	);
	assert.deepEqual(toolCalls, [["checks", { pr: url, includeStale: true }]]);
});
