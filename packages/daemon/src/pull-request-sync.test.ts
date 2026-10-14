// biome-ignore-all lint/complexity/useLiteralKeys: Exercise the scheduler's private batch application.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	readonly healthOverrides = new Map<string, Record<string, unknown>>();
	healthError?: Error;
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
				if (this.healthError) throw this.healthError;
				const linked = this.numbers.get(key);
				const pr =
					(linked instanceof Error ? undefined : linked) ??
					[...this.heads.values()].flat().find((candidate) => candidate.url.endsWith(`/${repo}/pull/${args[2]}`));
				return JSON.stringify({
					state: pr?.state ?? "OPEN",
					headRefName: pr?.headRefName,
					mergeable: "MERGEABLE",
					isDraft: pr?.isDraft ?? false,
					reviewDecision: null,
					mergeStateStatus: "CLEAN",
					statusCheckRollup: (this.failing.get(key) ?? []).map((name) => ({
						__typename: "CheckRun",
						name,
						status: "COMPLETED",
						conclusion: "FAILURE",
					})),
					...this.healthOverrides.get(key),
				});
			}
			const pr =
				this.numbers.get(key) ??
				[...this.heads.values()].flat().find((candidate) => candidate.url.endsWith(`/${repo}/pull/${args[2]}`));
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
		assert.deepEqual(github.calls.map((call) => call.repo).sort(), ["a", "a", "b", "b", "c", "c"]);
		const a = github.calls.find((call) => call.repo === "a")!;
		assert.equal(a.variables.filter((value) => value.startsWith("h")).length, 3, "three sessions, one request");
		for (const target of sessions) assert.equal(target.pullRequest?.state, "open", target.id);
	} finally {
		gate.resolve();
		await sync.stop();
	}
});

test("readiness updates without a follow-up plan, survives failed health and a serialized restart, and clears on merge", async () => {
	const github = new FakeGitHub();
	const target = session("a", "a");
	github.heads.set("a/feat/a", [row("a", 7, "feat/a")]);
	let sync = new PullRequestSync(host([target]), { runner: github.runner });
	try {
		await sync.refresh(target);
		assert.equal(target.pullRequest?.readiness?.state, "ready");
		const cached = structuredClone(target.pullRequest!.readiness);
		github.healthError = new Error("offline");
		await sync.refresh(target);
		assert.deepEqual(target.pullRequest?.readiness, cached, "health freshness does not advance on failure");
		await sync.stop();
		const restored: PullRequestSession = JSON.parse(JSON.stringify(target));
		sync = new PullRequestSync(host([restored]), { runner: github.runner });
		await sync.refresh(restored);
		assert.deepEqual(restored.pullRequest?.readiness, cached);
		delete github.healthError;
		github.healthOverrides.set("a#7", { reviewDecision: "CHANGES_REQUESTED" });
		await sync.refresh(restored);
		assert.equal(restored.pullRequest?.readiness?.state, "blocked");
		github.healthOverrides.set("a#7", { mergeable: "UNKNOWN" });
		await sync.refresh(restored);
		assert.equal(restored.pullRequest?.readiness?.state, "pending");
		github.healthOverrides.delete("a#7");
		await sync.refresh(restored);
		assert.equal(restored.pullRequest?.readiness?.state, "ready");
		github.heads.set("a/feat/a", [row("a", 7, "feat/a", { state: "MERGED" })]);
		await sync.refresh(restored);
		assert.equal(restored.pullRequest?.state, "merged");
		assert.equal(restored.pullRequest?.readiness, undefined);
	} finally {
		await sync.stop();
	}
});

test("mission-linked and session PRs share one health query and both receive readiness", async () => {
	const github = new FakeGitHub();
	const target = session("a", "a");
	github.heads.set("a/feat/a", [row("a", 7, "feat/a")]);
	const linked: LinkedPullRequest = { url: "https://github.com/octo/a/pull/7", cwd: "/source" };
	const updates: SessionPullRequest[] = [];
	const sync = new PullRequestSync(
		host([target], {
			linked: {
				targets: () => [linked],
				apply: (pr) => {
					linked.pullRequest = pr;
					updates.push(pr);
				},
			},
		}),
		{ runner: github.runner },
	);
	try {
		sync.start();
		await sync.settled();
		assert.equal(target.pullRequest?.readiness?.state, "ready");
		assert.equal(updates[0]?.readiness?.state, "ready");
		assert.equal(github.calls.filter((call) => call.query === "query PilotPullRequestHealth").length, 1);
		assert.equal(
			github.calls
				.find((call) => call.query === "query PilotPullRequestHealth")
				?.variables.filter((value) => value.startsWith("p")).length,
			1,
			"duplicate PRs are queried once",
		);
	} finally {
		await sync.stop();
	}
});

