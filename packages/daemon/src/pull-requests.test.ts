import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { discoverPullRequest, githubRepository, type PullRequestSession, PullRequestTracker } from "./pull-requests.ts";
import type { Runner } from "./workspaces.ts";

const branch = "pilot/test-123";
const session = (): PullRequestSession => ({
	id: "session",
	cwd: "/private/clone",
	workspace: { branch, upstream: "git@github.com:octo/repo.git" },
});

function candidate(overrides: Record<string, unknown> = {}) {
	const number = overrides.number ?? 1;
	return {
		number,
		url: `https://github.com/octo/repo/pull/${number}`,
		title: "A pull request",
		state: "OPEN",
		isDraft: false,
		headRefName: branch,
		isCrossRepository: false,
		createdAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

const listing =
	(rows: ReturnType<typeof candidate>[]): Runner =>
	async (file, args) => {
		assert.equal(file, "gh");
		return JSON.stringify(args.includes("--state=open") ? rows.filter((row) => row.state === "OPEN") : rows);
	};

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function until(predicate: () => boolean) {
	for (let i = 0; i < 200 && !predicate(); i++) await delay(5);
	assert.ok(predicate(), "condition did not settle");
}

test("normalizes HTTPS, SSH and enterprise origins, rejecting local paths and option-like identities", () => {
	for (const remote of [
		"https://github.com/octo/repo.git",
		"git@github.com:octo/repo.git",
		"ssh://git@github.com/octo/repo",
		"https://github.com/octo/repo/",
	])
		assert.equal(githubRepository(remote).identity, "github.com/octo/repo");
	assert.equal(
		githubRepository("ssh://git@github.example.com/team/repo.git").identity,
		"github.example.com/team/repo",
	);
	for (const remote of [
		"/local/repo",
		"file:///local/repo",
		"--repo=evil",
		"https://github.com/-owner/repo",
		"git@github.com:owner/--repo",
		"https://github.com/owner/repo?foo=bar",
		"https://github.com/owner/repo/extra",
	])
		assert.throws(() => githubRepository(remote));
});

test("discovers all four authoritative states, terminal state takes precedence over isDraft", async () => {
	for (const [state, isDraft, expected] of [
		["OPEN", false, "open"],
		["OPEN", true, "draft"],
		["MERGED", true, "merged"],
		["CLOSED", true, "closed"],
	] as const) {
		const before = Date.now();
		const result = await discoverPullRequest(session(), listing([candidate({ state, isDraft })]));
		assert.equal(result.error, undefined);
		assert.equal(result.pullRequest?.state, expected);
		assert.equal(result.pullRequest?.number, 1);
		assert.equal(result.pullRequest?.title, "A pull request");
		assert.ok(result.pullRequest!.checkedAt >= before);
	}
});

test("uses recorded upstream, exact branch and repo flags with timeouts, never resolving local HEAD", async () => {
	const calls: { file: string; args: string[]; cwd: string; timeout?: number }[] = [];
	const target = session();
	target.workspace!.branch = "pilot/a;$(whoami)";
	const result = await discoverPullRequest(target, async (file, args, cwd, timeout) => {
		calls.push({ file, args, cwd, timeout });
		assert.equal(file, "gh", "recorded upstream avoids a potentially changed origin");
		return JSON.stringify([candidate({ headRefName: target.workspace!.branch })]);
	});
	assert.equal(result.pullRequest?.state, "open");
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0], {
		file: "gh",
		cwd: "/private/clone",
		timeout: 10_000,
		args: [
			"pr",
			"list",
			"--head=pilot/a;$(whoami)",
			"--repo=github.com/octo/repo",
			"--state=open",
			"--limit=100",
			"--json=number,url,title,state,isDraft,headRefName,isCrossRepository,createdAt",
		],
	});
});

