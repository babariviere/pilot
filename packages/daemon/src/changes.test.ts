import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectChanges } from "./changes.ts";

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
		git(root, "switch", "--quiet", "-c", "pilot/x");
		writeFileSync(join(root, "a.txt"), "one\n2\nthree\n");
		git(root, "commit", "--quiet", "-am", "edit");
		unlinkSync(join(root, "gone.txt"));
		writeFileSync(join(root, "new.txt"), "fresh\n");

		const changes = await collectChanges(root, "main");
		assert.equal(changes.branch, "pilot/x");
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
