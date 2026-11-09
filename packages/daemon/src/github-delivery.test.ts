import assert from "node:assert/strict";
import { test } from "node:test";
import type { NativeReviewSnapshot } from "@pilot/protocol";
import { RateLimits } from "./github.ts";
import { observeCodePullRequest, observeRetainedLanding } from "./github-delivery.ts";
import { PullRequestSync } from "./pull-request-sync.ts";
import type { Runner } from "./workspaces.ts";

const head = "a".repeat(40),
	base = "b".repeat(40),
	merge = "c".repeat(40),
	target = "d".repeat(40);
const url = "https://github.com/octo/repo/pull/1";
function retained(): NativeReviewSnapshot {
	return {
		snapshotId: "e".repeat(64),
		workerId: "worker",
		capturedAt: 1,
		enrollmentTaskIds: [],
		creation: { changeId: "k".repeat(32), commitId: head, operationId: "a".repeat(128), kind: "workspace-created" },
		status: "complete",
		omissions: [],
		before: [],
		after: [],
		changes: [],
		diff: { sha256: "f".repeat(64), bytes: 0 },
		request: {
			requestId: "capture",
			repositoryId: "b".repeat(64),
			changeId: "k".repeat(32),
			operationId: "a".repeat(128),
			base: { changeId: "l".repeat(32), commitId: base },
			head: { changeId: "k".repeat(32), commitId: head },
			scope: { kind: "layer" },
			source: "committed",
		},
	};
}
function variables(args: string[]) {
	return new Map(
		args
			.filter((_, i) => args[i - 1] === "-f" || args[i - 1] === "-F")
			.map((s) => {
				const [key, ...rest] = s.split("=");
				return [key!, rest.join("=")];
			}),
	);
}
function identity(state = "MERGED") {
	return {
		defaultBranchRef: { name: "main", target: { oid: target } },
		pullRequest: {
			number: 1,
			url,
			state,
			headRefOid: head,
			baseRefOid: base,
			baseRefName: "main",
			mergeCommit: state === "MERGED" ? { oid: merge } : null,
			baseRef: {
				branchProtectionRule: {
					requiresStatusChecks: true,
					requiresStrictStatusChecks: true,
					requiredStatusChecks: [{ context: "test", app: { databaseId: 1 } }],
				},
			},
		},
	};
}
function context(id = "run-1", conclusion: string | null = "SUCCESS") {
	return {
		__typename: "CheckRun",
		id,
		name: "test",
		status: "COMPLETED",
		conclusion,
		checkSuite: { app: { databaseId: 1 } },
	};
}
function checks(nodes: unknown[] = [context()], next = false, endCursor: string | null = null) {
	return { oid: head, statusCheckRollup: { contexts: { nodes, pageInfo: { hasNextPage: next, endCursor } } } };
}
function response(repository: unknown, remaining = 4000) {
	return JSON.stringify({ data: { rateLimit: { remaining, resetAt: "2100-01-01T00:00:00Z" }, repository } });
}
function directFixture() {
	const state = {
		reads: 0,
		compares: 0,
		moved: false,
		denied: false,
		wrongRepository: false,
		compared: { base_commit: { sha: head }, merge_base_commit: { sha: head }, status: "ahead" },
	};
	const runner: Runner = async (file, args, cwd) => {
		assert.equal(file, "gh");
		assert.equal(cwd, "/host/project");
		assert.ok(!args.some((a) => /mutation|checkout|fetch|push/.test(a)));
		if (state.denied) throw new Error("Denied");
		if (variables(args).has("query")) {
			state.reads++;
			return response({
				url: `https://github.com/octo/${state.wrongRepository ? "other" : "repo"}`,
				defaultBranchRef: { name: "trunk", target: { oid: state.moved && state.reads > 1 ? merge : target } },
			});
		}
		state.compares++;
		assert.ok(args.includes(`repos/octo/repo/compare/${head}...${target}?per_page=1`));
		assert.ok(args.includes("--hostname=github.com"));
		return JSON.stringify(state.compared);
	};
	return {
		state,
		runner,
		read: () =>
			observeRetainedLanding(
				retained(),
				"git@github.com:octo/repo.git",
				null,
				"/host/project",
				runner,
				new RateLimits(),
			),
	};
}

