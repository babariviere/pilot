import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProjectStore } from "./projects.ts";
import { RepositoryBrowser } from "./repository-browser.ts";

test("directory selection is server scoped and paged; file paths cannot escape or follow symlinks", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-repository-browser-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const root = join(home, "root");
	const outside = join(home, "outside");
	await mkdir(root);
	await mkdir(outside);
	await writeFile(join(outside, "secret"), "private");
	await symlink(outside, join(root, "link"));
	await Promise.all(Array.from({ length: 105 }, (_, n) => mkdir(join(root, `dir-${n.toString().padStart(3, "0")}`))));
	await mkdir(join(root, ".hidden"));
	const projects = new ProjectStore(home);
	const browser = new RepositoryBrowser(projects, root);
	const first = await browser.directory({ rootId: "home", path: "" });
	assert.equal(first.entries.length, 100);
	assert.equal(first.nextOffset, 100);
	assert.ok(first.entries.every((entry) => !entry.name.startsWith(".") && entry.name !== "link"));
	const last = await browser.directory({ rootId: "home", path: "" }, 100);
	assert.equal(last.entries.length, 5);
	assert.equal(last.nextOffset, undefined);
	assert.equal(await browser.selection({ rootId: "home", path: "dir-000" }), await realpath(join(root, "dir-000")));
	for (const path of [
		"../outside/secret",
		"/etc/passwd",
		"link/secret",
		"dir-000/../../outside/secret",
		"x\\y",
		".",
	]) {
		await assert.rejects(browser.file(root, path));
		await assert.rejects(browser.selection({ rootId: "home", path }));
	}
	await assert.rejects(browser.directory({ rootId: "missing-host-project", path: "" }));
});
test("files are bounded regular-file snapshots, with binary data suppressed", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-file-reader-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const browser = new RepositoryBrowser(new ProjectStore(home), home);
	await writeFile(join(home, "large.txt"), "x".repeat(600 * 1024));
	await writeFile(join(home, "binary"), Buffer.from([0, 1, 2]));
	const large = await browser.file(home, "large.txt");
	assert.equal(large.text.length, 512 * 1024);
	assert.equal(large.truncated, true);
	assert.deepEqual(await browser.file(home, "binary"), { path: "binary", text: "", binary: true, truncated: false });
	await assert.rejects(browser.file(home, ""));
});
test("same paths on distinct daemon roots never share projects or file content", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-root-isolation-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	for (const host of ["local", "remote"]) {
		await mkdir(join(home, host, "repo"), { recursive: true });
		await writeFile(join(home, host, "repo", "same.txt"), host);
	}
	const local = new RepositoryBrowser(new ProjectStore(join(home, "local")), join(home, "local"));
	const remote = new RepositoryBrowser(new ProjectStore(join(home, "remote")), join(home, "remote"));
	assert.equal((await local.file(join(home, "local", "repo"), "same.txt")).text, "local");
	assert.equal((await remote.file(join(home, "remote", "repo"), "same.txt")).text, "remote");
	await assert.rejects(remote.file(join(home, "remote", "repo"), "../../local/repo/same.txt"));
});
