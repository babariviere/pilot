// biome-ignore-all lint/complexity/useLiteralKeys: Exercise the scheduler's private batch application.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { SessionPullRequest } from "@pilot/protocol";
import { PullRequestSync, type PullRequestSyncHost } from "./pull-request-sync.ts";
import type { LinkedPullRequest, PullRequestSession } from "./pull-requests.ts";
import { legacyGitHub } from "./testing/legacy-github.ts";
import type { Runner } from "./workspaces.ts";

interface Row {
	number: number;
	url: string;
	title: string;
	state: "OPEN" | "MERGED" | "CLOSED";
	isDraft: boolean;
	headRefName: string;
	isCrossRepository: boolean;
	createdAt: string;
	mergedAt: string | null;
	commits?: unknown;
}

function row(repo: string, number: number, head: string, overrides: Partial<Row> & { checks?: string } = {}): Row {
	const { checks, ...rest } = overrides;
	return {
		number,
		url: `https://github.com/octo/${repo}/pull/${number}`,
		title: "PR",
		state: "OPEN",
		isDraft: false,
		headRefName: head,
		isCrossRepository: false,
		createdAt: "2026-01-01T00:00:00Z",
		mergedAt: rest.state === "MERGED" ? "2026-01-02T00:00:00Z" : null,
		...(checks ? { commits: { nodes: [{ commit: { statusCheckRollup: { state: checks } } }] } } : {}),
		...rest,
	};
}

/** GitHub described per repository and head, served through the real batched queries. */
class FakeGitHub {
	/** "repo/head" to rows. */
	readonly heads = new Map<string, Row[]>();
	/** "repo#number" to row, or an error. */
	readonly numbers = new Map<string, Row | Error>();
	/** "repo#number" to failing check names. */
	readonly failing = new Map<string, string[]>();
	/** Every gh process: one GraphQL request each. */
	readonly calls: { repo: string; query: string; variables: string[] }[] = [];
	gate?: Promise<void>;
	active = 0;
	maxActive = 0;
	error?: Error;
	rateLimit = { remaining: 4_000, resetAt: "2100-01-01T00:00:00Z" };

	readonly runner: Runner = async (file, args, ...rest) => {
		if (file === "git") return "";
		const values = args.filter((_, i) => args[i - 1] === "-f" || args[i - 1] === "-F");
		const repo = values.find((value) => value.startsWith("name="))!.slice("name=".length);
		this.calls.push({ repo, query: values[0]!.slice("query=".length).split("(")[0]!, variables: values.slice(3) });
		this.maxActive = Math.max(this.maxActive, ++this.active);
		try {
			await this.gate;
			if (this.error) throw this.error;
			const response = JSON.parse(await this.legacy(file, args, ...rest));
			response.data.rateLimit = this.rateLimit;
			return JSON.stringify(response);
		} finally {
			this.active--;
		}
	};

	private readonly legacy = legacyGitHub(async (_file, args) => {
		const repo = args
			.find((arg) => arg.startsWith("--repo="))
			?.split("/")
			.at(-1);
		if (args[0] === "pr" && args[1] === "list") {
			const head = args.find((arg) => arg.startsWith("--head="))!.slice("--head=".length);
			const rows = this.heads.get(`${repo}/${head}`) ?? [];
			return JSON.stringify(args.includes("--state=open") ? rows.filter((pr) => pr.state === "OPEN") : rows);
		}
		if (args[0] === "pr" && args[1] === "view") {
			const key = `${repo}#${args[2]}`;
			if (args.some((arg) => arg.includes("statusCheckRollup"))) {
				const pr = [...this.heads.values()]
					.flat()
					.find((candidate) => candidate.url.endsWith(`/${repo}/pull/${args[2]}`));
				return JSON.stringify({
					state: pr?.state ?? "OPEN",
					headRefName: pr?.headRefName,
					mergeable: "MERGEABLE",
					statusCheckRollup: (this.failing.get(key) ?? []).map((name) => ({
						__typename: "CheckRun",
						name,
						status: "COMPLETED",
						conclusion: "FAILURE",
					})),
				});
			}
			const pr = this.numbers.get(key);
			if (pr instanceof Error) throw pr;
			return JSON.stringify(pr);
		}
		// Review threads.
		return JSON.stringify({
			data: {
				repository: {
					pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
				},
			},
		});
	});
}

