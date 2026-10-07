import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { branchSlug, createWorkspace } from "./workspaces.ts";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@t",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@t",
		},
	}).trim();

test("slugs titles for branch names", () => {
	assert.equal(branchSlug("Fix the flaky reopen test!"), "fix-the-flaky-reopen-test");
	assert.equal(branchSlug("!!!"), "task");
	assert.ok(branchSlug("x".repeat(80)).length <= 40);
});

test("clones a project into a private workspace on its own branch from the remote default", async () => {
	const root = mkdtempSync(join(tmpdir(), "pilot-ws-"));
	try {
		const remote = join(root, "remote.git");
		const source = join(root, "source");
		git(root, "init", "--quiet", "--bare", "-b", "main", remote);
		git(root, "clone", "--quiet", remote, source);
		writeFileSync(join(source, "README.md"), "hello\n");
		git(source, "add", ".");
		git(source, "commit", "--quiet", "-m", "init");
		git(source, "push", "--quiet", "origin", "HEAD:main");
		// Uncommitted work in the user's checkout must not leak into the workspace.
		writeFileSync(join(source, "README.md"), "dirty\n");
		git(source, "switch", "--quiet", "-c", "local-topic");

		const destination = join(root, "workspace");
		const workspace = await createWorkspace(source, destination, "pilot/fix-it-abc123");
		assert.equal(workspace.branch, "pilot/fix-it-abc123");
		assert.equal(workspace.base, "origin/main");
		assert.equal(workspace.upstream, remote);
		assert.equal(workspace.jj, false);
		assert.equal(git(destination, "branch", "--show-current"), "pilot/fix-it-abc123");
		assert.equal(git(destination, "remote", "get-url", "origin"), remote);
		assert.equal(readFileSync(join(destination, "README.md"), "utf8"), "hello\n");
		assert.ok(existsSync(join(source, "README.md")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("refuses folders that are not git repositories", async () => {
	const root = mkdtempSync(join(tmpdir(), "pilot-ws-"));
	try {
		await assert.rejects(createWorkspace(root, join(root, "w"), "pilot/x"), /not a git repository/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
