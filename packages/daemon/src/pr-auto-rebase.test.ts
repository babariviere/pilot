import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionPullRequest } from "@pilot/protocol";
import { type AutoRebaseHost, PullRequestAutoRebase } from "./pr-auto-rebase.ts";
import type { Runner } from "./workspaces.ts";

const pr: SessionPullRequest = {
	number: 1,
	url: "https://github.com/octo/repo/pull/1",
	title: "Feature",
	state: "open",
	branch: "feature",
	checkedAt: 1,
};
const host: AutoRebaseHost = {
	allowed: () => undefined,
	reserve: async () => true,
	ownedChanges: async () => ({ own: new Set<string>(), lower: new Set<string>() }),
	rebased: async () => assert.fail("must not push"),
};

test("rebase pool has two slots and no unbounded queue", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let entered = 0;
	const runner: Runner = async () => {
		entered++;
		await gate;
		throw new Error("stopped");
	};
	const service = new PullRequestAutoRebase(runner);
	const first = service.restack([pr], "/unused", "/upstream", host);
	const second = service.restack([pr], "/unused", "/upstream", host);
	try {
		const rejected = await service.restack([pr], "/unused", "/upstream", host);
		assert.deepEqual(rejected.get(pr.url), { skipped: "Automatic rebase capacity is busy" });
	} finally {
		release();
		await Promise.all([first, second]);
	}
	assert.equal(entered, 2);
});

test("unbound or busy PRs do not even create a trial repository", async () => {
	const service = new PullRequestAutoRebase(async () => assert.fail("must not run commands"));
	for (const reason of ["PR is not bound to this chat", "Chat is busy"]) {
		const result = await service.restack([pr], "/unused", "/upstream", { ...host, allowed: () => reason });
		assert.deepEqual(result.get(pr.url), { skipped: reason });
	}
});

for (const root of ["main", "release", "trunk"]) {
	test(`an advanced root base (${root}) does not consume admission or fetch a rebase trial`, async () => {
		const commands: string[][] = [];
		const service = new PullRequestAutoRebase(async (file, args) => {
			commands.push([file, ...args]);
			if (file !== "gh") return "";
			return JSON.stringify({
				data: {
					repository: {
						defaultBranchRef: { name: root === "trunk" ? "trunk" : "main" },
						pullRequest: {
							state: "OPEN",
							isCrossRepository: false,
							headRefName: "feature",
							headRefOid: "a".repeat(40),
							baseRefName: root,
							baseRefOid: "b".repeat(40),
						},
					},
				},
			});
		});
		const target = root === "trunk" ? pr : { ...pr, stack: { number: 1, size: 1, position: 1, baseBranch: root } };
		const result = await service.restack([target], "/unused", "/upstream", {
			...host,
			reserve: async () => assert.fail("root bases do not consume the rebase budget"),
			ownedChanges: async () => assert.fail("root bases do not need provenance lookup"),
		});
		assert.deepEqual(result.get(pr.url), { unchanged: true });
		assert.ok(!commands.some((args) => args.includes("fetch") || args.includes("rebase") || args.includes("push")));
	});
}

for (const scenario of ["default-head", "fork", "deleted-base"] as const) {
	test(`unsafe GitHub state: ${scenario} never pushes or retargets`, async () => {
		const commands: string[][] = [];
		const service = new PullRequestAutoRebase(async (file, args) => {
			commands.push([file, ...args]);
			if (file === "gh")
				return JSON.stringify({
					data: {
						repository: {
							defaultBranchRef: { name: scenario === "default-head" ? "feature" : "main" },
							pullRequest: {
								state: "OPEN",
								isCrossRepository: scenario === "fork",
								headRefName: "feature",
								headRefOid: "a".repeat(40),
								baseRefName: "deleted",
								baseRefOid: "b".repeat(40),
							},
						},
					},
				});
			if (args.includes("fetch")) throw new Error("Base branch was deleted");
			return "";
		});
		const result = await service.restack([pr], "/unused", "/upstream", host);
		assert.ok("skipped" in result.get(pr.url)!);
		assert.ok(!commands.some((args) => args.includes("push")));
		assert.ok(!commands.some((args) => args.includes("edit") || args.includes("PATCH")));
		if (scenario === "deleted-base")
			assert.ok(commands.some((args) => args.includes("+refs/heads/deleted:refs/heads/trial-base")));
	});
}