function session(id: string, repo: string, extra: Partial<PullRequestSession> = {}): PullRequestSession {
	return {
		id,
		cwd: `/sessions/${id}`,
		updatedAt: Date.now(),
		workspace: { branch: `feat/${id}`, upstream: `git@github.com:octo/${repo}.git` },
		...extra,
	};
}

function host(
	sessions: PullRequestSession[],
	extra: Partial<PullRequestSyncHost<PullRequestSession, string>> = {},
): PullRequestSyncHost<PullRequestSession, string> & { applied: string[] } {
	const applied: string[] = [];
	return {
		applied,
		sessions: () => sessions,
		session: (id) => sessions.find((candidate) => candidate.id === id),
		apply: async (target, result) => {
			applied.push(target.id);
			if (result.pullRequest) target.pullRequest = result.pullRequest;
			if (result.others) target.previousPullRequests = result.others;
		},
		...extra,
	};
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function until(check: () => boolean) {
	for (let i = 0; i < 400 && !check(); i++) await delay(2);
	assert.ok(check(), "condition did not settle");
}

test("one GitHub request per repository per round, with a bounded number of concurrent jobs", async () => {
	const github = new FakeGitHub();
	const sessions = [
		...["a1", "a2", "a3"].map((id) => session(id, "a")),
		...["b1", "b2"].map((id) => session(id, "b")),
		session("c1", "c"),
	];
	for (const target of sessions) {
		const repo = target.workspace!.upstream!.split("/")[1]!.replace(".git", "");
		github.heads.set(`${repo}/${target.workspace!.branch}`, [
			row(repo, Number(target.id.slice(1)), target.workspace!.branch!),
		]);
	}
	const gate = deferred();
	github.gate = gate.promise;
	const sync = new PullRequestSync(host(sessions), { runner: github.runner, concurrency: 2 });
	try {
		sync.start();
		await until(() => github.active === 2);
		await delay(10);
		assert.equal(github.active, 2, "a third repository waits for a free job");
		gate.resolve();
		await sync.settled();
		assert.equal(github.maxActive, 2);
		assert.deepEqual(github.calls.map((call) => call.repo).sort(), ["a", "b", "c"]);
		const a = github.calls.find((call) => call.repo === "a")!;
		assert.equal(a.variables.filter((value) => value.startsWith("h")).length, 3, "three sessions, one request");
		for (const target of sessions) assert.equal(target.pullRequest?.state, "open", target.id);
	} finally {
		gate.resolve();
		await sync.stop();
	}
});

test("an explicit refresh runs before background work that was due earlier", async () => {
	const github = new FakeGitHub();
	const sessions = ["a", "b", "c"].map((repo) => session(repo, repo));
	const gate = deferred();
	github.gate = gate.promise;
	const sync = new PullRequestSync(host(sessions), { runner: github.runner, concurrency: 1 });
	try {
		sync.start();
		await until(() => github.calls.length === 1);
		assert.equal(github.calls[0]!.repo, "a");
		const refreshed = sync.refresh(sessions[2]!);
		gate.resolve();
		await refreshed;
		assert.deepEqual(
			github.calls.map((call) => call.repo),
			["a", "c"],
			"the urgent session jumps the background queue",
		);
		await sync.settled();
		assert.deepEqual(
			github.calls.map((call) => call.repo),
			["a", "c", "b"],
		);
	} finally {
		gate.resolve();
		await sync.stop();
	}
});

test("refreshes deduplicate while queued, and a refresh during a check runs once more afterwards", async () => {
	const github = new FakeGitHub();
	const target = session("a", "a");
	const gate = deferred();
	github.gate = gate.promise;
	const sync = new PullRequestSync(host([target]), { runner: github.runner });
	try {
		const first = sync.refresh(target);
		assert.equal(sync.refresh(target), first, "queued requests share one run");
		await until(() => github.calls.length === 1);
		const second = sync.refresh(target);
		assert.notEqual(second, first, "a request during the run is not satisfied by its stale lookup");
		gate.resolve();
		await first;
		await second;
		assert.equal(github.calls.length, 2);
	} finally {
		gate.resolve();
		await sync.stop();
	}
});

test("cadence adapts to PR state: pending checks fast, settled never, idle sessions without a PR rarely", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
	const github = new FakeGitHub();
	const day = 24 * 60 * 60_000;
	const sessions = [
		session("pending", "pending"),
		session("passing", "passing"),
		session("merged", "merged"),
		session("fresh", "fresh"),
		session("idle", "idle", { updatedAt: Date.now() - 2 * day }),
	];
	github.heads.set("pending/feat/pending", [row("pending", 1, "feat/pending", { checks: "PENDING" })]);
	github.heads.set("passing/feat/passing", [row("passing", 1, "feat/passing", { checks: "SUCCESS" })]);
	github.heads.set("merged/feat/merged", [row("merged", 1, "feat/merged", { state: "MERGED" })]);
	const sync = new PullRequestSync(host(sessions), { runner: github.runner, intervalMs: 1_000 });
	const counts = () =>
		Object.fromEntries(
			sessions.map((target) => [target.id, github.calls.filter((call) => call.repo === target.id).length]),
		);
	const advance = async (ms: number) => {
		for (let step = 0; step < ms; step += 100) {
			t.mock.timers.tick(100);
			await sync.settled();
		}
	};
	try {
		sync.start();
		await sync.settled();
		assert.deepEqual(counts(), { pending: 1, passing: 1, merged: 1, fresh: 1, idle: 1 });
		await advance(2_000);
		assert.deepEqual(counts(), { pending: 5, passing: 2, merged: 1, fresh: 3, idle: 1 });
	} finally {
		await sync.stop();
	}
});

