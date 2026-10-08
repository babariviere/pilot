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
import { setTimeout as delay } from "node:timers/promises";
import { collectChanges } from "./changes.ts";
import {
	createWorkspace,
	dissociateWorkspace,
	listRemoteBranches,
	workspaceBorrowsObjects,
	workspaceBranch,
} from "./workspaces.ts";

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

const jj = (cwd: string, ...args: string[]) => execFileSync("jj", args, { cwd, encoding: "utf8" }).trim();
const hasJj = (() => {
	try {
		execFileSync("jj", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

test("lists only origin's live heads and symbolic default without changing the checkout", async () => {
	const root = mkdtempSync(join(tmpdir(), "pilot-remote-branches-"));
	try {
		const remote = join(root, "remote.git");
		const source = join(root, "source");
		git(root, "init", "--quiet", "--bare", "-b", "release", remote);
		git(root, "clone", "--quiet", remote, source);
		writeFileSync(join(source, "a.txt"), "base\n");
		git(source, "add", ".");
		git(source, "commit", "--quiet", "-m", "base");
		git(source, "push", "--quiet", "origin", "HEAD:release", "HEAD:z-topic", "HEAD:a/topic", "HEAD:deleted");
		git(remote, "update-ref", "refs/heads/HEAD", "refs/heads/release");
		git(source, "push", "--quiet", "origin", ":deleted");
		git(source, "update-ref", "refs/remotes/origin/deleted", "HEAD");
		git(source, "branch", "local-only");
		git(source, "tag", "tag-only");
		git(source, "push", "--quiet", "origin", "tag-only");
		git(root, "init", "--quiet", "--bare", join(root, "other.git"));
		git(source, "remote", "add", "other", join(root, "other.git"));
		git(source, "push", "--quiet", "other", "HEAD:other-only");
		writeFileSync(join(source, "a.txt"), "dirty\n");
		const refs = git(source, "show-ref");
		const status = git(source, "status", "--porcelain");
		const fetchHead = existsSync(join(source, ".git", "FETCH_HEAD"))
			? readFileSync(join(source, ".git", "FETCH_HEAD"), "utf8")
			: undefined;
		assert.deepEqual(await listRemoteBranches(source), {
			branches: ["a/topic", "release", "z-topic"],
			defaultBranch: "release",
		});
		assert.equal(git(source, "show-ref"), refs);
		assert.equal(git(source, "status", "--porcelain"), status);
		assert.equal(
			existsSync(join(source, ".git", "FETCH_HEAD"))
				? readFileSync(join(source, ".git", "FETCH_HEAD"), "utf8")
				: undefined,
			fetchHead,
		);
		git(remote, "symbolic-ref", "HEAD", "refs/heads/missing");
		assert.deepEqual(await listRemoteBranches(source), { branches: ["a/topic", "release", "z-topic"] });
		rmSync(remote, { recursive: true, force: true });
		await assert.rejects(listRemoteBranches(source), /Unable to list origin branches/);
		git(source, "remote", "remove", "origin");
		assert.deepEqual(await listRemoteBranches(source), { branches: [] });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("selected origin branch starts at its fresh remote tip detached and supplies the diff base", async () => {
	const root = mkdtempSync(join(tmpdir(), "pilot-selected-base-"));
	try {
		const remote = join(root, "remote.git");
		const source = join(root, "source");
		git(root, "init", "--quiet", "--bare", "-b", "main", remote);
		git(root, "clone", "--quiet", remote, source);
		writeFileSync(join(source, "a.txt"), "main\n");
		git(source, "add", ".");
		git(source, "commit", "--quiet", "-m", "main");
		git(source, "push", "--quiet", "origin", "HEAD:main", "HEAD:release/stable");
		const publisher = join(root, "publisher");
		git(root, "clone", "--quiet", remote, publisher);
		git(publisher, "switch", "--quiet", "release/stable");
		writeFileSync(join(publisher, "a.txt"), "selected tip\n");
		git(publisher, "commit", "--quiet", "-am", "selected");
		git(publisher, "push", "--quiet", "origin", "HEAD");
		const tip = git(publisher, "rev-parse", "HEAD");
		assert.notEqual(git(source, "rev-parse", "origin/release/stable"), tip);
		writeFileSync(join(source, "a.txt"), "user dirty\n");
		const refs = git(source, "show-ref");
		const workspace = await createWorkspace(source, join(root, "workspace"), undefined, undefined, "release/stable");
		assert.equal(workspace.base, "origin/release/stable");
		assert.equal(git(workspace.path, "rev-parse", "HEAD"), tip);
		assert.equal(git(workspace.path, "branch", "--show-current"), "");
		assert.equal(readFileSync(join(workspace.path, "a.txt"), "utf8"), "selected tip\n");
		git(workspace.path, "switch", "--quiet", "-c", "agent-topic");
		writeFileSync(join(workspace.path, "a.txt"), "agent edit\n");
		const changes = await collectChanges(workspace.path, workspace.base);
		assert.match(changes.base, /^origin\/release\/stable/);
		assert.match(changes.diff, /-selected tip\n\+agent edit/);
		assert.doesNotMatch(changes.diff, /-main/);
		assert.equal(git(source, "show-ref"), refs);
		assert.equal(readFileSync(join(source, "a.txt"), "utf8"), "user dirty\n");
		// These are real head names, not remote-tracking refs, full ref paths or command options.
		const literalNames = ["origin/main", "refs/heads/main", "--upload-pack=bad"];
		git(publisher, "push", "--quiet", "origin", ...literalNames.map((name) => `HEAD:refs/heads/${name}`));
		const advertised = await listRemoteBranches(source);
		assert.deepEqual(advertised.branches, [
			"--upload-pack=bad",
			"main",
			"origin/main",
			"refs/heads/main",
			"release/stable",
		]);
		for (const [index, name] of advertised.branches.entries()) {
			const selected = await createWorkspace(source, join(root, `literal-${index}`), undefined, undefined, name);
			assert.equal(selected.base, `origin/${name}`);
			assert.equal(git(selected.path, "rev-parse", "HEAD"), git(remote, "rev-parse", `refs/heads/${name}`));
		}
		assert.equal(git(source, "show-ref"), refs);
		assert.equal(readFileSync(join(source, "a.txt"), "utf8"), "user dirty\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("explicit bases reject deleted, missing, local-only, tag-only and invalid references instead of falling back", async () => {
	const root = mkdtempSync(join(tmpdir(), "pilot-invalid-base-"));
	try {
		const remote = join(root, "remote.git");
		const source = join(root, "source");
		git(root, "init", "--quiet", "--bare", "-b", "main", remote);
		git(root, "clone", "--quiet", remote, source);
		writeFileSync(join(source, "a.txt"), "base\n");
		git(source, "add", ".");
		git(source, "commit", "--quiet", "-m", "base");
		git(source, "push", "--quiet", "origin", "HEAD:main", "HEAD:deleted");
		git(source, "push", "--quiet", "origin", ":deleted");
		git(source, "update-ref", "refs/remotes/origin/deleted", "HEAD");
		git(source, "branch", "local-only");
		git(source, "tag", "tag-only");
		git(source, "push", "--quiet", "origin", "tag-only");
		let index = 0;
		for (const name of [
			"deleted",
			"nonexistent",
			"local-only",
			"tag-only",
			"origin/main",
			"refs/heads/main",
			"--upload-pack=bad",
			git(source, "rev-parse", "HEAD"),
		])
			await assert.rejects(
				createWorkspace(source, join(root, `w${index++}`), undefined, undefined, name),
				/Origin branch unavailable/,
			);
		for (const name of [
			"",
			"HEAD",
			"main~1",
			"main^{commit}",
			"main:other",
			"a..b",
			"a b",
			"a\n",
			"@{-1}",
			"a*",
			"a.lock",
		])
			await assert.rejects(
				createWorkspace(source, join(root, `w${index++}`), undefined, undefined, name),
				/valid exact origin branch name/,
			);
		rmSync(remote, { recursive: true, force: true });
		await assert.rejects(
			createWorkspace(source, join(root, `w${index++}`), undefined, undefined, "main"),
			/Origin branch unavailable/,
		);
		git(source, "remote", "remove", "origin");
		await assert.rejects(
			createWorkspace(source, join(root, `w${index++}`), undefined, undefined, "main"),
			/no origin remote/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("clones a project into a private workspace detached from the remote default, leaving the branch choice to the agent", async () => {
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
		const workspace = await createWorkspace(source, destination);
		assert.equal(workspace.branch, undefined);
		assert.equal(workspace.base, "origin/main");
		assert.equal(workspace.upstream, remote);
		assert.equal(workspace.jj, false);
		assert.equal(git(destination, "branch", "--show-current"), "");
		assert.equal(await workspaceBranch(destination), undefined);
		git(destination, "switch", "--quiet", "-c", "fix-readme");
		assert.equal(await workspaceBranch(destination), "fix-readme");
		assert.equal(git(destination, "remote", "get-url", "origin"), remote);
		assert.equal(readFileSync(join(destination, "README.md"), "utf8"), "hello\n");
		assert.ok(existsSync(join(source, "README.md")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("workspaces borrow the source's objects, then become self-contained after dissociation", async () => {
	const root = mkdtempSync(join(tmpdir(), "pilot-ws-dissociate-"));
	try {
		const remote = join(root, "remote.git");
		const source = join(root, "source");
		git(root, "init", "--quiet", "--bare", "-b", "main", remote);
		git(root, "clone", "--quiet", remote, source);
		for (const content of ["one\n", "two\n"]) {
			writeFileSync(join(source, "README.md"), content);
			git(source, "add", ".");
			git(source, "commit", "--quiet", "-m", content.trim());
		}
		git(source, "push", "--quiet", "origin", "HEAD:main");
		const workspace = await createWorkspace(source, join(root, "workspace"));
		assert.equal(workspaceBorrowsObjects(workspace.path), true);
		// Nothing was copied: every commit object lives in the source.
		assert.equal(git(workspace.path, "count-objects", "-v").match(/^in-pack: (\d+)/m)?.[1], "0");
		assert.equal(await dissociateWorkspace(workspace.path), true);
		assert.equal(workspaceBorrowsObjects(workspace.path), false);
		assert.equal(await dissociateWorkspace(workspace.path), true, "dissociation is idempotent");
		rmSync(source, { recursive: true, force: true });
		rmSync(remote, { recursive: true, force: true });
		git(workspace.path, "fsck", "--connectivity-only", "--no-dangling");
		assert.equal(git(workspace.path, "log", "--format=%s", "HEAD"), "two\none");
		assert.equal(readFileSync(join(workspace.path, "README.md"), "utf8"), "two\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("refuses folders that are not git repositories", async () => {
	const root = mkdtempSync(join(tmpdir(), "pilot-ws-"));
	try {
		await assert.rejects(createWorkspace(root, join(root, "w")), /not a git repository/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("local-only clones pin their base before the agent creates and commits on a branch", async () => {
	const root = mkdtempSync(join(tmpdir(), "pilot-ws-local-"));
	try {
		const source = join(root, "source");
		git(root, "init", "--quiet", "-b", "main", source);
		writeFileSync(join(source, "README.md"), "base\n");
		git(source, "add", ".");
		git(source, "commit", "--quiet", "-m", "init");
		const base = git(source, "rev-parse", "HEAD");
		const workspace = await createWorkspace(source, join(root, "workspace"));
		assert.equal(workspace.base, base);
		assert.equal(await workspaceBranch(workspace.path), undefined);
		git(workspace.path, "switch", "--quiet", "-c", "improve-readme");
		writeFileSync(join(workspace.path, "README.md"), "updated\n");
		git(workspace.path, "commit", "--quiet", "-am", "update");
		assert.notEqual(git(workspace.path, "rev-parse", "HEAD"), workspace.base);
		assert.equal(git(source, "branch", "--show-current"), "main");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("jj clones inherit no task bookmark and detect the agent's chosen bookmark after commits", {
	skip: !hasJj,
}, async () => {
	const root = mkdtempSync(join(tmpdir(), "pilot-ws-jj-"));
	try {
		const remote = join(root, "remote.git");
		const source = join(root, "source");
		git(root, "init", "--quiet", "--bare", "-b", "main", remote);
		git(root, "clone", "--quiet", remote, source);
		writeFileSync(join(source, "README.md"), "base\n");
		git(source, "add", ".");
		git(source, "commit", "--quiet", "-m", "init");
		git(source, "push", "--quiet", "origin", "HEAD:main");
		jj(source, "git", "init", "--colocate");
		const workspace = await createWorkspace(source, join(root, "workspace"));
		assert.equal(workspace.jj, true);
		assert.equal(await workspaceBranch(workspace.path), undefined);
		assert.equal(jj(workspace.path, "bookmark", "list"), "");
		jj(workspace.path, "bookmark", "create", "fix-readme", "-r", "@");
		assert.equal(await workspaceBranch(workspace.path), "fix-readme");
		writeFileSync(join(workspace.path, "README.md"), "updated\n");
		jj(workspace.path, "commit", "-m", "update");
		jj(workspace.path, "bookmark", "set", "fix-readme", "-r", "@-");
		assert.equal(await workspaceBranch(workspace.path), "fix-readme");
		jj(workspace.path, "bookmark", "create", "other-fix", "-r", "@-");
		assert.equal(await workspaceBranch(workspace.path), undefined, "ambiguous bookmarks must not be guessed");
		assert.equal(await workspaceBranch(workspace.path, "fix-readme"), "fix-readme");
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

			await createWorkspace(source, destination);
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

		await createWorkspace(source, destination);
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

		await createWorkspace(source, destination);
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

test("cancelled fetch never proceeds to checkout", async () => {
	const root = mkdtempSync(join(tmpdir(), "pilot-ws-cancel-"));
	const signal = new AbortController();
	const commands: string[] = [];
	await assert.rejects(
		createWorkspace(
			root,
			join(root, "destination"),
			async (_file, args, _cwd, _timeout, received) => {
				assert.equal(received, signal.signal);
				commands.push(args.find((arg) => !arg.startsWith("-") && !arg.includes("="))!);
				if (args[0] === "rev-parse") return "true";
				if (args[0] === "remote" && args[1] === "get-url") return "remote";
				if (args.includes("fetch") && args.includes("origin")) {
					signal.abort();
					throw new Error("aborted fetch");
				}
				return "";
			},
			signal.signal,
		),
	);
	rmSync(root, { recursive: true, force: true });
	assert.equal(commands.includes("checkout"), false);
});

test("aborting workspace preparation waits for its fetch process and helpers to close", {
	skip: process.platform === "win32",
	timeout: 20_000,
}, async () => {
	const root = mkdtempSync(join(tmpdir(), "pilot-ws-abort-"));
	const bin = join(root, "bin");
	mkdirSync(bin);
	const helperPid = join(root, "helper.pid");
	const fetchPid = join(root, "fetch.pid");
	const fetchScript = join(root, "fetch.cjs");
	const helper = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(helperPid)}, String(process.pid)); setInterval(() => {}, 1000);`;
	writeFileSync(
		fetchScript,
		`
const fs = require('node:fs');
process.on('SIGTERM', () => {});
fs.writeFileSync(${JSON.stringify(fetchPid)}, String(process.pid));
require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], { stdio: 'inherit' })
 .once('error', error => { console.error(error); process.exit(1); });
setInterval(() => {}, 1000);
`,
	);
	writeFileSync(
		join(bin, "git"),
		`#!/bin/sh
case "$1" in
 rev-parse) echo true ;;
 remote) if [ "$2" = get-url ]; then echo fake-upstream; fi ;;
 -c) exec "${process.execPath}" "${fetchScript}" ;;
 fetch) exec "${process.execPath}" "${fetchScript}" ;;
esac
`,
		{ mode: 0o700 },
	);
	const oldPath = process.env.PATH;
	process.env.PATH = `${bin}:${oldPath}`;
	const signal = new AbortController();
	const preparing = createWorkspace(root, join(root, "workspace"), undefined, signal.signal);
	let completed = false;
	let preparationError: unknown;
	preparing.then(
		() => {
			completed = true;
		},
		(error) => {
			completed = true;
			preparationError = error;
		},
	);
	try {
		// Wait for the helper's own handshake, after its SIGTERM handler is installed.
		// Shell builtins above avoid several cold Node starts unrelated to the cancellation assertion.
		const deadline = Date.now() + 10_000;
		while (!existsSync(helperPid)) {
			assert.equal(completed, false, `Preparation ended before helper startup: ${String(preparationError)}`);
			assert.ok(Date.now() < deadline, "fetch helper did not start");
			await delay(5);
		}
		signal.abort();
		await assert.rejects(preparing, /aborted/);
		for (const file of [fetchPid, helperPid]) {
			const pid = Number(readFileSync(file, "utf8"));
			// A terminated helper can briefly remain a zombie until its new parent reaps it.
			const reapingDeadline = Date.now() + 3_000;
			for (;;) {
				try {
					process.kill(pid, 0);
				} catch (error) {
					assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
					break;
				}
				assert.ok(Date.now() < reapingDeadline, `Cancelled process ${pid} was not reaped`);
				await delay(5);
			}
		}
	} finally {
		signal.abort();
		await preparing.catch(() => undefined);
		process.env.PATH = oldPath;
		rmSync(root, { recursive: true, force: true });
	}
});