test("only legacy private workspaces read origin, direct sessions never run git or gh", async () => {
	let calls = 0;
	const target = session();
	delete target.workspace!.upstream;
	const runner: Runner = async (file, args, cwd, timeout) => {
		calls++;
		assert.equal(cwd, target.cwd);
		assert.equal(timeout, 10_000);
		if (file === "git") {
			assert.deepEqual(args, ["remote", "get-url", "origin"]);
			return "https://github.com/octo/repo.git";
		}
		assert.ok(args.includes("--repo=github.com/octo/repo"));
		return JSON.stringify([candidate()]);
	};
	assert.equal((await discoverPullRequest(target, runner)).pullRequest?.number, 1);
	assert.equal(calls, 2);
	delete target.workspace;
	assert.deepEqual(await discoverPullRequest(target, runner), {});
	assert.equal(calls, 2);
});

test("prefers newest matching open/draft over history and excludes wrong branch or same-named forks", async () => {
	const result = await discoverPullRequest(
		session(),
		listing([
			candidate({ number: 80, state: "MERGED", createdAt: "2026-03-01T00:00:00Z" }),
			candidate({ number: 50, isDraft: true, createdAt: "2026-02-01T00:00:00Z" }),
			candidate({ number: 60, createdAt: "2026-03-01T00:00:00Z", headRefName: "other/branch" }),
			candidate({ number: 70, createdAt: "2026-03-01T00:00:00Z", isCrossRepository: true }),
			candidate(),
		]),
	);
	assert.equal(result.pullRequest?.number, 50);
	assert.equal(result.pullRequest?.state, "draft");
});

test("historical fallback selects newest closed/merged, without needing a surviving branch ref", async () => {
	const calls: string[][] = [];
	const runner = listing([
		candidate({ number: 5, state: "MERGED", createdAt: "2026-03-01T00:00:00Z" }),
		candidate({ number: 4, state: "CLOSED", createdAt: "2026-03-01T00:00:00Z" }),
		candidate({ number: 8, state: "CLOSED", createdAt: "2026-02-01T00:00:00Z" }),
	]);
	const result = await discoverPullRequest(session(), async (file, args, cwd, timeout) => {
		calls.push(args);
		return runner(file, args, cwd, timeout);
	});
	assert.equal(result.pullRequest?.number, 5);
	assert.equal(result.pullRequest?.state, "merged");
	assert.equal(calls.length, 2);
	assert.ok(calls[0]!.includes("--state=open"));
	assert.ok(calls[1]!.includes("--state=all"));
});

test("an active PR wins even when the historical query could be truncated", async () => {
	const result = await discoverPullRequest(session(), async (_file, args) => {
		assert.ok(args.includes("--state=open"), "must not query truncated history if active PR exists");
		return JSON.stringify([candidate()]);
	});
	assert.equal(result.pullRequest?.state, "open");
});

test("lookup errors and malformed results are stale signals, not mutations", async () => {
	const target = session();
	target.pullRequest = {
		number: 1,
		url: "https://github.com/octo/repo/pull/1",
		title: "Known",
		state: "open",
		checkedAt: 5,
	};
	const previous = structuredClone(target);
	const runners: Runner[] = [
		async () => {
			throw new Error("gh ENOENT");
		},
		async () => {
			throw new Error("authentication required");
		},
		async () => {
			throw new Error("command timed out");
		},
		async () => "invalid JSON",
		async () => "{}",
		async () => JSON.stringify([candidate({ state: "UNKNOWN" })]),
		async () => JSON.stringify([candidate({ url: "https://github.com/foreign/repo/pull/1" })]),
	];
	for (const runner of runners) {
		const result = await discoverPullRequest(target, runner);
		assert.match(result.error!, /^Pull request lookup failed:/);
		assert.equal(result.pullRequest, undefined);
		assert.deepEqual(target, previous);
	}
	const result = await discoverPullRequest(target, listing([]));
	assert.match(result.error!, /keeping last known status/);
	assert.deepEqual(target, previous);
	delete target.pullRequest;
	assert.deepEqual(await discoverPullRequest(target, listing([])), {});
});

