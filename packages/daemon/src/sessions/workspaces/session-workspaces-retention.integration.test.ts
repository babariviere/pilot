// biome-ignore-all lint/complexity/useLiteralKeys: Exercise private lifecycle, persistence and store seams.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "@pilot/artifacts";
import { Conflict } from "../../runtime/contracts/errors.ts";

import { DAY, fixture, seedHistory } from "../../testing/session-workspace.ts";

test("coordinator organization retains actual workspace outputs, history and artifacts across sweeps and restart", async (t) => {
	const f = await fixture(t);
	const created = await f.spawn();
	const directory = join(f.home, "sessions", created.id);
	await seedHistory(directory);
	const source = "export default () => 'historical content';";
	const store = new ArtifactStore(directory, { sessionId: created.id, projectId: f.project.id });
	const artifact = await store.create({ title: "Retained", kind: "nsh", source, entry: "retained.tsx" });
	await mkdir(join(created.cwd, "node_modules"));
	await writeFile(join(created.cwd, "node_modules", "retain"), "not disposable by coordinator authority");
	await writeFile(join(created.cwd, "ignored-secret"), "retained ignored input");
	const authorize = () => {}; // Scope/assignment authorization is exercised by MissionService fixtures.
	await f.sessions.organizeMissionWorker(created.id, true, authorize);
	const before = f.workers.length;
	assert.equal((await f.stored(created.id)).coordinatorArchivePreservesWorkspace, true);
	await f.sessions["reclaimArchivedWorkspaces"](); // Even immediate output pruning is forbidden.
	await f.sessions["pruneWorkspace"](created.id); // A queued/stale prune must recheck the marker too.
	assert.equal(
		await readFile(join(created.cwd, "node_modules", "retain"), "utf8"),
		"not disposable by coordinator authority",
	);
	const history = await f.sessions.history(created.id, Number.MAX_SAFE_INTEGER, 100);
	assert.deepEqual(history.entries[0]?.data, { text: "retained conversation" });
	assert.equal((await f.sessions.artifact(created.id, artifact.id)).source, source);
	assert.equal(f.workers.length, before);
	await f.sessions.shutdown();
	const restarted = await f.manager();
	const now = Date.now() + 31 * DAY;
	t.mock.method(Date, "now", () => now);
	await restarted["reclaimArchivedWorkspaces"]();
	await restarted.reclaimWorkspace(created.id, now); // Stale automatic admission cannot bypass preservation.
	assert.ok(existsSync(created.cwd));
	assert.equal(await readFile(join(created.cwd, "ignored-secret"), "utf8"), "retained ignored input");
	assert.equal((await restarted.artifacts(created.id))[0]!.id, artifact.id);
	await restarted.organizeMissionWorker(created.id, false, authorize);
	assert.equal(restarted.get(created.id)!.archivedAt, undefined);
	assert.equal(f.workers.length, before, "passive restore never starts a worker");
	await restarted.archive(created.id); // Existing user archive remains available, without dropping preservation.
	await restarted["reclaimArchivedWorkspaces"]();
	assert.ok(existsSync(join(created.cwd, "node_modules", "retain")));
	await restarted.reclaimWorkspace(created.id); // Separate explicit user cleanup retains its authority.
	assert.equal(existsSync(created.cwd), false);
});

test("live PTYs, busy workers and worker subprocesses block manual reclaim and are skipped by maintenance", async (t) => {
	const f = await fixture(t);
	const created = await f.spawn();
	await f.sessions.archive(created.id);
	const meta = f.sessions["metas"].get(created.id)!;
	meta.archivedAt = Date.now() - 31 * DAY;
	const worker = f.workers[0]!;
	let pty = true;
	f.sessions.setWorkspaceProcessGuard((id) => id === created.id && pty);
	for (const guard of ["pty", "busy", "children"] as const) {
		pty = guard === "pty";
		worker.busy = guard === "busy";
		worker.children = guard === "children";
		await assert.rejects(f.sessions.reclaimWorkspace(created.id), Conflict);
		await f.sessions["reclaimArchivedWorkspaces"]();
		assert.ok(existsSync(created.cwd), guard);
		assert.equal(worker.closed, false, guard);
		assert.equal(meta.workspaceRecovery, undefined, guard);
	}
	pty = false;
	worker.busy = false;
	worker.children = false;
	await f.sessions["reclaimArchivedWorkspaces"]();
	assert.equal(existsSync(created.cwd), false);
});

test("repository maintenance prefers idle repositories and runs busy ones after three days", async (t) => {
	const f = await fixture(t);
	const created = await f.spawn();
	const meta = f.sessions["metas"].get(created.id)!;
	const maintain = t.mock.method(f.sessions["sharedWorkspaces"], "maintain", async () => true);
	const mainViews = t.mock.method(f.sessions["mainViews"], "maintain", async () => {});
	let pty = false;
	f.sessions.setWorkspaceProcessGuard((id) => id === created.id && pty);
	meta.working = true;
	await f.sessions["maintainRepositories"]();
	meta.working = false;
	pty = true;
	await f.sessions["maintainRepositories"]();
	pty = false;
	await f.sessions["maintainRepositories"]();
	const repository = meta.workspace!.shared!.repository;
	assert.deepEqual(
		maintain.mock.calls.map((call) => [call.arguments[0], call.arguments[2]]),
		[
			[repository, 3 * DAY],
			[repository, 3 * DAY],
			[repository, DAY],
		],
		"working chats and live terminals stretch the interval to three days",
	);
	assert.equal(mainViews.mock.callCount(), 3, "the same sweep maintains separate Git-only main views");
});

