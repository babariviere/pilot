// biome-ignore-all lint/complexity/useLiteralKeys: Exercise private lifecycle, persistence and store seams.
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "@pilot/artifacts";
import type { SessionSummary } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { ModelCatalog } from "./models.ts";
import { createDaemonServer } from "./server.ts";
import { TerminalManager } from "./terminals.ts";

import { DAY, assertHistory, fixture, jj, seedHistory } from "./testing/session-workspace.ts";

test("default creation shares a daemon-owned jj repository between sessions without touching the source", async (t) => {
	const f = await fixture(t);
	const first = await f.spawn();
	const second = await f.spawn();
	const repo = async (cwd: string) => resolve(cwd, ".jj", (await readFile(join(cwd, ".jj", "repo"), "utf8")).trim());
	assert.equal((await f.stored(first.id)).workspace?.jj, true);
	assert.ok((await f.stored(first.id)).workspace?.shared);
	assert.ok((await f.stored(second.id)).workspace?.shared);
	assert.equal(await repo(first.cwd), await repo(second.cwd));
	assert.notEqual(await repo(first.cwd), join(f.source, ".jj", "repo"));
	assert.notEqual(first.cwd, second.cwd);
	await writeFile(join(first.cwd, "tracked.txt"), "first private change\n");
	jj(first.cwd, "status");
	assert.equal(await readFile(join(second.cwd, "tracked.txt"), "utf8"), "base\n");
	await f.assertSourceUnchanged();
});

test("manual reclaim is immediate, retains history/artifacts, and restart restore preserves exact dirty jj state", async (t) => {
	const f = await fixture(t);
	const created = await f.spawn();
	await assert.rejects(f.sessions.reclaimWorkspace(created.id), /Archive/);
	await writeFile(join(created.cwd, "tracked.txt"), "unpushed commit\n");
	jj(created.cwd, "commit", "-m", "local unpushed work");
	jj(created.cwd, "bookmark", "create", "agent-unpushed", "-r", "@-");
	await writeFile(join(created.cwd, "tracked.txt"), "dirty after commit\n");
	await writeFile(join(created.cwd, "new.txt"), "new dirty file\n");
	const dirty = jj(created.cwd, "log", "--no-graph", "-r", "@", "-T", "change_id ++ commit_id");
	const commit = jj(created.cwd, "log", "--no-graph", "-r", "agent-unpushed", "-T", "commit_id");
	const base = f.sessions.changeBase(created.id).base;
	const workspaceMeta = structuredClone((await f.stored(created.id)).workspace);
	const directory = join(f.home, "sessions", created.id);
	await seedHistory(directory);
	const store = new ArtifactStore(directory, { sessionId: created.id, projectId: f.project.id });
	const artifact = await store.create({ title: "Retained", kind: "html", source: "<p>revision one</p>" });
	await store.update(artifact.id, { title: "Retained", kind: "html", source: "<p>revision two</p>" }, 1);
	const archived = await f.sessions.archive(created.id);
	const before = f.workers.length;
	await f.sessions.reclaimWorkspace(created.id);
	assert.equal(existsSync(created.cwd), false);
	assert.equal(f.sessions.get(created.id)?.archivedAt, archived.archivedAt);
	assert.equal(f.sessions["workers"].has(created.id), false);
	assert.equal(f.workers[0]?.closed, true);
	const reclaimed = await f.stored(created.id);
	assert.equal(reclaimed.workspaceRecovery?.phase, "reclaimed");
	assert.ok(reclaimed.workspaceReclaimedAt);
	assert.deepEqual(reclaimed.workspace, workspaceMeta);
	await assertHistory(f.sessions, created.id);
	assert.equal((await f.sessions.artifact(created.id, artifact.id, 1)).source, "<p>revision one</p>");
	assert.equal((await f.sessions.artifacts(created.id))[0]?.revision, 2);
	assert.equal(f.workers.length, before, "cold reads must not reopen a worker");
	await f.sessions.shutdown();
	const restarted = await f.manager();
	await assertHistory(restarted, created.id);
	assert.throws(() => restarted.assertWritable(created.id), Conflict);
	assert.throws(() => restarted.changeBase(created.id), Conflict);
	await assert.rejects(restarted.send(created.id, "cannot resume reclaimed work"), Conflict);
	await restarted.restore(created.id);
	assert.equal(restarted.get(created.id)?.archivedAt, undefined);
	assert.equal(await readFile(join(created.cwd, "tracked.txt"), "utf8"), "dirty after commit\n");
	assert.equal(await readFile(join(created.cwd, "new.txt"), "utf8"), "new dirty file\n");
	assert.equal(jj(created.cwd, "log", "--no-graph", "-r", "@", "-T", "change_id ++ commit_id"), dirty);
	assert.equal(jj(created.cwd, "log", "--no-graph", "-r", "agent-unpushed", "-T", "commit_id"), commit);
	assert.equal(restarted.changeBase(created.id).base, base);
	const restored = await f.stored(created.id);
	assert.equal(restored.workspaceRecovery, undefined);
	assert.equal(restored.workspaceReclaimedAt, undefined);
	assert.equal(restored.workspaceCleanupError, undefined);
	assert.equal(f.workers.length, before, "restoration never starts a worker");
	await f.assertSourceUnchanged();
});