test("invalid branches and upstream identities cannot become command options", async () => {
	for (const invalid of ["--repo=evil", "", "branch with spaces", "branch\n--repo=evil"])
		assert.match(
			(
				await discoverPullRequest(
					{ ...session(), workspace: { branch: invalid, upstream: "git@github.com:octo/repo.git" } },
					async () => {
						throw new Error("must not execute");
					},
				)
			).error!,
			/Invalid workspace branch/,
		);
	assert.match(
		(
			await discoverPullRequest({ ...session(), workspace: { branch, upstream: "--repo=evil" } }, async () => {
				throw new Error("must not execute");
			})
		).error!,
		/not a GitHub repository URL/,
	);
});

test("tracker deduplicates overlapping per-session requests and executes sessions serially", async () => {
	const first = gate();
	let active = 0;
	let maxActive = 0;
	const called: string[] = [];
	const applied: string[] = [];
	const tracker = new PullRequestTracker(
		() => [],
		async (target) => {
			applied.push(target.id);
		},
		{
			runner: async (_file, _args, cwd) => {
				active++;
				maxActive = Math.max(maxActive, active);
				called.push(cwd);
				if (called.length === 1) await first.promise;
				active--;
				return JSON.stringify([candidate()]);
			},
		},
	);
	try {
		const target = session();
		const a = tracker.refresh(target);
		assert.equal(tracker.refresh(target), a);
		const b = tracker.refresh({ ...session(), id: "second", cwd: "/second" });
		await until(() => called.length === 1);
		assert.equal(called.length, 1);
		first.resolve();
		await Promise.all([a, b]);
		assert.equal(maxActive, 1);
		assert.deepEqual(called, ["/private/clone", "/second"]);
		assert.deepEqual(applied, ["session", "second"]);
	} finally {
		first.resolve();
		await tracker.stop();
	}
});

test("polls immediately then at bounded delay without overlapping sweeps, and stops its timer", async () => {
	const first = gate();
	let calls = 0;
	const tracker = new PullRequestTracker(
		() => [session(), { id: "direct", cwd: "/shared" }],
		async () => {},
		{
			intervalMs: 10,
			runner: async () => {
				calls++;
				if (calls === 1) await first.promise;
				return JSON.stringify([candidate()]);
			},
		},
	);
	try {
		tracker.start();
		tracker.start();
		await until(() => calls === 1);
		await delay(30);
		assert.equal(calls, 1, "long commands must not overlap polling");
		first.resolve();
		await until(() => calls >= 2);
		await tracker.stop();
		const stoppedCalls = calls;
		await delay(30);
		assert.equal(calls, stoppedCalls);
		await tracker.refresh(session());
		assert.equal(calls, stoppedCalls);
	} finally {
		first.resolve();
		await tracker.stop();
	}
});

test("shutdown drains the in-flight lookup and cache update but skips queued sessions", async () => {
	const lookup = gate();
	const cache = gate();
	let calls = 0;
	let applied = false;
	const tracker = new PullRequestTracker(
		() => [],
		async () => {
			applied = true;
			await cache.promise;
		},
		{
			runner: async () => {
				calls++;
				await lookup.promise;
				return JSON.stringify([candidate()]);
			},
		},
	);
	const active = tracker.refresh(session());
	const queued = tracker.refresh({ ...session(), id: "second" });
	await until(() => calls === 1);
	let stopped = false;
	const stopping = tracker.stop().then(() => {
		stopped = true;
	});
	lookup.resolve();
	await until(() => applied);
	assert.equal(stopped, false, "must drain the metadata callback as well as gh");
	cache.resolve();
	await Promise.all([active, queued, stopping]);
	assert.equal(calls, 1);
	assert.equal(stopped, true);
});