test("direct delivery observes exact default-branch containment, not a reported push", async () => {
	const f = directFixture(),
		r = await f.read();
	assert.equal(r.status, "observed");
	if (r.status !== "observed") return;
	assert.equal(r.repository, "github.com/octo/repo");
	assert.equal(r.defaultRef, "trunk");
	assert.equal(r.targetCommitId, target);
	assert.equal(r.integratedCommitId, head);
	assert.deepEqual(r.producer, { kind: "default-branch-containment" });
	assert.equal(f.state.reads, 2);
	assert.equal(f.state.compares, 1);
});

test("missing, moved, malformed and diverged upstream evidence cannot prove landing", async () => {
	for (const mode of ["denied", "moved", "wrongRepository", "wrongBase", "malformed", "diverged"] as const) {
		const f = directFixture();
		if (mode === "denied" || mode === "moved" || mode === "wrongRepository") f.state[mode] = true;
		if (mode === "wrongBase") f.state.compared.base_commit.sha = merge;
		if (mode === "malformed") f.state.compared.merge_base_commit.sha = "bad";
		if (mode === "diverged") {
			f.state.compared.status = "diverged";
			f.state.compared.merge_base_commit.sha = base;
		}
		assert.equal(
			(await f.read()).status,
			mode === "moved" ? "stale" : mode === "diverged" ? "not-contained" : "unknown",
			mode,
		);
	}
});

test("working-copy landing and cross-repository PRs make no network calls", async () => {
	const f = directFixture(),
		s = retained();
	s.request.source = "working-copy";
	assert.equal(
		(
			await observeRetainedLanding(
				s,
				"git@github.com:octo/repo.git",
				null,
				"/host/project",
				f.runner,
				new RateLimits(),
			)
		).status,
		"unknown",
	);
	s.request.source = "committed";
	assert.equal(
		(
			await observeRetainedLanding(
				s,
				"git@github.com:octo/other.git",
				url,
				"/host/project",
				f.runner,
				new RateLimits(),
			)
		).status,
		"unknown",
	);
	assert.equal(f.state.reads, 0);
	assert.equal(f.state.compares, 0);
});

test("PR landing requires exact pair, fresh merged identity and default-target containment", async () => {
	for (const mode of [
		"merged",
		"proposed",
		"closed",
		"rewritten",
		"retargeted",
		"notContained",
		"checksUnavailable",
	] as const) {
		const f = fixture();
		if (mode === "proposed") f.state.pr = identity("OPEN");
		if (mode === "closed") f.state.pr = identity("CLOSED");
		if (mode === "rewritten") f.state.pr.pullRequest.headRefOid = merge;
		if (mode === "retargeted") f.state.pr.pullRequest.baseRefOid = target;
		if (mode === "notContained") f.state.compared.status = "diverged";
		if (mode === "checksUnavailable")
			f.state.hook = (args) =>
				variables(args).get("query")?.includes("object(expression:")
					? response({ ...f.state.pr, object: null })
					: undefined;
		const result = await observeRetainedLanding(
			retained(),
			"git@github.com:octo/repo.git",
			url,
			"/host/project",
			f.runner,
			new RateLimits(),
		);
		assert.equal(
			result.status,
			mode === "merged" || mode === "checksUnavailable"
				? "observed"
				: mode === "notContained"
					? "not-contained"
					: "unknown",
			mode,
		);
		if (result.status === "observed") {
			assert.equal(result.integratedCommitId, merge);
			assert.deepEqual(result.producer, { kind: "pull-request", url, headCommitId: head, baseCommitId: base });
		}
	}
});

