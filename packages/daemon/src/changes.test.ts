import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectChangeSummary, collectChanges } from "./changes.ts";

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
