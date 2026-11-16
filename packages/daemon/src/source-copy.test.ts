// biome-ignore-all lint/complexity/useLiteralKeys: Exercise session admission and idle refresh without a model.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProjectStore } from "./projects.ts";
import { SessionManager } from "./sessions.ts";
import { copyGitSeed } from "./testing/git-seed.ts";
import { run } from "./workspaces.ts";

test("native source policy pins jj preparation and gives Ask a read-only main view, not dirty user files", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "local-admission-")));
	const remote = join(root, "upstream"),
		source = join(root, "source"),
		folder = join(root, "notes");
	copyGitSeed(remote, { "file.txt": "committed\n" });
	await run("git", ["clone", "--quiet", remote, source], root);
	await run("git", ["remote", "set-url", "origin", "../upstream"], source);
	await mkdir(folder);
	await writeFile(join(source, "file.txt"), "dirty user edit\n");
	const projects = new ProjectStore(join(root, "home"));
	await projects.load();
	const p = await projects.previewLocal(source),
		n = await projects.previewLocal(folder);
	const isolated = await projects.createLocal(p.path, p.digest),
		direct = await projects.createLocal(n.path, n.digest);
	const sessions = new SessionManager(join(root, "home"), projects, undefined, { title: async () => undefined });
	Object.defineProperty(sessions, "start", { value: async () => new Map() });
	t.after(async () => {
		await sessions.shutdown();
		await run("chmod", ["-R", "u+w", root], root);
		await rm(root, { recursive: true, force: true });
	});
	await sessions.load();
	const build = await sessions.spawn({ projectId: isolated.id, message: "Code", model: "fake/model" });
	const meta = JSON.parse(await readFile(join(root, "home", "sessions", build.id, "meta.json"), "utf8"));
	assert.equal(meta.preparing.jj, true);
	assert.notEqual(meta.cwd, source);
	await assert.rejects(
		sessions.spawn({ projectId: isolated.id, message: "Code", workspace: "direct" }),
		/source copy/,
	);
	await assert.rejects(sessions.spawn({ projectId: isolated.id, message: "Code", cwd: source }), /cwd override/);
	const ask = await sessions.spawn({ projectId: isolated.id, message: "Read", mode: "ask", model: "fake/model" });
	assert.notEqual(ask.cwd, source);
	assert.equal(await readFile(join(ask.cwd, "file.txt"), "utf8"), "committed\n");
	const askMeta = JSON.parse(await readFile(join(root, "home", "sessions", ask.id, "meta.json"), "utf8"));
	assert.equal(askMeta.ask.sourceOnly, true);
	const own = await sessions.spawn({ projectId: direct.id, message: "Code", model: "fake/model" });
	assert.equal(own.cwd, n.path);
	assert.equal(await readFile(join(source, "file.txt"), "utf8"), "dirty user edit\n");
	const workspace = await sessions["sharedWorkspaces"].create(source, meta.cwd);
	const live = sessions["require"](build.id);
	live.workspace = { ...workspace, source: p.path };
	delete live.preparing;
	delete live.initializing;
	live.pending = [];
	await sessions["save"](live);
	assert.deepEqual(
		sessions["mainProjects"]().map((p) => p.id),
		[isolated.id],
		"standalone native copies subscribe to main refresh",
	);
	await writeFile(join(remote, "file.txt"), "new main\n");
	await run(
		"git",
		["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-am", "Update main"],
		remote,
	);
	await sessions["refreshMainWorkspace"](build.id);
	assert.equal(
		await readFile(join(meta.cwd, "file.txt"), "utf8"),
		"new main\n",
		live.workspaceBehind ?? "Idle copy should refresh",
	);
	await writeFile(join(meta.cwd, "file.txt"), "unpublished agent edit\n");
	await writeFile(join(remote, "file.txt"), "another main\n");
	await run(
		"git",
		["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-am", "Advance main"],
		remote,
	);
	await sessions["refreshMainWorkspace"](build.id);
	assert.equal(await readFile(join(meta.cwd, "file.txt"), "utf8"), "unpublished agent edit\n");
	assert.ok(live.workspaceBehind, "unpublished work is kept, not overwritten");
});

test("local setup uses the user's folder without a remote and private jj with any named remote", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "local-source-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const source = join(root, "source");
	await mkdir(source);
	const store = new ProjectStore(join(root, "home"));
	await store.load();
	const folder = await store.previewLocal(source);
	assert.equal(folder.copy, "folder");
	const direct = await store.createLocal(folder.path, folder.digest);
	assert.equal(direct.workspace, "direct");
	assert.equal(direct.sourceCopy, "folder");
	execFileSync("git", ["init", "--quiet", source]);
	execFileSync("git", ["-C", source, "remote", "add", "upstream", "https://example.test/repo.git"]);
	const git = await store.previewLocal(source);
	assert.equal(git.copy, "jj");
	assert.notEqual(git.digest, folder.digest);
	await assert.rejects(store.createLocal(source, folder.digest), /Source changed/);
	await store.remove(direct.id);
	const isolated = await store.createLocal(source, git.digest);
	assert.equal(isolated.sourceCopy, "jj");
	assert.equal(isolated.workspace, undefined);
	const config = await readFile(join(source, ".git/config"), "utf8");
	assert.ok(!config.includes("pilot"));
	const reloaded = new ProjectStore(join(root, "home"));
	await reloaded.load();
	assert.equal(reloaded.require(isolated.id).sourceCopy, "jj");
	await assert.rejects(reloaded.update(isolated.id, { workspace: "direct" }), /source policy changed/);
	const sub = join(source, "sub");
	await mkdir(sub);
	await assert.rejects(store.previewLocal(sub), /repository root/);
	await writeFile(join(source, "dirty.txt"), "local edits");
	assert.equal((await store.previewLocal(source)).digest, git.digest, "local edits do not change source identity");
});
