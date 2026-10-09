import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	createdBookmarks,
	discoverLinkedPullRequest as discoverLinked,
	discoverPullRequest as discover,
	githubRepository,
	type PullRequestSession,
	repositoryState,
	sessionBranches,
	workspaceBookmarks,
} from "./pull-requests.ts";
import { legacyGitHub } from "./testing/legacy-github.ts";
import type { Runner } from "./workspaces.ts";

// Describe GitHub per head or PR number, as gh pr list/view would, while running the real batched queries.
const discoverPullRequest = (target: PullRequestSession, runner: Runner) => discover(target, legacyGitHub(runner));
const discoverLinkedPullRequest = (target: Parameters<typeof discoverLinked>[0], runner: Runner) =>
	discoverLinked(target, legacyGitHub(runner));

const branch = "fix-pr-tracking";
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
		mergedAt: "2026-01-02T00:00:00Z",
		...overrides,
	};
}

const listing =
	(rows: ReturnType<typeof candidate>[]): Runner =>
	async (file, args) => {
		if (file === "git" && args[0] === "branch") return "";
		assert.equal(file, "gh");
		return JSON.stringify(args.includes("--state=open") ? rows.filter((row) => row.state === "OPEN") : rows);
	};

test("hand-linked fork PR lookup uses an explicit repository and validates identity and state", async () => {
	const target = { url: "https://github.com/octo/repo/pull/42", cwd: "/project" };
	const runner: Runner = async (file, args, cwd) => {
		assert.equal(file, "gh");
		assert.deepEqual(args.slice(0, 4), ["pr", "view", "42", "--repo=github.com/octo/repo"]);
		assert.equal(cwd, target.cwd);
		return JSON.stringify(candidate({ number: 42, isCrossRepository: true, state: "MERGED", isDraft: true }));
	};
	const pr = await discoverLinkedPullRequest(target, runner);
	assert.equal(pr.state, "merged");
	assert.ok(pr.mergedAt);
	await assert.rejects(
		discoverLinkedPullRequest(target, async () => JSON.stringify(candidate({ number: 41 }))),
		/Invalid linked/,
	);
	await assert.rejects(
		discoverLinkedPullRequest(target, async () =>
			JSON.stringify(candidate({ number: 42, url: "https://github.com/other/repo/pull/42" })),
		),
		/Invalid GitHub/,
	);
	await assert.rejects(
		discoverLinkedPullRequest(target, async () =>
			JSON.stringify(candidate({ number: 42, state: "MERGED", mergedAt: null })),
		),
		/Invalid GitHub/,
	);
	await assert.rejects(
		discoverLinkedPullRequest({ ...target, url: "https://evil.test/octo/repo/pull/42" }, runner),
		/Invalid linked/,
	);
});

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

test("direct pushes to the workspace default branch do not discover unrelated PRs", async () => {
	const target = session();
	target.workspace = { base: "origin/trunk", branch: "trunk", upstream: "git@github.com:octo/repo.git" };
	const result = await discoverPullRequest(target, async (file, args) => {
		assert.equal(file, "git");
		assert.deepEqual(args, ["branch", "--show-current"]);
		return "trunk";
	});
	assert.deepEqual(result, { branch: "trunk" });
});

test("a shared workspace's pinned base branch preserves direct-delivery PR filtering", async () => {
	const target = session();
	target.workspace = { base: "a".repeat(40), baseBranch: "trunk", branch: "trunk" };
	const result = await discoverPullRequest(target, async (file, args) => {
		assert.equal(file, "git");
		assert.deepEqual(args, ["branch", "--show-current"]);
		return "trunk";
	});
	assert.deepEqual(result, { branch: "trunk" });
});

test("reclaimed or restoring workspaces never run repository or GitHub commands", async () => {
	for (const hasBranch of [true, false]) {
		const target = session();
		target.workspaceRecovery = { phase: "reclaimed" };
		if (!hasBranch) delete target.workspace!.branch;
		const result = await discoverPullRequest(target, async () => {
			throw new Error("A reclaimed cwd must not be accessed");
		});
		assert.deepEqual(result, hasBranch ? { branch } : {});
	}
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
		assert.equal(result.mergedAt, state === "MERGED" ? Date.parse("2026-01-02T00:00:00Z") : undefined);
	}
});

