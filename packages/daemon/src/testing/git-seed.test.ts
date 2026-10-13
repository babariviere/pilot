import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { copyGitSeed } from "./git-seed.ts";

test("seed copies have independent Git metadata and working files, without alternates or shared jj state", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pilot-seed-isolation-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const a = join(root, "a"),
		b = join(root, "b"),
		c = join(root, "c");
	for (const path of [a, b]) copyGitSeed(path, { "file.txt": "base\n" });
	writeFileSync(join(a, "file.txt"), "changed\n");
	execFileSync("git", ["-C", a, "branch", "only-a"]);
	copyGitSeed(c, { "file.txt": "base\n" });
	for (const path of [b, c]) {
		assert.equal(readFileSync(join(path, "file.txt"), "utf8"), "base\n");
		assert.equal(execFileSync("git", ["-C", path, "branch", "--list", "only-a"], { encoding: "utf8" }), "");
		assert.throws(() => statSync(join(path, ".git", "objects", "info", "alternates")), /ENOENT/);
		assert.throws(() => statSync(join(path, ".jj")), /ENOENT/);
		assert.notEqual(statSync(join(a, ".git", "config")).ino, statSync(join(path, ".git", "config")).ino);
	}
});
