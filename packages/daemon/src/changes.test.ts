import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectChangeSummary, collectChanges, RepositoryChanges } from "./changes.ts";
import { type ProcessOptions, subprocesses } from "./subprocess.ts";

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
	});

test("untracked stats match Git attributes, drivers, thresholds and symlinks without per-file Git", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pilot-untracked-git-parity-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	git(root, "init", "--quiet", "-b", "main");
	writeFileSync(
		join(root, ".gitattributes"),
		"*.forced diff\n*.binary -diff\n*.custom diff=custom\n*.text-driver diff=text-driver\n",
	);
	git(root, "add", ".");
	git(root, "commit", "--quiet", "-m", "base");
	git(root, "config", "diff.custom.binary", "true");
	git(root, "config", "diff.text-driver.binary", "false");
	git(root, "config", "core.bigFileThreshold", "1k");
	const contents = new Map<string, string | Buffer>([
		["plain", "one\r\ntwo"],
		["empty", ""],
		["nul", Buffer.from([0, 10])],
		["text.forced", Buffer.from([0, 10, 97])],
		["text.binary", "one\ntwo\n"],
		["text.custom", "one\ntwo\n"],
		["nul.text-driver", Buffer.from([0, 10, 97])],
		["large", "one\n".repeat(1024)],
		["late-nul.forced", `${"a".repeat(8000)}\0\nlast`],
	]);
	for (const [path, content] of contents) writeFileSync(join(root, path), content);
	symlinkSync("missing\nexternal-target", join(root, "link.binary"));
	let additions = 0;
	for (const path of [...contents.keys(), "link.binary"]) {
		let output: string;
		try {
			output = git(
				root,
				"diff",
				"--no-ext-diff",
				"--no-textconv",
				"--numstat",
				"-z",
				"--no-index",
				"--",
				"/dev/null",
				path,
			);
		} catch (error) {
			output = (error as { stdout: string }).stdout;
		}
		additions += Number(output.split("\t")[0]) || 0;
	}
	const run = subprocesses.run.bind(subprocesses);
	const commands: string[][] = [];
	t.mock.method(subprocesses, "run", (file: string, args: string[], options: ProcessOptions) => {
		if (file === "git") commands.push(args);
		return run(file, args, options);
	});
	const summary = await collectChangeSummary(root);
	assert.equal(summary.fileCount, contents.size + 1);
	assert.equal(summary.additions, additions);
	assert.equal(summary.deletions, 0);
	assert.equal(commands.filter((args) => args.includes("--no-index")).length, 0);
});