test("busy PR readiness uses one paginated fallback shared by session and mission links", async () => {
	const github = new FakeGitHub();
	const target = session("a", "a");
	github.heads.set("a/feat/a", [row("a", 7, "feat/a")]);
	const linked: LinkedPullRequest = { url: "https://github.com/octo/a/pull/7", cwd: "/source" };
	let views = 0;
	let pages = 0;
	const runner: Runner = async (file, args, ...rest) => {
		const query = args.find((arg) => arg.startsWith("query=")) ?? "";
		if (query.includes("PilotPullRequestHealth"))
			return JSON.stringify({
				data: {
					repository: {
						p0: {
							number: 7,
							state: "OPEN",
							headRefName: "feat/a",
							mergeable: "MERGEABLE",
							commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
							reviewThreads: { nodes: [], pageInfo: { hasNextPage: true } },
						},
					},
				},
			});
		if (args[0] === "pr" && args[1] === "view") {
			views++;
			assert.ok(args.includes("--repo=github.com/octo/a"));
			return JSON.stringify({
				state: "OPEN",
				headRefName: "feat/a",
				mergeable: "MERGEABLE",
				isDraft: false,
				reviewDecision: null,
				mergeStateStatus: "CLEAN",
				statusCheckRollup: [],
			});
		}
		if (query.includes("reviewThreads")) {
			pages++;
			return JSON.stringify({
				data: {
					repository: {
						pullRequest: {
							reviewThreads: {
								nodes: [
									{ id: `t${pages}`, isResolved: pages === 1, isOutdated: false, comments: { totalCount: 1 } },
								],
								pageInfo: { hasNextPage: pages === 1, endCursor: pages === 1 ? "next" : null },
							},
						},
					},
				},
			});
		}
		return github.runner(file, args, ...rest);
	};
	const sync = new PullRequestSync(
		host([target], {
			linked: {
				targets: () => [linked],
				apply: (pr) => {
					linked.pullRequest = pr;
				},
			},
		}),
		{ runner },
	);
	try {
		sync.start();
		await sync.settled();
		assert.equal(views, 1);
		assert.equal(pages, 2);
		assert.equal(target.pullRequest?.readiness?.state, "blocked");
		assert.deepEqual(target.pullRequest?.readiness?.reasons, [{ code: "unresolved_comments", count: 1 }]);
		assert.deepEqual(linked.pullRequest?.readiness, target.pullRequest?.readiness);
	} finally {
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
			sessions.map((target) => [
				target.id,
				github.calls.filter((call) => call.repo === target.id && call.query === "query PilotPullRequests").length,
			]),
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

test("local inspection is reused while the repository and session are unchanged", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pilot-sync-cache-"));
	try {
		await mkdir(join(cwd, ".git", "refs", "heads", "feat"), { recursive: true });
		await writeFile(join(cwd, ".git", "HEAD"), "ref: refs/heads/feat/a\n");
		await writeFile(join(cwd, ".git", "refs", "heads", "feat", "a"), "abc\n");
		const github = new FakeGitHub();
		github.heads.set("a/feat/a", [row("a", 1, "feat/a")]);
		let local = 0;
		const runner: Runner = async (file, ...rest) => {
			if (file === "git") local++;
			return github.runner(file, ...rest);
		};
		const target = session("a", "a", { cwd });
		const sync = new PullRequestSync(host([target]), { runner });
		try {
			await sync.refresh(target);
			const first = local;
			assert.ok(first > 0);
			assert.equal(target.pullRequest?.number, 1);
			await sync.refresh(target);
			assert.equal(local, first, "no git process while nothing changed");
			assert.equal(github.calls.length, 4, "GitHub is still asked for fresh PR state and health");
			await writeFile(join(cwd, ".git", "refs", "heads", "feat", "b"), "def\n");
			await sync.refresh(target);
			assert.ok(local > first, "a new branch invalidates the inspection");
		} finally {
			await sync.stop();
		}
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("a known open PR is looked up by number instead of its head", async () => {
	const github = new FakeGitHub();
	const target = session("a", "a");
	github.heads.set("a/feat/a", [row("a", 7, "feat/a")]);
	const sync = new PullRequestSync(host([target]), { runner: github.runner });
	try {
		await sync.refresh(target);
		await sync.refresh(target);
		assert.deepEqual(
			github.calls
				.filter((call) => call.query === "query PilotPullRequests")
				.map((call) => call.variables.filter((value) => /^[hn]\d+=/.test(value))),
			[["h0=feat/a"], ["n0=7"]],
		);
	} finally {
		await sync.stop();
	}
});

test("bound numbers share discovery and health batches with sibling heads and mission links", async () => {
	const github = new FakeGitHub();
	const target = session("a", "repo", {
		boundPullRequests: ["https://github.com/octo/repo/pull/42"],
	});
	const sibling = session("b", "repo");
	github.heads.set("repo/feat/a", [row("repo", 1, "feat/a")]);
	github.heads.set("repo/feat/b", [row("repo", 2, "feat/b")]);
	github.numbers.set("repo#42", row("repo", 42, "external", { isCrossRepository: true }));
	const link: LinkedPullRequest = { url: target.boundPullRequests![0]!, cwd: "/project" };
	const sync = new PullRequestSync(
		host([target, sibling], {
			linked: {
				targets: () => [link],
				apply: (pr) => {
					link.pullRequest = pr;
				},
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
		assert.deepEqual(
			github.calls[0]!.variables.filter((value) => /^[hn]\d+=/.test(value)),
			["h0=feat/a", "h1=feat/b", "n0=42"],
		);
		assert.equal(target.previousPullRequests?.[0]?.number, 42);
		assert.equal(target.previousPullRequests?.[0]?.readiness?.state, "ready");
		assert.equal(link.pullRequest?.readiness?.state, "ready");
	} finally {
		await sync.stop();
	}
});

test("an unresolved binding keeps terminal sessions eligible and pending bound checks poll faster", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
	const github = new FakeGitHub();
	const target = session("a", "repo", {
		workspace: { upstream: "git@github.com:octo/repo.git" },
		pullRequest: {
			number: 1,
			url: "https://github.com/octo/repo/pull/1",
			title: "Done",
			state: "merged",
			checkedAt: 1,
		},
		boundPullRequests: ["https://github.com/octo/repo/pull/42"],
	});
	github.numbers.set("repo#42", row("repo", 42, "external", { checks: "PENDING" }));
	const sync = new PullRequestSync(host([target]), { runner: github.runner, intervalMs: 1_000 });
	const discoveries = () => github.calls.filter((call) => call.query === "query PilotPullRequests");
	try {
		sync.start();
		await sync.settled();
		assert.equal(discoveries().length, 1);
		assert.equal(target.previousPullRequests?.[0]?.number, 42);
		t.mock.timers.tick(500);
		await sync.settled();
		assert.equal(discoveries().length, 2);
		github.numbers.set("repo#42", row("repo", 42, "external", { state: "MERGED" }));
		t.mock.timers.tick(500);
		await sync.settled();
		assert.equal(discoveries().length, 3);
		t.mock.timers.tick(2_000);
		await sync.settled();
		assert.equal(discoveries().length, 3, "all bound and cached PRs are terminal");
	} finally {
		await sync.stop();
	}
});

test("direct-project bound PRs batch with workspace heads, poll health and support explicit refresh", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
	const github = new FakeGitHub();
	const target = session("direct", "repo", {
		workspace: undefined,
		boundPullRequests: ["https://github.com/octo/repo/pull/42"],
	});
	const sibling = session("workspace", "repo");
	const recovery = session("recovery", "repo", {
		workspace: undefined,
		workspaceRecovery: {},
		boundPullRequests: target.boundPullRequests,
	});
	github.numbers.set("repo#42", row("repo", 42, "external", { checks: "PENDING", isCrossRepository: true }));
	github.heads.set("repo/feat/workspace", [row("repo", 1, "feat/workspace")]);
	const runner: Runner = async (file, args, ...rest) => {
		if (file === "git" && rest[0] === target.cwd) {
			assert.deepEqual(args, ["remote", "get-url", "origin"]);
			return "git@github.com:octo/repo.git";
		}
		assert.notEqual(rest[0], recovery.cwd);
		return github.runner(file, args, ...rest);
	};
	const sync = new PullRequestSync(host([target, sibling, recovery]), { runner, intervalMs: 1_000 });
	const discoveries = () => github.calls.filter((call) => call.query === "query PilotPullRequests");
	try {
		sync.start();
		await sync.settled();
		assert.equal(discoveries().length, 1);
		assert.deepEqual(
			discoveries()[0]!.variables.filter((value) => /^[hn]\d+=/.test(value)),
			["h0=feat/workspace", "n0=42"],
		);
		assert.equal(target.previousPullRequests?.[0]?.number, 42);
		assert.equal(target.previousPullRequests?.[0]?.readiness?.state, "ready");
		t.mock.timers.tick(500);
		await sync.settled();
		assert.equal(discoveries().length, 2, "pending direct binding polls at half cadence");
		await sync.refresh(target);
		assert.equal(discoveries().length, 3, "explicit refresh accepts a direct-project chat");
		await sync.refresh(recovery);
		assert.equal(discoveries().length, 3, "recovery remains excluded");
	} finally {
		await sync.stop();
	}
});

test("binding and exclusion changes invalidate cached inspections", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pilot-sync-bindings-"));
	await mkdir(join(cwd, ".git"));
	await writeFile(join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
	const github = new FakeGitHub();
	const target = session("a", "repo", { cwd, workspace: { upstream: "git@github.com:octo/repo.git" } });
	github.numbers.set("repo#42", row("repo", 42, "external"));
	const sync = new PullRequestSync(host([target]), { runner: github.runner });
	try {
		await sync.refresh(target);
		assert.equal(github.calls.length, 0);
		target.boundPullRequests = ["https://github.com/octo/repo/pull/42"];
		await sync.refresh(target);
		assert.equal(target.previousPullRequests?.[0]?.number, 42);
		const count = github.calls.length;
		target.unboundPullRequests = [...target.boundPullRequests];
		await sync.refresh(target);
		assert.ok(github.calls.slice(count).every((call) => !call.variables.includes("n0=42")));
	} finally {
		await sync.stop();
		await rm(cwd, { recursive: true, force: true });
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

test("a bottom-of-stack PR whose head no longer contains the stack base reaches the host as diverged", async () => {
	const sessions = [session("a", "repo")];
	const queries: string[] = [];
	const runner: Runner = async (file, args) => {
		if (file === "git") return "";
		const value = (name: string) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
		const query = value("query")!;
		queries.push(query);
		const rateLimit = { remaining: 4_000, resetAt: "2100-01-01T00:00:00Z" };
		if (query.startsWith("query PilotPullRequestHealth")) {
			assert.equal(value("h0"), "refs/heads/feat/a");
			return JSON.stringify({
				data: {
					rateLimit,
					repository: {
						p0: {
							number: 1,
							state: "OPEN",
							headRefName: "feat/a",
							mergeable: "MERGEABLE",
							commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
							reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
							baseRefName: "main",
							baseRef: { compare: { behindBy: 1 } },
						},
					},
				},
			});
		}
		const pr = {
			...row("repo", 1, "feat/a"),
			stack: { number: 3, size: 2, baseRefName: "main" },
			stackEntry: { position: 1 },
		};
		return JSON.stringify({ data: { rateLimit, repository: { o0: { nodes: [pr] }, a0: { nodes: [pr] } } } });
	};
	const reported: unknown[] = [];
	const sync = new PullRequestSync<PullRequestSession, string>(
		host(sessions, {
			health: (_target, result) => (result.pullRequest ? { prs: [result.pullRequest], context: "ctx" } : undefined),
			apply: async (_target, _result, checks) => {
				reported.push(...(checks?.checks.map((check) => check.problems) ?? []));
			},
		}),
		{ runner },
	);
	try {
		sync.start();
		await sync.settled();
		assert.match(queries.at(-1)!, /compare\(headRef: \$h0\)/);
		assert.deepEqual(reported, [
			{ failedChecks: [], reviewComments: 0, mergeConflicts: false, divergedFrom: "main" },
		]);
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
