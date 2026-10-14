// biome-ignore-all lint/complexity/useLiteralKeys: Exercise private lifecycle, persistence and store seams.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Conflict } from "./errors.ts";

import { assertHistory, DAY, fixture, seedHistory } from "./testing/session-workspace.ts";

test("failed automatic cleanup backs off, caps retries, and leaves explicit cleanup available", async (t) => {
	const f = await fixture(t);
	const created = await f.spawn();
	await f.sessions.archive(created.id);
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const meta = f.sessions["metas"].get(created.id)!;
	meta.archivedAt = now - DAY;
	const archivedAt = meta.archivedAt;
	const snapshot = t.mock.method(f.sessions["sharedWorkspaces"], "snapshot", async () => {
		throw new Error("Unsafe ignored path prevents cleanup: unknown/input");
	});
	const warnings = t.mock.method(console, "warn", () => {});
	for (const minutes of [5, 10, 20, 40, 60]) {
		const attempts = snapshot.mock.callCount();
		await f.sessions["reclaimArchivedWorkspaces"]();
		assert.equal(snapshot.mock.callCount(), attempts + 1);
		assert.match((await f.stored(created.id)).workspaceCleanupError!, /Unsafe ignored path/);
		now += minutes * 60_000 - 1;
		await f.sessions["reclaimArchivedWorkspaces"]();
		assert.equal(snapshot.mock.callCount(), attempts + 1, "no scan just before retry deadline");
		now += 1;
	}
	assert.equal(warnings.mock.callCount(), 5, "warnings occur only for actual attempts");
	await f.sessions["reclaimArchivedWorkspaces"]();
	const attempts = snapshot.mock.callCount();
	await assert.rejects(f.sessions.reclaimWorkspace(created.id), /Unsafe ignored path/);
	assert.equal(snapshot.mock.callCount(), attempts + 1, "manual retry bypasses backoff");
	await f.sessions.restore(created.id);
	assert.equal(f.sessions["workspaceCleanupBackoff"].has(created.id), false);
	await f.sessions.archive(created.id);
	meta.archivedAt = archivedAt;
	await f.sessions["reclaimArchivedWorkspaces"]();
	assert.equal(snapshot.mock.callCount(), attempts + 2, "a new archival resets backoff");
	snapshot.mock.restore();
	await f.sessions.reclaimWorkspace(created.id);
	assert.equal(meta.workspaceCleanupError, undefined);
	assert.equal(f.sessions["workspaceCleanupBackoff"].has(created.id), false);
	assert.equal(existsSync(created.cwd), false);
});

test("private retention sweep includes exactly 1 day, skips recent, active, legacy and direct workspaces", async (t) => {
	const f = await fixture(t);
	const boundary = await f.spawn();
	const recent = await f.spawn();
	const active = await f.spawn();
	const legacy = await f.spawn();
	const direct = await f.spawn("direct");
	for (const created of [boundary, recent, legacy, direct]) await f.sessions.archive(created.id);
	const now = Date.now();
	t.mock.method(Date, "now", () => now);
	const metas = f.sessions["metas"];
	metas.get(boundary.id)!.archivedAt = now - DAY;
	metas.get(recent.id)!.archivedAt = now - DAY + 1;
	metas.get(legacy.id)!.archivedAt = now - 2 * DAY;
	delete metas.get(legacy.id)!.workspace!.shared;
	metas.get(direct.id)!.archivedAt = now - 2 * DAY;
	await f.sessions["reclaimArchivedWorkspaces"]();
	assert.equal(existsSync(boundary.cwd), false, "exact retention boundary is eligible");
	for (const created of [recent, active, legacy, direct]) assert.ok(existsSync(created.cwd), created.id);
	assert.equal((await f.stored(boundary.id)).workspaceRecovery?.phase, "reclaimed");
	await assert.rejects(f.sessions.reclaimWorkspace(legacy.id), /shared/);
	await assert.rejects(f.sessions.reclaimWorkspace(direct.id), /shared/);
});

test("Infinity disables the private retention sweep but not explicit immediate reclaim", async (t) => {
	const f = await fixture(t, { workspaceRetentionMs: Number.POSITIVE_INFINITY });
	const created = await f.spawn();
	await f.sessions.archive(created.id);
	f.sessions["metas"].get(created.id)!.archivedAt = 1;
	await f.sessions["reclaimArchivedWorkspaces"]();
	assert.ok(existsSync(created.cwd));
	await f.sessions.reclaimWorkspace(created.id);
	assert.equal(existsSync(created.cwd), false);
});