function fixture() {
	const calls: string[][] = [];
	let identities = 0,
		pages = 0;
	const state = {
		pr: identity(),
		page: checks(),
		compared: { base_commit: { sha: merge }, merge_base_commit: { sha: merge }, status: "ahead" },
		hook: undefined as ((args: string[], page: number, identity: number) => string | undefined) | undefined,
	};
	const runner: Runner = async (file, args, cwd) => {
		assert.equal(file, "gh");
		assert.equal(cwd, "/host/project");
		calls.push(args);
		assert.ok(!args.some((a) => /mutation|merge --|checkout/.test(a)));
		const vars = variables(args),
			query = vars.get("query") ?? "";
		if (query.includes("object(expression:")) pages++;
		else if (query) identities++;
		const override = state.hook?.(args, pages, identities);
		if (override !== undefined) return override;
		if (!query) return JSON.stringify(state.compared);
		if (query.includes("object(expression:")) {
			assert.equal(vars.get("revision"), head);
			assert.equal(vars.get("number"), "1");
			return response({ ...state.pr, object: state.page });
		}
		return response(state.pr);
	};
	return { state, calls, runner, read: () => observeCodePullRequest(url, "/host/project", runner, new RateLimits()) };
}

test("exact PR/head contexts/configuration and default-target containment are separate observations", async () => {
	const f = fixture(),
		result = await f.read();
	assert.equal(result.status, "observed");
	if (result.status !== "observed") return;
	assert.deepEqual(result.identity, {
		url,
		repository: "github.com/octo/repo",
		number: 1,
		state: "MERGED",
		head,
		base,
		baseRef: "main",
		merge,
		defaultRef: "main",
		target,
	});
	assert.equal(result.checks.status, "observed");
	if (result.checks.status === "observed") {
		assert.equal(result.checks.revision, head);
		assert.equal(result.checks.contexts.length, 1);
		assert.match(result.checks.configurationSha256, /^[a-f0-9]{64}$/);
	}
	assert.equal(result.configuredChecks.status, "unknown", "green contexts are not complete configured checks");
	assert.deepEqual(result.integration, {
		status: "observed",
		reason: "Exact merge commit is contained in the observed default-branch revision",
		revision: merge,
		target,
	});
	assert.ok(f.calls.some((args) => args.includes(`repos/octo/repo/compare/${merge}...${target}?per_page=1`)));
	assert.equal(f.calls.length, 4, "one bounded on-demand observation, no polling/retry");
});

test("full bounded check pagination includes later failures and status contexts", async () => {
	const f = fixture();
	f.state.page = checks([context()], true, "page-2");
	f.state.hook = (args, page) => {
		if (!variables(args).get("query")?.includes("object(expression:") || page !== 2) return;
		assert.equal(variables(args).get("cursor"), "page-2");
		return response({
			...f.state.pr,
			object: checks([
				context("failed", "FAILURE"),
				{ __typename: "StatusContext", id: "status", context: "lint", state: "PENDING" },
			]),
		});
	};
	const r = await f.read();
	assert.equal(r.status, "observed");
	if (r.status !== "observed") return;
	assert.equal(r.checks.status, "observed");
	if (r.checks.status !== "observed") return;
	assert.deepEqual(
		r.checks.contexts.map((c) => [c.name, c.state, c.conclusion]),
		[
			["test", "COMPLETED", "SUCCESS"],
			["test", "COMPLETED", "FAILURE"],
			["lint", "PENDING", null],
		],
	);
	assert.equal(r.configuredChecks.status, "unknown");
});

test("missing, partial, duplicate and lost check pages never yield complete check observations", async (t) => {
	for (const kind of ["missing", "partial", "duplicate", "lost", "wrong-head", "limit", "cursor"] as const)
		await t.test(kind, async () => {
			const f = fixture();
			f.state.hook = (args, page) => {
				if (!variables(args).get("query")?.includes("object(expression:")) return;
				if (kind === "missing") return response({ ...f.state.pr, object: { oid: head, statusCheckRollup: null } });
				if (kind === "partial")
					return JSON.stringify({
						data: { repository: { object: checks() } },
						errors: [{ message: "permission denied" }],
					});
				if (kind === "lost") throw new Error("connection lost");
				if (kind === "wrong-head") return response({ ...f.state.pr, object: { ...checks(), oid: target } });
				if (kind === "duplicate") return response({ ...f.state.pr, object: checks([context(), context()]) });
				return response({
					...f.state.pr,
					object: checks([context(`run-${page}`)], true, kind === "cursor" ? "same" : `next-${page}`),
				});
			};
			const r = await f.read();
			assert.equal(r.status, "observed");
			if (r.status !== "observed") return;
			assert.equal(r.checks.status, "unknown");
			assert.equal(
				r.integration.status,
				"observed",
				"PR/landing observation is independent from check availability",
			);
			assert.ok(f.calls.length <= 13);
		});
});

