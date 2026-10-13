// biome-ignore-all lint/complexity/useLiteralKeys: Exercise private lifecycle, persistence and store seams.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Conflict } from "./errors.ts";

import { deferred, fixture, jj } from "./testing/session-workspace.ts";

test("reclaim serializes with restore and denies workspace access while store removal is in flight", async (t) => {
	const f = await fixture(t);
	const created = await f.spawn();
	await f.sessions.archive(created.id);
	const gate = deferred();
	const entered = deferred();
	t.after(() => gate.resolve());
	const store = f.sessions["sharedWorkspaces"];
	const remove = store.remove.bind(store);
	const removal = t.mock.method(store, "remove", async (...args: Parameters<typeof remove>) => {
		entered.resolve();
		await gate.promise;
		return remove(...args);
	});
	const reclaim = f.sessions.reclaimWorkspace(created.id);
	// The synchronous transition must protect capabilities even before snapshot metadata exists.
	assert.throws(() => f.sessions.assertWritable(created.id), Conflict);
	assert.throws(() => f.sessions.changeBase(created.id), Conflict);
	await entered.promise;
	assert.equal((await f.stored(created.id)).workspaceRecovery?.phase, "removing");
	const duplicate = f.sessions.reclaimWorkspace(created.id);
	const restoring = f.sessions.restore(created.id);
	assert.ok(f.sessions.get(created.id)?.archivedAt);
	assert.equal(removal.mock.callCount(), 1);
	gate.resolve();
	await Promise.all([reclaim, duplicate, restoring]);
	assert.equal(removal.mock.callCount(), 1, "same-target retries share one removal");
	assert.equal(f.sessions.get(created.id)?.archivedAt, undefined);
	assert.ok(existsSync(created.cwd));
	assert.equal((await f.stored(created.id)).workspaceRecovery, undefined);
});

test("queued restore cannot unlock a gated reclaim snapshot and live processes prevent both operations from removing files", async (t) => {
	const f = await fixture(t);
	const created = await f.spawn();
	await writeFile(join(created.cwd, "tracked.txt"), "keep while a live process uses the workspace\n");
	await f.sessions.archive(created.id);
	const gate = deferred();
	const entered = deferred();
	t.after(() => gate.resolve());
	const store = f.sessions["sharedWorkspaces"];
	const snapshot = store.snapshot.bind(store);
	t.mock.method(store, "snapshot", async (...args: Parameters<typeof snapshot>) => {
		entered.resolve();
		await gate.promise;
		return snapshot(...args);
	});
	const removal = t.mock.method(store, "remove");
	const restoration = t.mock.method(store, "restore");
	let liveProcess = false;
	f.sessions.setWorkspaceProcessGuard((id) => id === created.id && liveProcess);
	const reclaim = f.sessions.reclaimWorkspace(created.id);
	const reclaimRejected = assert.rejects(reclaim, Conflict);
	await entered.promise;
	assert.equal((await f.stored(created.id)).workspaceRecovery, undefined);
	const restore = f.sessions.restore(created.id);
	const restoreRejected = assert.rejects(restore, Conflict);
	assert.equal(f.sessions["archiveTransitions"].get(created.id)?.archived, false, "restore is now the latest target");
	assert.equal(
		f.sessions["workspaceMaintenance"].get(created.id),
		1,
		"reclaim retains its independent capability hold",
	);
	assert.equal(
		f.sessions["metas"].get(created.id)?.workspaceRecovery,
		undefined,
		"snapshot has not produced a recipe",
	);
	assert.throws(() => f.sessions.assertWritable(created.id), Conflict, "queued restore cannot release reclaim's hold");
	assert.throws(() => f.sessions.changeBase(created.id), Conflict);
	// Model a shell that became live after the initial reclaim quiescence check.
	liveProcess = true;
	gate.resolve();
	await Promise.all([reclaimRejected, restoreRejected]);
	assert.equal(
		f.sessions["workspaceMaintenance"].has(created.id),
		false,
		"failed operations release every maintenance hold",
	);
	assert.equal(removal.mock.callCount(), 0, "neither reclaim nor queued restore may remove a live workspace");
	assert.equal(restoration.mock.callCount(), 0);
	assert.equal(
		await readFile(join(created.cwd, "tracked.txt"), "utf8"),
		"keep while a live process uses the workspace\n",
	);
	assert.ok(existsSync(join(created.cwd, ".jj")));
	const failed = await f.stored(created.id);
	assert.ok(failed.archivedAt);
	assert.equal(failed.workspaceRecovery?.phase, "removing");
	assert.equal(failed.workspaceReclaimedAt, undefined);
	assert.ok(failed.workspaceCleanupError);
	assert.throws(() => f.sessions.assertWritable(created.id), Conflict);
	assert.equal(f.sessions["workers"].has(created.id), false);
	liveProcess = false;
	await f.sessions.restore(created.id);
	f.sessions.assertWritable(created.id);
	assert.equal(f.sessions.get(created.id)?.archivedAt, undefined);
	assert.equal((await f.stored(created.id)).workspaceRecovery, undefined);
	assert.equal(
		await readFile(join(created.cwd, "tracked.txt"), "utf8"),
		"keep while a live process uses the workspace\n",
	);
	await f.assertSourceUnchanged();
});

