import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ModelCatalog } from "./models.ts";
import { projectOriginIdentity as identity } from "./project-origin.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";
import { run } from "./workspaces.ts";

test("origin identity folds SSH/HTTPS and GitHub case only, never credentials, forks or arbitrary path case", () => {
	const expected = identity("https://github.com/Owner/Repo");
	for (const url of [
		"git@github.com:owner/repo.git",
		"ssh://git@github.com:22/OWNER/REPO.git",
		"https://user:secret@github.com/owner/repo.git/",
		"https://github.com:443/owner/repo",
	])
		assert.equal(identity(url), expected);
	for (const url of [
		"https://github.com/fork/repo",
		"https://github.example.com/owner/repo",
		"ssh://git@github.com:2222/owner/repo",
	])
		assert.notEqual(identity(url), expected);
	assert.notEqual(identity("https://git.example.com/Owner/Repo"), identity("https://git.example.com/owner/repo"));
	assert.equal(identity("git@git.example.com:Group/Sub/Repo.git"), identity("https://git.example.com/Group/Sub/Repo"));
	for (const url of [
		"git@work:owner/repo",
		"",
		"/tmp/repo",
		"file:///tmp/repo",
		"https://x.test/a/../b/repo",
		"https://x.test/a/r?secret=yes",
		"git@x.test:a/repo\ngit@x.test:b/repo",
	])
		assert.equal(identity(url), null);
	assert.ok(!expected?.includes("secret"));
});

test("production origin route is bounded local config only, refreshes changes and never reads history or starts workers", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "project-origin-"));
	let origin = "git@github.com:owner/repo.git",
		calls = 0;
	const projects = new ProjectStore(directory, async (file, args, cwd, timeout) => {
		calls++;
		assert.equal(file, "git");
		assert.equal(cwd, directory);
		assert.equal(timeout, 2000);
		assert.deepEqual(args, ["config", "--local", "--no-includes", "--get-all", "remote.origin.url"]);
		return origin;
	});
	await projects.load();
	const project = await projects.create({ path: directory });
	const sessions = new SessionManager(directory, projects),
		terminals = new TerminalManager();
	const history = t.mock.method(sessions, "history", async () => {
		throw new Error("No history");
	});
	const server = createDaemonServer(
		{ home: directory, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog(directory),
		terminals,
	);
	t.after(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await terminals.shutdown();
		await sessions.shutdown();
		await rm(directory, { recursive: true, force: true });
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${project.id}/origin`;
	assert.deepEqual(await (await fetch(url)).json(), { identity: identity(origin) });
	origin = "https://username:password@git.example.com/Case/Repo.git";
	const text = await (await fetch(url)).text();
	assert.equal(text.includes("password"), false);
	assert.equal(text.includes("username"), false);
	assert.deepEqual(JSON.parse(text), { identity: identity(origin) });
	origin = "";
	assert.deepEqual(await (await fetch(url)).json(), { identity: null });
	assert.equal((await fetch(url, { method: "POST" })).status, 404);
	assert.equal((await fetch(url, { headers: { origin: "https://evil.test" } })).status, 403);
	assert.equal((await fetch(url.replace(project.id, "missing"))).status, 404);
	assert.equal(calls, 3);
	assert.equal(history.mock.callCount(), 0);
});

test("real checkout without origin and changed configured origin are read without network", async () => {
	const directory = await mkdtemp(join(tmpdir(), "project-origin-real-"));
	try {
		await run("git", ["init", "--quiet"], directory);
		const projects = new ProjectStore(directory);
		await projects.load();
		const project = await projects.create({ path: directory });
		assert.deepEqual(await projects.origin(project.id), { identity: null });
		await run("git", ["config", "--local", "remote.origin.url", "git@git.example.com:Owner/Repo.git"], directory);
		assert.deepEqual(await projects.origin(project.id), { identity: identity("https://git.example.com/Owner/Repo") });
		await run("git", ["config", "--local", "remote.origin.url", "https://git.example.com/Fork/Repo"], directory);
		assert.deepEqual(await projects.origin(project.id), { identity: identity("https://git.example.com/Fork/Repo") });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("ten thousand origin comparisons stay a bounded metadata operation", (t) => {
	const start = performance.now();
	for (let i = 0; i < 10_000; i++) assert.ok(identity(`git@git.example.com:team/repository-${i}.git`));
	t.diagnostic(`10,000 normalized repository identities: ${(performance.now() - start).toFixed(2)} ms`);
});
