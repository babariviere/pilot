import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionPullRequest } from "@pilot/protocol";
import type { PullRequestSession } from "./pull-requests.ts";
import { hasUnpublishedWork, unpublishedRevset } from "./unpublished-work.ts";

const env = {
	...process.env,
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@t",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@t",
};
const quiet = { encoding: "utf8" as const, stdio: "pipe" as const };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, ...quiet }).trim();
const jj = (cwd: string, ...args: string[]) =>
	execFileSync("jj", ["--config=user.name=t", "--config=user.email=t@t", ...args], { cwd, ...quiet }).trim();

function pr(branch: string, state: SessionPullRequest["state"]): SessionPullRequest {
	return { number: 1, url: "https://github.com/a/b/pull/1", title: "PR", state, checkedAt: 1, branch };
}

/** A repository with one base commit, cloned so the session sees `origin/main`. */
function repository(colocateJj: boolean) {
	const root = mkdtempSync(join(tmpdir(), "pilot-unpublished-"));
	const origin = join(root, "origin");
	git(root, "init", "--quiet", "-b", "main", origin);
	writeFileSync(join(origin, "a.txt"), "base\n");
	git(origin, "add", ".");
	git(origin, "commit", "--quiet", "-m", "base");
	const cwd = join(root, "workspace");
	git(root, "clone", "--quiet", origin, cwd);
	if (colocateJj) jj(cwd, "git", "init", "--colocate");
	const base = git(cwd, "rev-parse", "HEAD");
	const session = (extra: Partial<PullRequestSession> = {}): PullRequestSession => ({
		id: "s",
		cwd,
		workspace: { base, baseBranch: "main" },
		...extra,
	});
	return { root, origin, cwd, session, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("jj workspaces: uncommitted edits, bookmarks without a PR and commits after a merge are unpublished", async () => {
	const r = repository(true);
	try {
		assert.equal(await hasUnpublishedWork(r.session()), false, "a fresh empty change is not work");

		writeFileSync(join(r.cwd, "a.txt"), "edited\n");
		assert.equal(await hasUnpublishedWork(r.session()), true, "uncommitted edits are snapshotted");

		jj(r.cwd, "commit", "-m", "feat: work");
		jj(r.cwd, "bookmark", "create", "feat/work", "-r", "@-");
		assert.equal(await hasUnpublishedWork(r.session()), true, "a bookmark without a PR is unpublished");

		git(
			r.cwd,
			"push",
			"--quiet",
			"origin",
			`${jj(r.cwd, "log", "--no-graph", "-r", "feat/work", "-T", "commit_id")}:refs/heads/feat/work`,
		);
		jj(r.cwd, "git", "fetch");
		assert.equal(await hasUnpublishedWork(r.session()), true, "a pushed bookmark without a PR is unpublished");

		const merged = r.session({
			pullRequest: pr("feat/work", "merged"),
			workspace: { ...r.session().workspace!, branch: "feat/work" },
		});
		assert.equal(await hasUnpublishedWork(merged), false, "everything is in the merged PR");

		writeFileSync(join(r.cwd, "b.txt"), "more\n");
		assert.equal(await hasUnpublishedWork(merged), true, "new changes after the merge are unpublished");
		jj(r.cwd, "commit", "-m", "feat: more");
		assert.equal(await hasUnpublishedWork(merged), true, "new commits after the merge are unpublished");

		const legacy = r.session({
			pullRequest: { ...pr("feat/work", "closed"), branch: undefined },
			workspace: { ...r.session().workspace!, branch: "feat/work" },
		});
		jj(r.cwd, "abandon", "@-");
		assert.equal(await hasUnpublishedWork(legacy), false, "a PR without a recorded head uses the workspace branch");
	} finally {
		r.close();
	}
});

test("git clones: dirty trees and commits outside every PR head are unpublished", async () => {
	const r = repository(false);
	try {
		assert.equal(await hasUnpublishedWork(r.session()), false);
		writeFileSync(join(r.cwd, "new.txt"), "untracked\n");
		assert.equal(await hasUnpublishedWork(r.session()), true, "untracked files count");
		git(r.cwd, "checkout", "--quiet", "-b", "feat/work");
		git(r.cwd, "add", ".");
		git(r.cwd, "commit", "--quiet", "-m", "work");
		assert.equal(await hasUnpublishedWork(r.session()), true, "a branch without a PR is unpublished");
		const open = r.session({ pullRequest: pr("feat/work", "open") });
		assert.equal(await hasUnpublishedWork(open), false);
		writeFileSync(join(r.cwd, "a.txt"), "after\n");
		git(r.cwd, "commit", "--quiet", "-am", "after");
		git(r.cwd, "branch", "--quiet", "-f", "other");
		git(r.cwd, "update-ref", "refs/heads/feat/work", "HEAD~1");
		assert.equal(await hasUnpublishedWork(open), true, "commits past the PR head are unpublished");
	} finally {
		r.close();
	}
});

test("unknown workspaces and failed lookups are not unpublished work", async () => {
	assert.equal(await hasUnpublishedWork({ id: "s", cwd: tmpdir() }), undefined);
	const failing = async () => {
		throw new Error("boom");
	};
	assert.equal(
		await hasUnpublishedWork({ id: "s", cwd: tmpdir(), workspace: { base: "abc1234" } }, failing),
		undefined,
	);
	assert.equal(
		await hasUnpublishedWork({ id: "s", cwd: tmpdir(), workspace: {}, workspaceRecovery: {} }),
		undefined,
		"reclaimed workspaces are unknown",
	);
});

test("revsets quote branch names and treat every linked PR head and the base as published", () => {
	const revset = unpublishedRevset({
		id: "s",
		cwd: "/tmp",
		workspace: { base: "origin/release", branch: 'odd"name' },
		pullRequest: { ...pr("x", "merged"), branch: undefined },
		previousPullRequests: [pr("feat/a", "closed")],
	});
	assert.equal(
		revset,
		'(::@ ~ ::(trunk() | remote_bookmarks(exact:"release", remote=exact:"origin") | bookmarks(exact:"odd\\"name") | ' +
			'remote_bookmarks(exact:"odd\\"name", remote=exact:"origin") | bookmarks(exact:"feat/a") | ' +
			'remote_bookmarks(exact:"feat/a", remote=exact:"origin"))) ~ empty()',
	);
});