test("PR, target and configuration churn invalidates exact observations", async (t) => {
	for (const kind of ["head", "base", "merge", "state", "target", "configuration"] as const)
		await t.test(kind, async () => {
			const f = fixture();
			f.state.hook = (args, _page, reads) => {
				if (!variables(args).get("query") || reads !== 2) return;
				const changed = structuredClone(f.state.pr);
				if (kind === "head") changed.pullRequest.headRefOid = target;
				if (kind === "base") changed.pullRequest.baseRefOid = target;
				if (kind === "merge") changed.pullRequest.mergeCommit = { oid: target };
				if (kind === "state") changed.pullRequest.state = "OPEN";
				if (kind === "target") changed.defaultBranchRef.target.oid = head;
				if (kind === "configuration")
					changed.pullRequest.baseRef.branchProtectionRule.requiresStrictStatusChecks = false;
				return response(changed);
			};
			assert.equal((await f.read()).status, "stale");
		});
});

test("terminal and stacked PRs require exact default-target containment, not a merged label", async (t) => {
	for (const state of ["OPEN", "CLOSED", "MERGED"])
		await t.test(state, async () => {
			const f = fixture();
			f.state.pr = identity(state);
			f.state.pr.pullRequest.baseRefName = "stack/lower";
			f.state.compared.merge_base_commit.sha = base;
			f.state.compared.status = "diverged";
			const r = await f.read();
			assert.equal(r.status, "observed");
			if (r.status !== "observed") return;
			assert.equal(r.integration.status, "not-integrated");
		});
	const f = fixture();
	f.state.hook = (args) => {
		if (!variables(args).get("query")) throw new Error("403");
	};
	const r = await f.read();
	assert.equal(r.status, "observed");
	if (r.status === "observed") assert.equal(r.integration.status, "unknown");
});

test("identity permission failures, missing PRs, wrong subjects and lost responses stay Unknown", async (t) => {
	for (const kind of ["403", "lost", "null", "wrong", "partial"])
		await t.test(kind, async () => {
			const f = fixture();
			f.state.hook = () => {
				if (kind === "403" || kind === "lost") throw new Error(kind);
				if (kind === "null") return response({ ...identity(), pullRequest: null });
				if (kind === "partial")
					return JSON.stringify({ errors: [{ message: "denied" }], data: { repository: identity() } });
				return response({ ...identity(), pullRequest: { ...identity().pullRequest, number: 2 } });
			};
			assert.equal((await f.read()).status, "unknown");
			assert.equal(f.calls.length, 1);
		});
});

test("delivery reads share and respect the host GitHub rate budget", async () => {
	const f = fixture(),
		limits = new RateLimits();
	limits.observe("github.com", { remaining: 1, resetAt: "2100-01-01T00:00:00Z" });
	assert.equal((await observeCodePullRequest(url, "/host/project", f.runner, limits)).status, "unknown");
	assert.equal(f.calls.length, 0);
	f.state.hook = () => response(identity(), 1);
	const shared = new RateLimits();
	const r = await observeCodePullRequest(url, "/host/project", f.runner, shared);
	assert.equal(r.status, "unknown", "budget exhausted after first response blocks subsequent reads");
	assert.ok(shared.blockedUntil("github.com") > Date.now());
	assert.equal(f.calls.length, 1);
});

test("one-shot sync adapter shares its existing budget without scheduler admission or follow-ups", async () => {
	const f = fixture();
	f.state.hook = () => response(identity(), 1);
	const sync = new PullRequestSync(
		{
			sessions: () => [],
			session: () => undefined,
			apply: async () => assert.fail("No cached state or follow-up mutation"),
		},
		{ runner: f.runner },
	);
	assert.equal((await sync.observeCodeDelivery(url, "/host/project")).status, "unknown");
	assert.equal(f.calls.length, 1);
	assert.equal((await sync.observeCodeDelivery(url, "/host/project")).status, "unknown");
	assert.equal(f.calls.length, 1, "same rate-limit instance blocks a second one-shot read");
	await sync.stop();
});