test("reclaimed sessions still report extra workspaces without deleting their changes", async (t) => {
	const f = await fixture(t);
	const created = await f.spawn();
	await f.sessions.archive(created.id);
	await f.sessions.reclaimWorkspace(created.id);
	const extra = join(f.home, "sessions", created.id, "custom-workspace");
	await mkdir(join(extra, ".jj"), { recursive: true });
	await writeFile(join(extra, "draft.txt"), "uncommitted work\n");
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const warnings = t.mock.method(console, "warn", () => {});
	await f.sessions["reclaimArchivedWorkspaces"]();
	assert.match((await f.stored(created.id)).workspaceCleanupError!, /Additional workspace.*custom-workspace/);
	assert.equal(await readFile(join(extra, "draft.txt"), "utf8"), "uncommitted work\n");
	await f.sessions["reclaimArchivedWorkspaces"]();
	assert.equal(warnings.mock.callCount(), 1, "repeat sweeps do not repeat the audit or warning");
	await rm(extra, { recursive: true });
	now += DAY;
	await f.sessions["reclaimArchivedWorkspaces"]();
	assert.equal((await f.stored(created.id)).workspaceCleanupError, undefined);
});

test("maintenance discards existing archived shared and legacy private copies, not active or direct paths", async (t) => {
	const f = await fixture(t, { workspaceRetentionMs: 0 });
	const shared = await f.spawn();
	const legacy = await f.spawn();
	const active = await f.spawn();
	const direct = await f.spawn("direct");
	// Model old archived metadata without invoking today's immediate archive path.
	for (const chat of [shared, legacy, direct]) {
		const meta = f.sessions["metas"].get(chat.id)!;
		meta.archivedAt = Date.now();
		await f.sessions["save"](meta);
	}
	const meta = f.sessions["metas"].get(legacy.id)!;
	await f.sessions["sharedWorkspaces"].discard(meta.cwd, meta.workspace!.shared!);
	delete meta.workspace!.shared;
	await mkdir(join(meta.cwd, ".git"), { recursive: true });
	await writeFile(join(meta.cwd, "dirty"), "legacy private input");
	await f.sessions["save"](meta);
	await f.sessions["reclaimArchivedWorkspaces"]();
	for (const chat of [shared, legacy]) {
		assert.equal(existsSync(chat.cwd), false);
		assert.equal((await f.stored(chat.id)).workspaceDiscard?.phase, "discarded");
	}
	assert.ok(existsSync(active.cwd));
	assert.ok(existsSync(direct.cwd));
	await assert.rejects(f.sessions.reclaimWorkspace(direct.id), /private/);
	await f.assertSourceUnchanged();
});

test("discard failures back off without blocking healthy sessions; explicit retry bypasses backoff", async (t) => {
	const f = await fixture(t);
	const failing = await f.spawn();
	const healthy = await f.spawn();
	for (const chat of [failing, healthy]) {
		await f.sessions.archive(chat.id);
		f.sessions["metas"].get(chat.id)!.archivedAt = 1;
	}
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const original = f.sessions["sharedWorkspaces"].discard.bind(f.sessions["sharedWorkspaces"]);
	const discard = t.mock.method(
		f.sessions["sharedWorkspaces"],
		"discard",
		async (cwd: string, shared: Parameters<typeof original>[1]) => {
			if (cwd === failing.cwd) throw new Error("disk unavailable");
			return original(cwd, shared);
		},
	);
	const warnings = t.mock.method(console, "warn", () => {});
	for (let attempt = 1; attempt <= 5; attempt++) {
		await f.sessions["reclaimArchivedWorkspaces"]();
		const count = discard.mock.callCount();
		await f.sessions["reclaimArchivedWorkspaces"]();
		assert.equal(discard.mock.callCount(), count);
		if (attempt < 5) now += 5 * 60_000 * 2 ** (attempt - 1);
	}
	assert.equal(warnings.mock.callCount(), 5);
	assert.equal(existsSync(healthy.cwd), false);
	now += 10 * DAY;
	const count = discard.mock.callCount();
	await f.sessions["reclaimArchivedWorkspaces"]();
	assert.equal(discard.mock.callCount(), count);
	await assert.rejects(f.sessions.reclaimWorkspace(failing.id), /disk unavailable/);
	assert.equal(discard.mock.callCount(), count + 1);
	discard.mock.restore();
	await f.sessions.reclaimWorkspace(failing.id);
	assert.equal(existsSync(failing.cwd), false);
	assert.equal(f.sessions["workspaceCleanupBackoff"].size, 0);
});

test("restoration queued before automatic discard cancels its admission", async (t) => {
	const f = await fixture(t);
	const chat = await f.spawn();
	await f.sessions.archive(chat.id);
	f.sessions["metas"].get(chat.id)!.archivedAt = 1;
	await Promise.all([f.sessions.restore(chat.id), f.sessions["reclaimArchivedWorkspaces"]()]);
	assert.ok(existsSync(chat.cwd));
	assert.equal((await f.stored(chat.id)).workspaceDiscard, undefined);
});
