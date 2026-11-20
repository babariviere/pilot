import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discardDirectory } from "./discard-directory.ts";

test("private discard handles read-only generated directories without changing symlink targets", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-discard-"));
	t.after(async () => {
		await chmod(join(root, "external"), 0o700);
		await rm(root, { recursive: true, force: true });
	});
	const workspace = join(root, "workspace");
	const generated = join(workspace, ".private-pnpm", "mbx", "out-dirs");
	const external = join(root, "external");
	await mkdir(generated, { recursive: true });
	await mkdir(external);
	await writeFile(join(generated, "output"), "discard");
	await writeFile(join(external, "keep"), "not private work");
	await symlink(external, join(generated, "linked"));
	await chmod(external, 0o500);
	await chmod(generated, 0o500);
	await chmod(join(workspace, ".private-pnpm"), 0o500);
	await discardDirectory(workspace);
	await assert.rejects(lstat(workspace), { code: "ENOENT" });
	assert.equal(await readFile(join(external, "keep"), "utf8"), "not private work");
	assert.equal((await lstat(external)).mode & 0o777, 0o500);
	await discardDirectory(workspace); // Missing/partly removed directories are safe to retry.
});