test("an ignored file blocks reclamation, records the error and preserves every file", async (t) => {
	const f = await fixture(t);
	const created = await f.spawn();
	await writeFile(join(created.cwd, "tracked.txt"), "dirty and valuable\n");
	await writeFile(join(created.cwd, "ignored-secret"), "irreplaceable ignored credentials\n");
	await f.sessions.archive(created.id);
	await assert.rejects(f.sessions.reclaimWorkspace(created.id), /ignored|unsafe|untracked|preserv/i);
	assert.equal(await readFile(join(created.cwd, "ignored-secret"), "utf8"), "irreplaceable ignored credentials\n");
	assert.equal(await readFile(join(created.cwd, "tracked.txt"), "utf8"), "dirty and valuable\n");
	assert.ok(existsSync(join(created.cwd, ".jj")));
	const stored = await f.stored(created.id);
	assert.ok(stored.archivedAt);
	assert.ok(stored.workspaceCleanupError);
	assert.equal(stored.workspaceReclaimedAt, undefined);
	assert.notEqual(stored.workspaceRecovery?.phase, "reclaimed");
	await f.assertSourceUnchanged();
});

test("cached open and draft PRs block manual and automatic reclaim, while merged and closed PRs are eligible", async (t) => {
	const f = await fixture(t);
	const first = await f.spawn();
	const second = await f.spawn();
	for (const created of [first, second]) await f.sessions.archive(created.id);
	const firstMeta = f.sessions["metas"].get(first.id)!;
	const secondMeta = f.sessions["metas"].get(second.id)!;
	for (const [meta, state] of [
		[firstMeta, "open"],
		[secondMeta, "draft"],
	] as const) {
		meta.archivedAt = Date.now() - 31 * DAY;
		meta.pullRequest = {
			number: 10,
			url: "https://github.com/example/repository/pull/10",
			title: "Still in review",
			state,
			checkedAt: Date.now() - DAY,
		};
		await f.sessions["save"](meta);
		await assert.rejects(f.sessions.reclaimWorkspace(meta.id), Conflict);
	}
	const snapshot = t.mock.method(f.sessions["sharedWorkspaces"], "snapshot");
	await f.sessions["reclaimArchivedWorkspaces"]();
	assert.equal(snapshot.mock.callCount(), 0, "cached live PRs must be skipped before snapshotting");
	for (const created of [first, second]) {
		assert.equal(await readFile(join(created.cwd, "tracked.txt"), "utf8"), "base\n");
		assert.ok(existsSync(join(created.cwd, ".jj")));
		assert.equal((await f.stored(created.id)).workspaceRecovery, undefined);
		assert.equal(f.sessions["workers"].has(created.id), true);
	}
	firstMeta.pullRequest!.state = "merged";
	secondMeta.pullRequest!.state = "closed";
	await f.sessions.reclaimWorkspace(first.id);
	assert.equal(existsSync(first.cwd), false, "merged PR is eligible for manual reclaim");
	await f.sessions["reclaimArchivedWorkspaces"]();
	assert.equal(existsSync(second.cwd), false, "closed PR is eligible for automatic reclaim");
	assert.equal((await f.stored(first.id)).workspaceRecovery?.phase, "reclaimed");
	assert.equal((await f.stored(second.id)).workspaceRecovery?.phase, "reclaimed");
	assert.equal(snapshot.mock.callCount(), 2);
	await f.assertSourceUnchanged();
});

test("HTTP reclaim-workspace enforces method, origin and active-session guards, then reclaims an archived session", async (t) => {
	const f = await fixture(t);
	const created = await f.spawn();
	const terminals = new TerminalManager();
	const server = createDaemonServer(
		{ home: f.home, host: "127.0.0.1", port: 0 },
		f.sessions,
		f.projects,
		new ModelCatalog(join(f.home, "agent")),
		terminals,
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions/${created.id}/reclaim-workspace`;
	try {
		for (const [options, status] of [
			[{ method: "GET" }, 404],
			[{ method: "DELETE" }, 404],
			[{ method: "POST", headers: { origin: "https://example.com" } }, 403],
			[{ method: "POST" }, 409],
		] as const) {
			const response = await fetch(url, options);
			assert.equal(response.status, status);
			await response.arrayBuffer();
			assert.ok(existsSync(created.cwd));
		}
		await f.sessions.archive(created.id);
		const running = t.mock.method(terminals, "isRunning", () => true);
		const terminalBlocked = await fetch(url, { method: "POST" });
		assert.equal(terminalBlocked.status, 409, "server-installed process guard blocks a live PTY");
		await terminalBlocked.arrayBuffer();
		assert.ok(existsSync(created.cwd));
		running.mock.restore();
		const before = f.workers.length;
		const success = await fetch(url, { method: "POST" });
		assert.equal(success.status, 200);
		const summary = (await success.json()) as SessionSummary;
		assert.equal(summary.id, created.id);
		assert.ok(summary.archivedAt);
		assert.ok(summary.workspaceReclaimedAt);
		assert.deepEqual(summary, f.sessions.get(created.id));
		assert.equal(existsSync(created.cwd), false);
		assert.equal(f.workers.length, before);
	} finally {
		terminals.shutdown();
		await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
	}
});

test("restoring a reclaimed workspace tells the next kernel which jj change it was recreated from", async (t) => {
	const f = await fixture(t);
	const created = await f.spawn();
	await f.sessions.archive(created.id);
	await f.sessions.reclaimWorkspace(created.id);
	const recovery = (await f.stored(created.id)).workspaceRecovery!;
	await f.sessions.restore(created.id);
	const reset = (await f.stored(created.id)).workspaceReset;
	assert.equal(reset?.changeId, recovery.changeId);
	assert.equal(reset?.commitId, recovery.commitId);
	await f.sessions.send(created.id, "continue after restore");
	assert.deepEqual(f.specs.at(-1)?.pilot?.workspaceReset, reset);
	await f.sessions.stop(created.id);
	await f.sessions.archive(created.id);
	assert.equal((await f.stored(created.id)).workspaceReset, undefined, "a new archival clears the old notice");
});