test("failures back off exponentially and recover", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
	t.mock.method(console, "warn", () => {});
	const github = new FakeGitHub();
	github.error = new Error("offline");
	const target = session("a", "a");
	const errors: (string | undefined)[] = [];
	const sync = new PullRequestSync(
		host([target], {
			apply: async (_session, result) => {
				errors.push(result.error);
			},
		}),
		{ runner: github.runner, intervalMs: 1_000 },
	);
	const advance = async (ms: number) => {
		for (let step = 0; step < ms; step += 100) {
			t.mock.timers.tick(100);
			await sync.settled();
		}
	};
	try {
		sync.start();
		await sync.settled();
		assert.equal(github.calls.length, 1);
		await advance(1_000);
		assert.equal(github.calls.length, 2, "first retry after one interval");
		await advance(1_900);
		assert.equal(github.calls.length, 2, "second retry waits two intervals");
		await advance(100);
		assert.equal(github.calls.length, 3);
		assert.ok(errors.every((error) => /offline/.test(error ?? "")));
	} finally {
		await sync.stop();
	}
});

test("linked PRs batch with session heads, and one unreadable PR cannot hide the others", async (t) => {
	t.mock.method(console, "warn", () => {});
	const github = new FakeGitHub();
	const target = session("s", "repo");
	github.heads.set("repo/feat/s", [row("repo", 1, "feat/s")]);
	github.numbers.set("repo#42", row("repo", 42, "external", { isCrossRepository: true, state: "MERGED" }));
	github.numbers.set("repo#43", new Error("Could not resolve to a PullRequest"));
	const links: LinkedPullRequest[] = [42, 43, 42].map((number) => ({
		url: `https://github.com/octo/repo/pull/${number}`,
		cwd: "/project",
	}));
	const updates: SessionPullRequest[] = [];
	const sync = new PullRequestSync(
		host([target], {
			linked: {
				targets: () => links,
				apply: (pr) => {
					updates.push(pr);
					for (const link of links) if (link.url === pr.url) link.pullRequest = pr;
				},
			},
		}),
		{ runner: github.runner },
	);
	try {
		sync.start();
		await sync.settled();
		assert.equal(target.pullRequest?.number, 1);
		assert.deepEqual(
			updates.map((pr) => [pr.number, pr.state]),
			[[42, "merged"]],
		);
		assert.equal(
			github.calls[0]!.variables.filter((value) => /^[hn]\d+=/.test(value)).length,
			3,
			"one combined request first",
		);
		const calls = github.calls.length;
		await sync.refreshLinked(links[0]!);
		assert.equal(github.calls.length, calls, "settled linked PRs never poll again");
	} finally {
		await sync.stop();
	}
});