test("one GraphQL request carries the agent-chosen branch as a variable, with the recorded upstream and a timeout", async () => {
	const calls: { file: string; args: string[]; cwd: string; timeout?: number }[] = [];
	const target = session();
	target.workspace!.branch = "fix/a;$(whoami)";
	target.previousBranches = ["fix/b"];
	const result = await discover(target, async (file, args, cwd, timeout) => {
		if (file === "git" && args[0] === "branch") return "";
		calls.push({ file, args, cwd, timeout });
		assert.equal(file, "gh", "recorded upstream avoids a potentially changed origin");
		const nodes = (head: string) => [candidate({ headRefName: head, number: head === "fix/b" ? 2 : 1 })];
		return JSON.stringify({
			data: {
				rateLimit: { remaining: 4_000, resetAt: "2100-01-01T00:00:00Z" },
				repository: {
					o0: { nodes: nodes(target.workspace!.branch!) },
					a0: { nodes: [] },
					o1: { nodes: nodes("fix/b") },
					a1: { nodes: [] },
				},
			},
		});
	});
	assert.equal(result.pullRequest?.state, "open");
	assert.deepEqual(
		result.others?.map((pr) => pr.number),
		[2],
	);
	assert.equal(calls.length, 1, "all heads share one request");
	const [call] = calls;
	assert.equal(call!.cwd, "/private/clone");
	assert.equal(call!.timeout, 20_000);
	assert.deepEqual(call!.args.slice(0, 3), ["api", "graphql", "--hostname=github.com"]);
	const values = call!.args.filter((_, i) => call!.args[i - 1] === "-f" || call!.args[i - 1] === "-F");
	assert.ok(values[0]!.startsWith("query=query PilotPullRequests("));
	assert.ok(!values[0]!.includes("whoami"), "branch names never become query text");
	assert.deepEqual(values.slice(1), ["owner=octo", "name=repo", "h0=fix/a;$(whoami)", "h1=fix/b"]);
});