test("send racing reclamation cannot start a worker or touch the reclaimed workspace", async (t) => {
	const f = await fixture(t);
	const created = await f.spawn();
	await f.sessions.archive(created.id);
	const gate = deferred();
	const entered = deferred();
	t.after(() => gate.resolve());
	const store = f.sessions["sharedWorkspaces"];
	const snapshot = store.snapshot.bind(store);
	t.mock.method(store, "snapshot", async (...args: Parameters<typeof snapshot>) => {
		entered.resolve();
		await gate.promise;
		return snapshot(...args);
	});
	const before = f.workers.length;
	const reclaim = f.sessions.reclaimWorkspace(created.id);
	await entered.promise;
	const send = assert.rejects(f.sessions.send(created.id, "racing message"), Conflict);
	gate.resolve();
	await Promise.all([reclaim, send]);
	assert.equal(f.workers.length, before);
	assert.equal(existsSync(created.cwd), false);
	assert.deepEqual((await f.stored(created.id)).pending, []);
});

test("send waits for gated restoration to recreate the workspace and unarchive before admission", async (t) => {
	const f = await fixture(t);
	const created = await f.spawn();
	await f.sessions.archive(created.id);
	await f.sessions.reclaimWorkspace(created.id);
	const gate = deferred();
	const entered = deferred();
	t.after(() => gate.resolve());
	const store = f.sessions["sharedWorkspaces"];
	const restore = store.restore.bind(store);
	t.mock.method(store, "restore", async (...args: Parameters<typeof restore>) => {
		entered.resolve();
		await gate.promise;
		return restore(...args);
	});
	const restoring = f.sessions.restore(created.id);
	await entered.promise;
	assert.equal((await f.stored(created.id)).workspaceRecovery?.phase, "restoring");
	assert.ok(f.sessions.get(created.id)?.archivedAt);
	assert.throws(() => f.sessions.assertWritable(created.id), Conflict);
	assert.throws(() => f.sessions.changeBase(created.id), Conflict);
	const before = f.workers.length;
	const sending = f.sessions.send(created.id, "resume after restore");
	await delay(10);
	assert.equal(f.workers.length, before);
	gate.resolve();
	await Promise.all([restoring, sending]);
	assert.ok(existsSync(created.cwd));
	assert.equal(f.sessions.get(created.id)?.archivedAt, undefined);
	assert.equal(f.workers.length, before + 1);
	assert.equal(f.workers.at(-1)?.requests[0]?.type, "input");
	await f.sessions.stop(created.id);
});