test("configured retention and a restored-at-selection session are rechecked by the private sweep", async (t) => {
	const f = await fixture(t, { workspaceRetentionMs: DAY });
	const created = await f.spawn();
	await f.sessions.archive(created.id);
	const now = Date.now();
	t.mock.method(Date, "now", () => now);
	const meta = f.sessions["metas"].get(created.id)!;
	meta.archivedAt = now - DAY + 1;
	await f.sessions["reclaimArchivedWorkspaces"]();
	assert.ok(existsSync(created.cwd));
	meta.archivedAt = now - DAY;
	const restoring = f.sessions.restore(created.id);
	const sweep = f.sessions["reclaimArchivedWorkspaces"]();
	await Promise.all([restoring, sweep]);
	assert.equal(meta.archivedAt, undefined);
	assert.ok(existsSync(created.cwd), "queued automatic reclaim must recheck archival after restore");
	await f.sessions.archive(created.id);
	meta.archivedAt = now - DAY;
	await f.sessions["reclaimArchivedWorkspaces"]();
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

test("archived legacy clones keep history and inputs but lose regenerable outputs after retention", async (t) => {
	const f = await fixture(t);
	const legacy = await f.spawn();
	const recent = await f.spawn();
	for (const created of [legacy, recent]) {
		await writeFile(join(created.cwd, ".gitignore"), "ignored-secret\nnode_modules/\n");
		await mkdir(join(created.cwd, "node_modules", "dep"), { recursive: true });
		await writeFile(join(created.cwd, "node_modules", "dep", "index.js"), "dependency\n");
		await writeFile(join(created.cwd, "ignored-secret"), "irreplaceable\n");
		await writeFile(join(created.cwd, "tracked.txt"), "uncommitted work\n");
		await f.sessions.archive(created.id);
		delete f.sessions["metas"].get(created.id)!.workspace!.shared;
	}
	const now = Date.now();
	t.mock.method(Date, "now", () => now);
	f.sessions["metas"].get(legacy.id)!.archivedAt = now - DAY;
	f.sessions["metas"].get(recent.id)!.archivedAt = now - DAY + 1;
	await f.sessions["reclaimArchivedWorkspaces"]();
	assert.equal(existsSync(join(legacy.cwd, "node_modules")), false);
	assert.ok(existsSync(join(recent.cwd, "node_modules")), "recently archived clones are untouched");
	for (const file of ["ignored-secret", "tracked.txt", ".jj"]) assert.ok(existsSync(join(legacy.cwd, file)), file);
	assert.equal(await readFile(join(legacy.cwd, "tracked.txt"), "utf8"), "uncommitted work\n");
	const pruned = await f.stored(legacy.id);
	assert.equal(pruned.workspacePrunedAt, now);
	assert.deepEqual(pruned.workspaceReset, { at: now });
	assert.equal(pruned.workspaceRecovery, undefined, "legacy clones are never removed");
	assert.equal(pruned.workspaceCleanupError, undefined);
	await f.sessions.restore(legacy.id);
	assert.equal((await f.stored(legacy.id)).workspacePrunedAt, undefined, "a later archival may prune again");
	await f.sessions.send(legacy.id, "continue after pruning");
	assert.deepEqual(f.specs.at(-1)?.pilot?.workspaceReset, { at: now });
	await f.assertSourceUnchanged();
});

for (const recovery of ["manual", "restart"] as const) {
	test(`cleanup backs off, pauses after five failures and recovers via ${recovery}`, async (t) => {
		const f = await fixture(t);
		const created = await f.spawn();
		await seedHistory(join(f.home, "sessions", created.id));
		await f.sessions.archive(created.id);
		let now = Date.now();
		t.mock.method(Date, "now", () => now);
		const meta = f.sessions["metas"].get(created.id)!;
		meta.archivedAt = now - DAY;
		await f.sessions["save"](meta);
		const snapshot = t.mock.method(f.sessions["sharedWorkspaces"], "snapshot", async () => {
			throw new Error("temporary snapshot failure");
		});
		const warnings = t.mock.method(console, "warn", () => {});
		for (let attempt = 1; attempt <= 5; attempt++) {
			await f.sessions["reclaimArchivedWorkspaces"]();
			assert.equal(snapshot.mock.callCount(), attempt);
			assert.equal(warnings.mock.callCount(), attempt);
			for (let tick = 0; tick < 100; tick++) await f.sessions["reclaimArchivedWorkspaces"]();
			assert.equal(snapshot.mock.callCount(), attempt, "no repeated work or logs during backoff");
			if (attempt < 5) {
				now += 5 * 60_000 * 2 ** (attempt - 1) - 1;
				await f.sessions["reclaimArchivedWorkspaces"]();
				assert.equal(snapshot.mock.callCount(), attempt, "retry waits for the exact boundary");
				now++;
			}
		}
		now += 2 * DAY;
		await f.sessions["reclaimArchivedWorkspaces"]();
		assert.equal(snapshot.mock.callCount(), 5, "max failures pauses even after a long wait");
		assert.equal(warnings.mock.callCount(), 5);
		assert.match(String(warnings.mock.calls[4]!.arguments[0]), /paused until daemon restart/);
		assert.ok(existsSync(created.cwd));
		assert.ok((await f.stored(created.id)).workspaceCleanupError);
		assert.ok(f.sessions.get(created.id), "the session is never removed");
		snapshot.mock.restore();
		if (recovery === "manual") {
			await f.sessions.reclaimWorkspace(created.id);
			assert.equal(f.sessions["workspaceCleanupBackoff"].size, 0, "manual success resets the budget");
			await assertHistory(f.sessions, created.id);
		} else {
			await f.sessions.shutdown();
			const restarted = await f.manager();
			await restarted["reclaimArchivedWorkspaces"]();
			await assertHistory(restarted, created.id);
		}
		assert.equal(existsSync(created.cwd), false);
		assert.equal((await f.stored(created.id)).workspaceCleanupError, undefined);
	});
}

test("legacy pruning uses per-session backoff, conflicts stay quiet and restoration resets the budget", async (t) => {
	const f = await fixture(t);
	const legacy = await f.spawn();
	const healthy = await f.spawn();
	for (const created of [legacy, healthy]) await f.sessions.archive(created.id);
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	for (const created of [legacy, healthy]) f.sessions["metas"].get(created.id)!.archivedAt = now - DAY;
	f.sessions["metas"].get(healthy.id)!.archivedAt = now;
	delete f.sessions["metas"].get(legacy.id)!.workspace!.shared;
	let conflict = true;
	const pruning = f.sessions as unknown as { pruneWorkspace: (typeof f.sessions)["pruneWorkspace"] };
	const prune = t.mock.method(pruning, "pruneWorkspace", async () => {
		if (conflict) throw new Conflict("busy");
		throw new Error("pruning failed");
	});
	const warnings = t.mock.method(console, "warn", () => {});
	await f.sessions["reclaimArchivedWorkspaces"]();
	await f.sessions["reclaimArchivedWorkspaces"]();
	assert.equal(prune.mock.callCount(), 2, "busy sessions are checked every sweep");
	assert.equal(warnings.mock.callCount(), 0);
	assert.equal(f.sessions["workspaceCleanupBackoff"].size, 0);
	assert.equal(existsSync(healthy.cwd), true, "recent archives are still retained");
	conflict = false;
	f.sessions["metas"].get(healthy.id)!.archivedAt = now - DAY;
	await f.sessions["reclaimArchivedWorkspaces"]();
	await f.sessions["reclaimArchivedWorkspaces"]();
	assert.equal(existsSync(healthy.cwd), false, "one failing session never delays another");
	assert.equal(prune.mock.callCount(), 3);
	assert.equal(warnings.mock.callCount(), 1);
	await f.sessions.restore(legacy.id);
	assert.equal(f.sessions["workspaceCleanupBackoff"].size, 0);
	await f.sessions.archive(legacy.id);
	f.sessions["metas"].get(legacy.id)!.archivedAt = now - DAY;
	await f.sessions["reclaimArchivedWorkspaces"]();
	assert.equal(prune.mock.callCount(), 4, "a new archival starts a fresh budget immediately");
	now += 5 * 60_000;
	prune.mock.restore();
	await f.sessions["reclaimArchivedWorkspaces"]();
	assert.equal(f.sessions["workspaceCleanupBackoff"].size, 0, "successful pruning resets its budget");
});