test("health for every eligible PR of a repository is one request, and problems reach the host", async () => {
	const github = new FakeGitHub();
	const sessions = [session("a", "repo"), session("b", "repo")];
	github.heads.set("repo/feat/a", [row("repo", 1, "feat/a")]);
	github.heads.set("repo/feat/b", [row("repo", 2, "feat/b")]);
	github.failing.set("repo#2", ["tests"]);
	const health: Record<string, string[][]> = {};
	const sync = new PullRequestSync<PullRequestSession, string>(
		host(sessions, {
			health: (target, result) =>
				result.pullRequest ? { prs: [result.pullRequest], context: `ctx-${target.id}` } : undefined,
			apply: async (target, _result, checks) => {
				assert.equal(checks?.context, `ctx-${target.id}`);
				health[target.id] = checks!.checks.map((check) => check.problems.failedChecks);
			},
		}),
		{ runner: github.runner },
	);
	try {
		sync.start();
		await sync.settled();
		assert.deepEqual(
			github.calls.map((call) => call.query),
			["query PilotPullRequests", "query PilotPullRequestHealth"],
		);
		assert.deepEqual(health, { a: [], b: [["tests"]] });
	} finally {
		await sync.stop();
	}
});

test("shutdown persists in-flight results, skips queued work and ignores later requests", async () => {
	const github = new FakeGitHub();
	const sessions = [session("a", "a"), session("b", "b")];
	github.heads.set("a/feat/a", [row("a", 1, "feat/a")]);
	const gate = deferred();
	github.gate = gate.promise;
	const target = host(sessions);
	const sync = new PullRequestSync(target, { runner: github.runner, concurrency: 1 });
	sync.start();
	await until(() => github.calls.length === 1);
	let stopped = false;
	const stopping = sync.stop().then(() => {
		stopped = true;
	});
	await delay(5);
	assert.equal(stopped, false, "shutdown waits for the in-flight lookup");
	gate.resolve();
	await stopping;
	assert.deepEqual(target.applied, ["a"]);
	assert.equal(github.calls.length, 1);
	await sync.refresh(sessions[1]!);
	assert.equal(github.calls.length, 1);
});

test("a focused session is rechecked unless it was checked recently", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
	const github = new FakeGitHub();
	const target = session("a", "a");
	const sync = new PullRequestSync(host([target]), { runner: github.runner, intervalMs: 60_000 });
	try {
		sync.start();
		await sync.settled();
		sync.focus(["a", "unknown"]);
		await sync.settled();
		assert.equal(github.calls.length, 1, "fresh enough");
		t.mock.timers.tick(20_000);
		await sync.settled();
		sync.focus(["a"]);
		await sync.settled();
		assert.equal(github.calls.length, 2);
	} finally {
		await sync.stop();
	}
});

test("a nearly exhausted GraphQL budget pauses the host until its reset", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
	const github = new FakeGitHub();
	github.rateLimit = { remaining: 10, resetAt: new Date(Date.now() + 5 * 60_000).toISOString() };
	const sessions = [session("a", "a"), session("b", "b")];
	const sync = new PullRequestSync(host(sessions), { runner: github.runner, concurrency: 1 });
	try {
		const first = sync.refresh(sessions[0]!);
		await first;
		const second = sync.refresh(sessions[1]!);
		await sync.settled();
		assert.equal(github.calls.length, 1, "no request while the budget is low");
		github.rateLimit = { remaining: 4_000, resetAt: "2100-01-01T00:00:00Z" };
		t.mock.timers.tick(5 * 60_000);
		await second;
		assert.equal(github.calls.length, 2);
	} finally {
		await sync.stop();
	}
});
