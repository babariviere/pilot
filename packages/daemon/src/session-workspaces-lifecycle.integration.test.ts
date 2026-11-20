// biome-ignore-all lint/complexity/useLiteralKeys: Exercise private lifecycle, persistence and store seams.
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "@pilot/artifacts";
import { LegacyArtifactFixture } from "@pilot/artifacts/testing";
import type { SessionSummary } from "@pilot/protocol";
import { loadConfig } from "./config.ts";
import { Conflict } from "./errors.ts";
import { ModelCatalog } from "./models.ts";
import { TerminalManager } from "./terminals.ts";
import { createDaemonFixtureServer as createDaemonServer } from "./testing/daemon-server.ts";

import { assertHistory, DAY, fixture, jj, seedHistory } from "./testing/session-workspace.ts";

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

test("archive immediately discards private work without snapshots, keeping history and published artifacts", async (t) => {
	const f = await fixture(t, { workspaceRetentionMs: loadConfig({}).workspaceRetentionMs });
	const created = await f.spawn();
	await assert.rejects(f.sessions.reclaimWorkspace(created.id), /Archive/);
	await writeFile(join(created.cwd, "tracked.txt"), "unpublished work");
	await writeFile(join(created.cwd, "ignored-secret"), "discard too");
	const directory = join(f.home, "sessions", created.id);
	await seedHistory(directory);
	const store = new LegacyArtifactFixture(directory, { sessionId: created.id, projectId: f.project.id });
	const artifact = await store.create({ title: "Saved", kind: "html", source: "<p>published</p>" });
	const snapshot = t.mock.method(f.sessions["sharedWorkspaces"], "snapshot", async () => {
		throw new Error("must not snapshot");
	});
	const archived = await f.sessions.archive(created.id);
	assert.ok(archived.archivedAt);
	assert.ok(archived.workspaceDiscardedAt);
	assert.equal(existsSync(created.cwd), false);
	assert.equal(snapshot.mock.callCount(), 0);
	assert.equal((await f.stored(created.id)).workspaceRecovery, undefined);
	assert.equal((await f.stored(created.id)).workspaceDiscard?.phase, "discarded");
	await assertHistory(f.sessions, created.id);
	assert.equal((await f.sessions.artifact(created.id, artifact.id)).source, "<p>published</p>");
	await f.sessions.shutdown();
	const restarted = await f.manager();
	await assertHistory(restarted, created.id);
	await assert.rejects(restarted.restore(created.id), /permanently discarded/);
	await assert.rejects(restarted.send(created.id, "resume"), /permanently discarded/);
	assert.throws(() => restarted.assertWritable(created.id), /permanently discarded/);
	assert.equal(existsSync(created.cwd), false);
	await restarted.reclaimWorkspace(created.id);
	assert.equal((await f.stored(created.id)).workspaceDiscard?.at, archived.workspaceDiscardedAt);
	await f.assertSourceUnchanged();
});

test("NSH scratch survives archive and idle reclaim; explicit cleanup drains worker and keeps published revisions", async (t) => {
	const f = await fixture(t);
	const created = await f.spawn();
	const directory = join(f.home, "sessions", created.id);
	const scratch = join(directory, "scratch", "artifacts");
	await mkdir(scratch, { recursive: true });
	const path = join(scratch, "unpublished.tsx");
	await writeFile(path, "export default () => null;");
	const store = new ArtifactStore(directory, { sessionId: created.id, projectId: f.project.id });
	const published = await store.create({
		title: "Saved",
		kind: "nsh",
		source: "export default () => 'saved';",
		entry: "published.tsx",
	});
	await f.sessions.archive(created.id);
	assert.ok(existsSync(path), "archive is not scratch cleanup");
	const meta = f.sessions["metas"].get(created.id)!;
	meta.archivedAt = Date.now() - 31 * DAY;
	await f.sessions["save"](meta);
	await f.sessions.reclaimWorkspace(created.id, Date.now());
	assert.ok(existsSync(path), "automatic retention reclaim does not remove source");
	await f.sessions.reclaimWorkspace(created.id);
	assert.equal(existsSync(scratch), false);
	assert.equal(f.workers[0]?.closed, true);
	assert.equal((await f.sessions.artifact(created.id, published.id, 1)).source, published.source);
	assert.equal((await f.sessions.artifact(created.id, published.id, 1)).nsh?.rendering, undefined);
});

test("ignored and tracked files are permanently discarded", async (t) => {
	const f = await fixture(t);
	const created = await f.spawn();
	await writeFile(join(created.cwd, "tracked.txt"), "dirty and valuable\n");
	await writeFile(join(created.cwd, "ignored-secret"), "irreplaceable ignored credentials\n");
	await f.sessions.archive(created.id);
	await f.sessions.reclaimWorkspace(created.id);
	assert.equal(existsSync(created.cwd), false);
	const stored = await f.stored(created.id);
	assert.ok(stored.archivedAt);
	assert.equal(stored.workspaceCleanupError, undefined);
	assert.ok(stored.workspaceReclaimedAt);
	assert.equal(stored.workspaceDiscard?.phase, "discarded");
	await assert.rejects(f.sessions.restore(created.id), /permanently discarded/);
	assert.equal(existsSync(join(created.cwd, "ignored-secret")), false);
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
	const snapshot = t.mock.method(f.sessions["sharedWorkspaces"], "discard");
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
	assert.equal((await f.stored(first.id)).workspaceDiscard?.phase, "discarded");
	assert.equal((await f.stored(second.id)).workspaceDiscard?.phase, "discarded");
	assert.equal(snapshot.mock.callCount(), 2);
	await f.assertSourceUnchanged();
});

test("HTTP reclaim-workspace enforces method, origin and active-session guards, then reclaims an archived session", async (t) => {
	const f = await fixture(t);
	const created = await f.spawn();
	const terminals = new TerminalManager();
	const server = createDaemonServer({
		config: { home: f.home, host: "127.0.0.1", port: 0 },
		sessions: f.sessions,
		projects: f.projects,
		models: new ModelCatalog(join(f.home, "agent")),
		terminals,
	});
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

test("human archive, not the kernel done outcome, authorizes discard", async (t) => {
	const f = await fixture(t, { workspaceRetentionMs: 0 });
	const chat = await f.spawn();
	const meta = f.sessions["metas"].get(chat.id)!;
	meta.outcome = "done";
	await f.sessions["save"](meta);
	await f.sessions["reclaimArchivedWorkspaces"]();
	assert.ok(existsSync(chat.cwd));
	assert.equal(f.sessions.get(chat.id)?.archivedAt, undefined);
	await f.sessions.archive(chat.id);
	assert.equal(existsSync(chat.cwd), false);
});
