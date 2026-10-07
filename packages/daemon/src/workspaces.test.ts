import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
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

for (const ignoreLocation of ["repository", "local", "global"]) {
	test(`copies ignored mise local configs (${ignoreLocation} rules) without other uncommitted files`, async () => {
		const root = mkdtempSync(join(tmpdir(), "pilot-ws-"));
		try {
			const source = join(root, "source");
			const destination = join(root, "workspace");
			git(root, "init", "--quiet", "-b", "main", source);
			writeFileSync(join(source, "README.md"), "committed\n");
			const configs = ["mise.local.toml", ".mise.local.toml", "mise/config.local.toml", ".mise/config.local.toml"];
			const rules = [...configs, "node_modules/", "dist/", ".env", ".jj/"].join("\n");
			if (ignoreLocation === "repository") writeFileSync(join(source, ".gitignore"), rules);
			else if (ignoreLocation === "local") writeFileSync(join(source, ".git/info/exclude"), rules);
			else {
				const globalIgnore = join(root, "global-ignore");
				writeFileSync(globalIgnore, rules);
				git(source, "config", "core.excludesFile", globalIgnore);
			}
			git(source, "add", ".");
			git(source, "commit", "--quiet", "-m", "init");
			mkdirSync(join(source, "mise"));
			mkdirSync(join(source, ".mise"));
			for (const path of configs) writeFileSync(join(source, path), `# ${path}\n[env]\nLOCAL = 'yes'\n`);
			for (const path of ["node_modules", "dist"]) {
				mkdirSync(join(source, path));
				writeFileSync(join(source, path, "output"), "ignored\n");
			}
			writeFileSync(join(source, ".env"), "SECRET=not-copied\n");
			writeFileSync(join(source, "untracked.txt"), "untracked\n");
			writeFileSync(join(source, "README.md"), "dirty\n");

			await createWorkspace(source, destination, "pilot/local-config");
			for (const path of configs) {
				assert.equal(readFileSync(join(destination, path), "utf8"), readFileSync(join(source, path), "utf8"));
				assert.equal(git(destination, "check-ignore", "--", path), path);
			}
			assert.equal(git(destination, "status", "--porcelain"), "");
			assert.equal(readFileSync(join(destination, "README.md"), "utf8"), "committed\n");
			assert.equal(readFileSync(join(source, "README.md"), "utf8"), "dirty\n");
			for (const path of ["node_modules", "dist", ".env", "untracked.txt"]) {
				assert.equal(existsSync(join(destination, path)), false);
			}
			writeFileSync(join(destination, "mise.local.toml"), "workspace-only\n");
			assert.match(readFileSync(join(source, "mise.local.toml"), "utf8"), /LOCAL = 'yes'/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}

test("does not copy tracked, unignored or symlinked local configs", async () => {
	const root = mkdtempSync(join(tmpdir(), "pilot-ws-"));
	try {
		const source = join(root, "source");
		const destination = join(root, "workspace");
		git(root, "init", "--quiet", "-b", "main", source);
		writeFileSync(join(source, ".gitignore"), "mise.local.toml\n.mise.local.toml\n");
		writeFileSync(join(source, "mise.local.toml"), "committed\n");
		git(source, "add", "--force", "mise.local.toml", ".gitignore");
		git(source, "commit", "--quiet", "-m", "init");
		writeFileSync(join(source, "mise.local.toml"), "dirty\n");
		const external = join(root, "external");
		writeFileSync(external, "external\n");
		symlinkSync(external, join(source, ".mise.local.toml"));
		mkdirSync(join(source, "mise"));
		writeFileSync(join(source, "mise/config.local.toml"), "unignored\n");

		await createWorkspace(source, destination, "pilot/local-config");
		assert.equal(readFileSync(join(destination, "mise.local.toml"), "utf8"), "committed\n");
		assert.equal(existsSync(join(destination, ".mise.local.toml")), false);
		assert.equal(existsSync(join(destination, "mise/config.local.toml")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("does not overwrite remote files or copy through checked-out symlinks", async () => {
	const root = mkdtempSync(join(tmpdir(), "pilot-ws-"));
	try {
		const remote = join(root, "remote.git");
		const source = join(root, "source");
		const destination = join(root, "workspace");
		const external = join(root, "external");
		const dangling = join(root, "missing");
		mkdirSync(external);
		git(root, "init", "--quiet", "--bare", "-b", "main", remote);
		git(root, "clone", "--quiet", remote, source);
		writeFileSync(join(source, "mise.local.toml"), "remote config\n");
		writeFileSync(join(source, "mise"), "remote file\n");
		symlinkSync(dangling, join(source, ".mise.local.toml"));
		symlinkSync(external, join(source, ".mise"));
		git(source, "add", "--force", "mise.local.toml", ".mise.local.toml", "mise", ".mise");
		git(source, "commit", "--quiet", "-m", "init");
		git(source, "push", "--quiet", "origin", "HEAD:main");
		git(source, "switch", "--quiet", "-c", "local-topic");
		git(source, "rm", "--quiet", "mise.local.toml", ".mise.local.toml", "mise", ".mise");
		writeFileSync(join(source, ".git/info/exclude"), "mise.local.toml\n.mise.local.toml\nmise/\n.mise/\n");
		mkdirSync(join(source, "mise"));
		mkdirSync(join(source, ".mise"));
		for (const path of ["mise.local.toml", ".mise.local.toml", "mise/config.local.toml", ".mise/config.local.toml"]) {
			writeFileSync(join(source, path), "local config\n");
		}

		await createWorkspace(source, destination, "pilot/local-config");
		assert.equal(readFileSync(join(destination, "mise.local.toml"), "utf8"), "remote config\n");
		assert.equal(readFileSync(join(destination, "mise"), "utf8"), "remote file\n");
		assert.equal(readlinkSync(join(destination, ".mise.local.toml")), dangling);
		assert.equal(readlinkSync(join(destination, ".mise")), external);
		assert.equal(existsSync(dangling), false);
		assert.equal(existsSync(join(external, "config.local.toml")), false);
		assert.equal(git(destination, "status", "--porcelain"), "");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
