import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveFeedbackPaths } from "./feedback-paths.ts";

test("only exact existing user roots qualify, not home, symlinks or metadata", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "feedback-paths-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "sub"));
	await mkdir(join(root, ".git"));
	await writeFile(join(root, "file"), "text");
	await symlink(join(root, "sub"), join(root, "link"));
	const paths = await resolveFeedbackPaths(
		[
			join(root, "sub"),
			join(root, "file"),
			join(root, "link"),
			join(root, ".git"),
			join(root, "missing"),
			homedir(),
		].join("\n"),
	);
	assert.deepEqual(
		paths.map((p) => [p.path, p.kind]),
		[
			[join(root, "sub"), "directory"],
			[join(root, "file"), "file"],
		],
	);
	assert.equal(paths[0]!.ino, (await lstat(join(root, "sub"))).ino);
});