test("reports committed, uncommitted and untracked changes since the base", async () => {
	const root = mkdtempSync(join(tmpdir(), "pilot-changes-"));
	try {
		git(root, "init", "--quiet", "-b", "main");
		writeFileSync(join(root, "a.txt"), "one\ntwo\n");
		writeFileSync(join(root, "gone.txt"), "bye\n");
		git(root, "add", ".");
		git(root, "commit", "--quiet", "-m", "base");
		git(root, "switch", "--quiet", "--detach", "main");
		assert.equal((await collectChanges(root, "main")).branch, undefined);
		git(root, "switch", "--quiet", "-c", "fix-reopen-race");
		writeFileSync(join(root, "a.txt"), "one\n2\nthree\n");
		git(root, "commit", "--quiet", "-am", "edit");
		unlinkSync(join(root, "gone.txt"));
		writeFileSync(join(root, "new.txt"), "fresh\n");

		const changes = await collectChanges(root, "main");
		assert.equal(changes.branch, "fix-reopen-race");
		assert.deepEqual(
			changes.files.map((f) => [f.path, f.status, f.additions, f.deletions]),
			[
				["a.txt", "modified", 2, 1],
				["gone.txt", "deleted", 0, 1],
				["new.txt", "untracked", 1, 0],
			],
		);
		assert.match(changes.diff, /\+three/);
		assert.match(changes.diff, /\+fresh/);
		assert.equal(changes.truncated, false);
		assert.deepEqual(await collectChangeSummary(root, "main"), {
			base: changes.base,
			branch: changes.branch,
			fileCount: changes.files.length,
			additions: changes.files.reduce((total, file) => total + file.additions, 0),
			deletions: changes.files.reduce((total, file) => total + file.deletions, 0),
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a session rebased onto a newer base branch only reports its own changes", async () => {
	const root = mkdtempSync(join(tmpdir(), "pilot-changes-rebased-"));
	try {
		git(root, "init", "--quiet", "-b", "main");
		writeFileSync(join(root, "a.txt"), "base\n");
		git(root, "add", ".");
		git(root, "commit", "--quiet", "-m", "base");
		const created = git(root, "rev-parse", "HEAD").trim();
		git(root, "update-ref", "refs/remotes/origin/main", created);
		// Upstream lands work after the session was created, and the session rebases onto it.
		writeFileSync(join(root, "upstream.txt"), "one\ntwo\n");
		git(root, "add", ".");
		git(root, "commit", "--quiet", "-m", "upstream");
		const latest = git(root, "rev-parse", "HEAD").trim();
		git(root, "switch", "--quiet", "-c", "session");
		writeFileSync(join(root, "mine.txt"), "mine\n");
		git(root, "add", ".");
		git(root, "commit", "--quiet", "-m", "mine");

		// The remote-tracking ref is behind the session's base: never widen the diff.
		const stale = await collectChangeSummary(root, created, "main");
		assert.equal(stale.fileCount, 2);
		assert.equal(stale.base, created);

		git(root, "update-ref", "refs/remotes/origin/main", latest);
		const summary = await collectChangeSummary(root, created, "main");
		assert.deepEqual(summary, {
			base: `origin/main (${latest.slice(0, 8)})`,
			branch: "session",
			fileCount: 1,
			additions: 1,
			deletions: 0,
		});
		const changes = await collectChanges(root, created, "main");
		assert.deepEqual(
			changes.files.map((file) => file.path),
			["mine.txt"],
		);
		assert.doesNotMatch(changes.diff, /upstream\.txt/);
		// Without a base branch, the pinned creation base still applies.
		assert.equal((await collectChangeSummary(root, created)).fileCount, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("summary counts NUL-delimited tracked and untracked paths, renames once, and excludes ignored files", async () => {
	const root = mkdtempSync(join(tmpdir(), "pilot-changes-summary-"));
	try {
		git(root, "init", "--quiet", "-b", "main");
		for (const path of ["modified\tfile.txt", "deleted\nfile.txt", 'old"é.txt', "recreated.txt"])
			writeFileSync(join(root, path), `${path}\n`);
		writeFileSync(join(root, ".gitignore"), "ignored*\n");
		git(root, "add", ".");
		git(root, "commit", "--quiet", "-m", "base");
		const base = git(root, "rev-parse", "HEAD").trim();
		assert.deepEqual(await collectChangeSummary(root, base), {
			base,
			branch: "main",
			fileCount: 0,
			additions: 0,
			deletions: 0,
		});

		renameSync(join(root, 'old"é.txt'), join(root, "renamed\n\tfile.txt"));
		git(root, "add", "-A");
		writeFileSync(join(root, "modified\tfile.txt"), "changed\n");
		unlinkSync(join(root, "deleted\nfile.txt"));
		writeFileSync(join(root, "added\n\tfile.txt"), "staged\n");
		git(root, "add", "--", "added\n\tfile.txt");
		writeFileSync(join(root, 'untracked\n\t"é.txt'), "untracked\n");
		writeFileSync(join(root, "ignored\nfile.txt"), "ignored\n");
		// A staged deletion recreated as untracked is still only one changed path.
		git(root, "rm", "--quiet", "--", "recreated.txt");
		writeFileSync(join(root, "recreated.txt"), "replacement\n");
		assert.deepEqual(await collectChangeSummary(root, base), {
			base,
			branch: "main",
			fileCount: 6,
			additions: 4,
			deletions: 3,
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("summary reads every numstat record, including renames with numeric tabs and newlines in paths", async () => {
	const root = mkdtempSync(join(tmpdir(), "pilot-changes-summary-numstat-"));
	try {
		git(root, "init", "--quiet", "-b", "main");
		const oldPath = "17\t23\told\nname.txt";
		const newPath = "7\t9\tnew\nname.txt";
		const modifiedPath = "42\t53\nmodified.txt";
		writeFileSync(join(root, oldPath), "one\ntwo\nthree\nfour\nfive\nsix\n");
		writeFileSync(join(root, modifiedPath), "old\nlines\n");
		git(root, "add", ".");
		git(root, "commit", "--quiet", "-m", "base");
		const base = git(root, "rev-parse", "HEAD").trim();
		renameSync(join(root, oldPath), join(root, newPath));
		writeFileSync(join(root, newPath), "one\ntwo\nthree\nfour\nfive\nchanged\nextra\n");
		git(root, "add", "-A");
		writeFileSync(join(root, modifiedPath), "replacement\n");
		writeFileSync(join(root, "99\t100\nuntracked.txt"), "first\nlast");
		assert.ok(git(root, "diff", "--numstat", "-z", "-M", base).includes(`2\t1\t\0${oldPath}\0${newPath}\0`));
		// The rename contributes 2/1, the modified file 1/2, and the untracked file 2/0.
		assert.deepEqual(await collectChangeSummary(root, base), {
			base,
			branch: "main",
			fileCount: 3,
			additions: 5,
			deletions: 3,
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("summary counts binary files without line statistics and empty untracked files without additions", async () => {
	const root = mkdtempSync(join(tmpdir(), "pilot-changes-summary-binary-"));
	try {
		git(root, "init", "--quiet", "-b", "main");
		writeFileSync(join(root, "tracked.bin"), Buffer.from([0, 1, 2]));
		git(root, "add", ".");
		git(root, "commit", "--quiet", "-m", "base");
		const base = git(root, "rev-parse", "HEAD").trim();
		writeFileSync(join(root, "tracked.bin"), Buffer.from([0, 3, 4]));
		writeFileSync(join(root, "untracked.bin"), Buffer.from([0, 5, 6]));
		writeFileSync(join(root, "empty.txt"), "");
		assert.deepEqual(await collectChangeSummary(root, base), {
			base,
			branch: "main",
			fileCount: 3,
			additions: 0,
			deletions: 0,
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("summary replaces staged deletion statistics when the path is recreated as untracked", async () => {
	const root = mkdtempSync(join(tmpdir(), "pilot-changes-summary-recreated-"));
	try {
		git(root, "init", "--quiet", "-b", "main");
		writeFileSync(join(root, "recreated.txt"), "old\nlines\n");
		git(root, "add", ".");
		git(root, "commit", "--quiet", "-m", "base");
		git(root, "rm", "--quiet", "--", "recreated.txt");
		writeFileSync(join(root, "recreated.txt"), "new\nlast");
		const changes = await collectChanges(root);
		assert.deepEqual(changes.files, [{ path: "recreated.txt", status: "untracked", additions: 2, deletions: 0 }]);
		assert.deepEqual(await collectChangeSummary(root), {
			base: changes.base,
			branch: changes.branch,
			fileCount: 1,
			additions: 2,
			deletions: 0,
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("summary shares merge-base semantics with changes and omits a detached branch", async () => {
	const root = mkdtempSync(join(tmpdir(), "pilot-changes-summary-base-"));
	try {
		git(root, "init", "--quiet", "-b", "main");
		writeFileSync(join(root, "a.txt"), "base\n");
		git(root, "add", ".");
		git(root, "commit", "--quiet", "-m", "base");
		const base = git(root, "rev-parse", "HEAD").trim();
		git(root, "switch", "--quiet", "-c", "pilot/x");
		writeFileSync(join(root, "a.txt"), "session\n");
		git(root, "commit", "--quiet", "-am", "session edit");
		git(root, "switch", "--quiet", "main");
		writeFileSync(join(root, "upstream.txt"), "upstream\n");
		git(root, "add", ".");
		git(root, "commit", "--quiet", "-m", "upstream edit");
		git(root, "switch", "--quiet", "pilot/x");
		const changes = await collectChanges(root, "main");
		assert.deepEqual(await collectChangeSummary(root, "main"), {
			base: `main (${base.slice(0, 8)})`,
			branch: changes.branch,
			fileCount: changes.files.length,
			additions: 1,
			deletions: 1,
		});
		assert.equal(changes.files.length, 1);
		git(root, "checkout", "--quiet", "--detach");
		const detached = await collectChanges(root);
		assert.deepEqual(await collectChangeSummary(root), {
			base: detached.base,
			fileCount: 0,
			additions: 0,
			deletions: 0,
		});
		await assert.rejects(collectChangeSummary(root, "missing-base"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("summary rejects directories that are not Git repositories", async () => {
	const root = mkdtempSync(join(tmpdir(), "pilot-changes-summary-no-git-"));
	try {
		await assert.rejects(collectChangeSummary(root), /Not a git repository/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

for (const setting of ["diff.mnemonicPrefix", "diff.noprefix"]) {
	test(`uses client-compatible diff paths with ${setting} enabled`, async () => {
		const root = mkdtempSync(join(tmpdir(), "pilot-changes-prefix-"));
		try {
			git(root, "init", "--quiet", "-b", "main");
			git(root, "config", setting, "true");
			writeFileSync(join(root, "a.txt"), "old\n");
			writeFileSync(join(root, "gone.txt"), "bye\n");
			git(root, "add", ".");
			git(root, "commit", "--quiet", "-m", "base");
			writeFileSync(join(root, "a.txt"), "new\n");
			unlinkSync(join(root, "gone.txt"));
			writeFileSync(join(root, "fresh.txt"), "fresh\n");

			const changes = await collectChanges(root);
			assert.deepEqual(
				changes.files.map((file) => file.path),
				["a.txt", "fresh.txt", "gone.txt"],
			);
			for (const path of ["a.txt", "fresh.txt", "gone.txt"]) {
				assert.ok(changes.diff.includes(`diff --git a/${path} b/${path}\n`), changes.diff);
			}
			assert.ok(changes.diff.includes("+++ b/a.txt\n"));
			assert.ok(changes.diff.includes("+++ b/fresh.txt\n"));
			assert.match(changes.diff, /\n-old\n\+new\n/);
			assert.match(changes.diff, /\n\+fresh\n/);
			assert.match(changes.diff, /\n-bye\n/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}

test("repository cache coalesces both endpoints and revalidates external edits and commits after its short TTL", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pilot-changes-cache-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	t.mock.timers.enable({ apis: ["Date"], now: 0 });
	git(root, "init", "--quiet", "-b", "main");
	writeFileSync(join(root, "a.txt"), "base\n");
	git(root, "add", ".");
	git(root, "commit", "--quiet", "-m", "base");
	const base = git(root, "rev-parse", "HEAD").trim();
	const cache = new RepositoryChanges();
	const summary = cache.summary(root);
	const full = cache.changes(root);
	assert.equal(cache.summary(root), summary);
	assert.equal(cache.changes(root), full);
	assert.equal((await summary).fileCount, 0);
	assert.equal((await full).files.length, 0);
	writeFileSync(join(root, "a.txt"), "edited\nmore\n");
	writeFileSync(join(root, "outside.txt"), "external\n");
	assert.equal((await cache.summary(root)).fileCount, 0);
	t.mock.timers.tick(1000);
	assert.equal((await cache.summary(root)).fileCount, 2);
	assert.match((await cache.changes(root)).diff, /\+external/);
	git(root, "add", ".");
	git(root, "commit", "--quiet", "-m", "external commit");
	t.mock.timers.tick(1000);
	assert.equal((await cache.summary(root)).fileCount, 0, "HEAD is re-resolved rather than pinned by the cache");
	assert.equal((await cache.summary(root, base)).fileCount, 2, "base is part of the cache key");
	writeFileSync(join(root, "a.txt"), "session edit\n");
	cache.invalidate(root);
	assert.equal((await cache.summary(root)).fileCount, 1);
	assert.match((await cache.changes(root)).diff, /\+session edit/);
});

test("full changes preserve rename stats and unusual filenames", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pilot-changes-full-paths-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	git(root, "init", "--quiet", "-b", "main");
	const oldPath = "17\t23\told\nname.txt";
	const newPath = "7\t9\tnew\nname.txt";
	writeFileSync(join(root, oldPath), "one\ntwo\nthree\nfour\nfive\nsix\n");
	git(root, "add", ".");
	git(root, "commit", "--quiet", "-m", "base");
	renameSync(join(root, oldPath), join(root, newPath));
	writeFileSync(join(root, newPath), "one\ntwo\nthree\nfour\nfive\nchanged\nextra\n");
	git(root, "add", "-A");
	const changes = await collectChanges(root);
	assert.deepEqual(changes.files, [
		{ path: newPath, previousPath: oldPath, status: "renamed", additions: 2, deletions: 1 },
	]);
});