test("failure to persist the pre-removal recovery recipe leaves files intact and never calls remove", async (t) => {
	const f = await fixture(t);
	const created = await f.spawn();
	await writeFile(join(created.cwd, "tracked.txt"), "keep on disk failure\n");
	await f.sessions.archive(created.id);
	const save = f.sessions["save"].bind(f.sessions);
	let failed = false;
	const persistence = f.sessions as unknown as { save: typeof save };
	t.mock.method(persistence, "save", async (...args: Parameters<typeof save>) => {
		if (!failed && args[0].workspaceRecovery?.phase === "removing") {
			failed = true;
			throw new Error("recovery metadata disk full");
		}
		return save(...args);
	});
	const remove = t.mock.method(f.sessions["sharedWorkspaces"], "remove");
	await assert.rejects(f.sessions.reclaimWorkspace(created.id), /disk full/);
	assert.equal(remove.mock.callCount(), 0);
	assert.equal(await readFile(join(created.cwd, "tracked.txt"), "utf8"), "keep on disk failure\n");
	assert.ok(existsSync(join(created.cwd, ".jj")));
	assert.ok(f.sessions.get(created.id)?.archivedAt);
	assert.match((await f.stored(created.id)).workspaceCleanupError!, /disk full/);
	assert.equal((await f.stored(created.id)).workspaceReclaimedAt, undefined);
});

test("missing shared repository makes restore fail safely, retaining archival and recovery across restart", async (t) => {
	const f = await fixture(t);
	const created = await f.spawn();
	const repo = resolve(created.cwd, ".jj", (await readFile(join(created.cwd, ".jj", "repo"), "utf8")).trim());
	await f.sessions.archive(created.id);
	await f.sessions.reclaimWorkspace(created.id);
	const recovery = structuredClone((await f.stored(created.id)).workspaceRecovery);
	await f.sessions.shutdown();
	await rename(repo, `${repo}.unavailable`);
	const restarted = await f.manager();
	const before = f.workers.length;
	await assert.rejects(restarted.restore(created.id));
	const failed = await f.stored(created.id);
	assert.ok(failed.archivedAt);
	assert.ok(failed.workspaceRecovery);
	assert.deepEqual({ ...failed.workspaceRecovery, phase: "reclaimed" }, recovery);
	assert.ok(failed.workspaceCleanupError);
	assert.ok(failed.workspaceReclaimedAt);
	assert.equal(f.workers.length, before);
	assert.throws(() => restarted.assertWritable(created.id), Conflict);
	await assert.rejects(restarted.send(created.id, "do not resume"), Conflict);
	await rename(`${repo}.unavailable`, repo);
	await restarted.restore(created.id);
	assert.ok(existsSync(created.cwd));
	assert.equal(restarted.get(created.id)?.archivedAt, undefined);
});

test("restart restores idempotently when removal completed but durable metadata still says removing", async (t) => {
	const f = await fixture(t);
	const created = await f.spawn();
	await writeFile(join(created.cwd, "tracked.txt"), "dirty state before simulated crash\n");
	const dirty = jj(created.cwd, "log", "--no-graph", "-r", "@", "-T", "change_id ++ commit_id");
	await f.sessions.archive(created.id);
	const save = f.sessions["save"].bind(f.sessions);
	const persistence = f.sessions as unknown as { save: typeof save };
	t.mock.method(persistence, "save", async (...args: Parameters<typeof save>) => {
		if (args[0].workspaceRecovery?.phase === "reclaimed") throw new Error("crash before final reclamation write");
		return save(...args);
	});
	await assert.rejects(f.sessions.reclaimWorkspace(created.id), /crash before final reclamation write/);
	assert.equal(existsSync(created.cwd), false, "real store removal completed before the failed save");
	const interrupted = await f.stored(created.id);
	assert.equal(interrupted.workspaceRecovery?.phase, "removing");
	assert.equal(interrupted.workspaceReclaimedAt, undefined);
	assert.ok(interrupted.archivedAt);
	await f.sessions.shutdown();
	const restarted = await f.manager();
	const before = f.workers.length;
	await restarted.restore(created.id);
	assert.equal(await readFile(join(created.cwd, "tracked.txt"), "utf8"), "dirty state before simulated crash\n");
	assert.equal(jj(created.cwd, "log", "--no-graph", "-r", "@", "-T", "change_id ++ commit_id"), dirty);
	assert.equal(restarted.get(created.id)?.archivedAt, undefined);
	assert.equal((await f.stored(created.id)).workspaceRecovery, undefined);
	assert.equal(f.workers.length, before);
	await restarted.restore(created.id);
	assert.equal(f.workers.length, before, "repeated restore remains a worker-free no-op");
	await f.assertSourceUnchanged();
});