test("only legacy private workspaces read origin, direct sessions never run git or gh", async () => {
	let calls = 0;
	const target = session();
	delete target.workspace!.upstream;
	const runner: Runner = async (file, args, cwd, timeout) => {
		if (file === "git" && args[0] === "branch") return "";
		calls++;
		assert.equal(cwd, target.cwd);
		assert.equal(timeout, file === "git" ? 10_000 : 20_000);
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

test("detached private sessions wait for the agent's branch before asking GitHub", async () => {
	const target = session();
	delete target.workspace!.branch;
	let chosen = "";
	let lookups = 0;
	const runner: Runner = async (file, args) => {
		if (file === "git") {
			if (args[1] === "--format=%(refname:short)") return chosen;
			assert.deepEqual(args, ["branch", "--show-current"]);
			return chosen;
		}
		lookups++;
		assert.ok(args.includes("--head=fix-reopen-race"));
		return JSON.stringify([candidate({ headRefName: chosen })]);
	};
	assert.deepEqual(await discoverPullRequest(target, runner), {});
	assert.equal(lookups, 0);
	chosen = "fix-reopen-race";
	const result = await discoverPullRequest(target, runner);
	assert.equal(result.branch, chosen);
	assert.equal(result.pullRequest?.state, "open");
	assert.equal(lookups, 1);
	assert.equal(target.workspace!.branch, undefined, "discovery does not mutate session metadata");
});

test("a newly checked-out branch supersedes the cached branch and does not retain its PR", async () => {
	const target = session();
	target.pullRequest = {
		number: 1,
		url: "https://github.com/octo/repo/pull/1",
		title: "Old branch",
		state: "open",
		checkedAt: 1,
	};
	const result = await discoverPullRequest(target, async (file, args) => {
		if (file === "git") return "fix-new-task";
		assert.ok(args.includes("--head=fix-new-task"));
		return "[]";
	});
	assert.deepEqual(result, { branch: "fix-new-task" });
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
		if (file === "git" && args[0] === "branch") return "";
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
		if (_file === "git" && args[0] === "branch") return "";
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
		async () => JSON.stringify([candidate({ state: "MERGED", mergedAt: null })]),
		async () => JSON.stringify([candidate({ state: "MERGED", mergedAt: undefined })]),
		async () => JSON.stringify([candidate({ state: "MERGED", mergedAt: "invalid" })]),
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
	assert.deepEqual(await discoverPullRequest(target, listing([])), { branch });
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
			await discoverPullRequest(
				{ ...session(), workspace: { branch, upstream: "--repo=evil" } },
				async (file, args) => {
					if (file === "git" && args[0] === "branch") return "";
					throw new Error("must not execute");
				},
			)
		).error!,
		/not a GitHub repository URL/,
	);
});

test("discovers PRs from the session's other branches, skipping settled ones and the base", async () => {
	const target = session();
	target.previousPullRequests = [
		{
			number: 3,
			url: "https://github.com/octo/repo/pull/3",
			title: "Settled",
			state: "merged",
			branch: "fix/settled",
			checkedAt: Date.now(),
		},
		{
			number: 2,
			url: "https://github.com/octo/repo/pull/2",
			title: "Old",
			state: "open",
			branch: "fix/earlier",
			checkedAt: 1,
		},
	];
	target.previousBranches = ["fix/observed"];
	target.workspace!.base = "origin/main";
	const heads: string[] = [];
	const result = await discoverPullRequest(target, async (file, args) => {
		if (file === "git") return args[1] === "--show-current" ? branch : `main\n${branch}\nfix/split-off\nfix/settled`;
		// The earlier branch's PR is still open, so it is looked up by number, not searched by head.
		if (args[1] === "view") return JSON.stringify(candidate({ number: Number(args[2]), headRefName: "fix/earlier" }));
		const head = args.find((arg) => arg.startsWith("--head="))!.slice("--head=".length);
		heads.push(head);
		const number = { [branch]: 1, "fix/earlier": 2, "fix/split-off": 4 }[head];
		return JSON.stringify(number ? [candidate({ number, headRefName: head })] : []);
	});
	assert.equal(result.error, undefined);
	assert.equal(result.pullRequest?.number, 1);
	assert.equal(result.pullRequest?.branch, branch);
	assert.deepEqual(
		result.others?.map((pr) => [pr.number, pr.branch, pr.state]),
		[
			[2, "fix/earlier", "open"],
			[4, "fix/split-off", "open"],
		],
	);
	assert.ok(!heads.includes("main"), "the base branch is never a session PR head");
	assert.ok(!heads.includes("fix/settled"), "merged and closed PRs on other branches never poll again");
	assert.deepEqual(
		heads.filter((head) => head === "fix/observed"),
		["fix/observed", "fix/observed"],
		"observed branches without a PR are still checked",
	);
});

test("shared workspaces only attribute bookmarks created from their own jj workspace", async () => {
	const target = session();
	target.workspace = { ...target.workspace!, shared: { name: "w" } };
	const shows: string[] = [];
	const result = await discoverPullRequest(target, async (file, args) => {
		if (file === "git") {
			assert.deepEqual(args, ["branch", "--show-current"]);
			return branch;
		}
		if (file === "jj" && args[1] === "log")
			return ['op-c\t"w@"', 'op-sibling\t"other@"', 'op-b\t"w"', "op-root\tnull"].join("\n");
		if (file === "jj") {
			const id = args.at(-1)!;
			shows.push(id);
			return {
				"op-c": `\nChanged local bookmarks:\n${branch}:\n+ abc 123 ${branch} | x\n- (absent)\n`,
				"op-b": "\nChanged local bookmarks:\nfix/stacked:\n+ abc 456 fix/stacked | y\n- (absent)\n",
			}[id]!;
		}
		const head = args.find((arg) => arg.startsWith("--head="))!.slice("--head=".length);
		return JSON.stringify(head === "fix/stacked" ? [candidate({ number: 2, headRefName: head })] : [candidate()]);
	});
	assert.deepEqual(shows, ["op-c", "op-b"], "sibling workspaces' operations are never read");
	assert.equal(result.pullRequest?.number, 1);
	assert.deepEqual(
		result.others?.map((pr) => [pr.number, pr.branch]),
		[[2, "fix/stacked"]],
	);
	assert.deepEqual(result.branches, ["fix/stacked"]);
});

test("reads created local bookmarks from an operation diff, ignoring moves and remote bookmarks", () => {
	const diff = [
		"",
		"Changed commits:",
		"+ abc 123 feat/a | x",
		"",
		"Changed local bookmarks:",
		"feat/a:",
		"+ abc 123 feat/a | x",
		"- (absent)",
		"feat/moved:",
		"+ abc 123 feat/moved | x",
		"- def 456 feat/moved | y",
		"",
		"Changed remote bookmarks:",
		"feat/remote@origin:",
		"+ tracked abc 123 feat/remote | x",
		"- untracked (absent)",
	].join("\n");
	assert.deepEqual(createdBookmarks(diff), ["feat/a"]);
});

test("lists the current branch first, then PR heads and branches without a PR", () => {
	const target = session();
	target.previousPullRequests = [
		{
			number: 2,
			url: "https://github.com/octo/repo/pull/2",
			title: "x",
			state: "open",
			branch: "fix/b",
			checkedAt: 1,
		},
	];
	target.previousBranches = ["fix/c", branch];
	assert.deepEqual(sessionBranches(target), [branch, "fix/b", "fix/c"]);
});

test("the shared operation log is read incrementally after the first scan, and fully again if rewritten", async () => {
	const cwd = "/incremental/clone";
	const created = (name: string) => `\nChanged local bookmarks:\n${name}:\n+ abc 123 ${name} | x\n- (absent)\n`;
	let log = ['op-2\t"w@"\tb', 'op-1\t"other@"\tb', 'op-0\t"w@"\t-'];
	const shows: Record<string, string> = {
		"op-2": created("feat/a"),
		"op-3": created("feat/b"),
		"op-9": created("feat/c"),
	};
	const limits: (number | undefined)[] = [];
	const shown: string[] = [];
	const runner: Runner = async (_file, args) => {
		if (args[1] === "show") {
			shown.push(args.at(-1)!);
			return shows[args.at(-1)!]!;
		}
		const index = args.indexOf("--limit");
		const limit = index < 0 ? undefined : Number(args[index + 1]);
		limits.push(limit);
		return log.slice(0, limit).join("\n");
	};
	assert.deepEqual(await workspaceBookmarks(cwd, "w", runner), ["feat/a"]);
	assert.deepEqual(shown, ["op-2"], "sibling and non-bookmark operations are never shown");
	log = ['op-3\t"w@"\tb', ...log];
	assert.deepEqual(await workspaceBookmarks(cwd, "w", runner), ["feat/b", "feat/a"]);
	assert.deepEqual(limits, [undefined, 32], "only the newest operations are read");
	log = ['op-9\t"w@"\tb'];
	assert.deepEqual(await workspaceBookmarks(cwd, "w", runner), ["feat/c"], "a rewritten log is rescanned");
	assert.deepEqual(limits, [undefined, 32, 32]);
});

test("repository fingerprints change with jj operations and git refs, without running processes", async () => {
	const root = await mkdtemp(join(tmpdir(), "pilot-repo-state-"));
	try {
		const jj = join(root, "jj");
		const repo = join(root, "shared", ".jj", "repo");
		await mkdir(join(repo, "op_heads", "heads"), { recursive: true });
		await mkdir(join(jj, ".jj"), { recursive: true });
		await writeFile(join(jj, ".jj", "repo"), "../../shared/.jj/repo");
		await writeFile(join(repo, "op_heads", "heads", "aaa"), "");
		assert.equal(await repositoryState(jj), "jj:aaa");
		await rm(join(repo, "op_heads", "heads", "aaa"));
		await writeFile(join(repo, "op_heads", "heads", "bbb"), "");
		assert.equal(await repositoryState(jj), "jj:bbb");

		const git = join(root, "git");
		await mkdir(join(git, ".git", "refs", "heads", "feat"), { recursive: true });
		await writeFile(join(git, ".git", "HEAD"), "ref: refs/heads/main\n");
		const before = await repositoryState(git);
		assert.ok(before?.startsWith("git:"));
		assert.equal(await repositoryState(git), before);
		await writeFile(join(git, ".git", "refs", "heads", "feat", "x"), "abc\n");
		assert.notEqual(await repositoryState(git), before);
		assert.equal(await repositoryState(join(root, "missing")), undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
