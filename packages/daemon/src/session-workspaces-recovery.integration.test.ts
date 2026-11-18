// biome-ignore-all lint/complexity/useLiteralKeys: Exercise private lifecycle and persistence seams.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { deferred, fixture, jj } from "./testing/session-workspace.ts";

test("failed durable admission never calls discard or deletes files", async (t) => {
	const f = await fixture(t);
	const chat = await f.spawn();
	await f.sessions.archive(chat.id);
	const save = f.sessions["save"].bind(f.sessions);
	const persistence = f.sessions as unknown as { save: typeof save };
	t.mock.method(persistence, "save", async (...args: Parameters<typeof save>) => {
		if (args[3]) throw new Error("disk full");
		return save(...args);
	});
	const discard = t.mock.method(f.sessions["sharedWorkspaces"], "discard");
	await assert.rejects(f.sessions.reclaimWorkspace(chat.id), /disk full/);
	assert.equal(discard.mock.callCount(), 0);
	assert.equal(await readFile(join(chat.cwd, "tracked.txt"), "utf8"), "base\n");
});

test("crash after removal retains a permanent fence and maintenance finishes idempotently after restart", async (t) => {
	const f = await fixture(t);
	const chat = await f.spawn();
	await f.sessions.archive(chat.id);
	const save = f.sessions["save"].bind(f.sessions);
	const persistence = f.sessions as unknown as { save: typeof save };
	const fail = t.mock.method(persistence, "save", async (...args: Parameters<typeof save>) => {
		if (args[0].workspaceDiscard?.phase === "discarded") throw new Error("crash before completion");
		return save(...args);
	});
	await assert.rejects(f.sessions.reclaimWorkspace(chat.id), /crash before completion/);
	assert.equal(existsSync(chat.cwd), false);
	assert.equal((await f.stored(chat.id)).workspaceDiscard?.phase, "removing");
	fail.mock.restore();
	await f.sessions.shutdown();
	const restarted = await f.manager({ workspaceRetentionMs: 0 });
	await assert.rejects(restarted.restore(chat.id), /permanently discarded/);
	await restarted["reclaimArchivedWorkspaces"]();
	assert.equal((await f.stored(chat.id)).workspaceDiscard?.phase, "discarded");
	await assert.rejects(restarted.send(chat.id, "resume"), /permanently discarded/);
});

test("duplicate discard coalesces and queued restore/send cannot recreate deleted work", async (t) => {
	const f = await fixture(t);
	const chat = await f.spawn();
	await f.sessions.archive(chat.id);
	const entered = deferred();
	const release = deferred();
	t.after(() => release.resolve());
	const original = f.sessions["sharedWorkspaces"].discard.bind(f.sessions["sharedWorkspaces"]);
	const discard = t.mock.method(
		f.sessions["sharedWorkspaces"],
		"discard",
		async (...args: Parameters<typeof original>) => {
			entered.resolve();
			await release.promise;
			return original(...args);
		},
	);
	const first = f.sessions.reclaimWorkspace(chat.id);
	await entered.promise;
	assert.equal((await f.stored(chat.id)).workspaceDiscard?.phase, "removing");
	const duplicate = f.sessions.reclaimWorkspace(chat.id);
	const restore = assert.rejects(f.sessions.restore(chat.id), /permanently discarded/);
	const send = assert.rejects(f.sessions.send(chat.id, "race"), /permanently discarded/);
	release.resolve();
	await Promise.all([first, duplicate, restore, send]);
	assert.equal(discard.mock.callCount(), 1);
	assert.equal(existsSync(chat.cwd), false);
});

test("old recovery refs and payloads are discarded, without creating a replacement snapshot", async (t) => {
	const f = await fixture(t);
	const chat = await f.spawn();
	const other = await f.spawn();
	jj(chat.cwd, "bookmark", "create", "kept-history", "-r", "@");
	await f.sessions.archive(chat.id);
	const meta = f.sessions["metas"].get(chat.id)!;
	const directory = join(f.home, "sessions", chat.id, "workspace-recovery");
	const recovery = await f.sessions["sharedWorkspaces"].snapshot(meta.cwd, meta.workspace!.shared!, directory);
	meta.workspaceRecovery = { ...recovery, phase: "removing" };
	await f.sessions["save"](meta);
	await assert.rejects(f.sessions.restore(chat.id), /can no longer be restored/);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "old-input"), "discard");
	const snapshot = t.mock.method(f.sessions["sharedWorkspaces"], "snapshot", async () => {
		throw new Error("no new snapshot");
	});
	await f.sessions.reclaimWorkspace(chat.id);
	assert.equal(snapshot.mock.callCount(), 0);
	assert.equal(existsSync(directory), false);
	assert.equal((await f.stored(chat.id)).workspaceRecovery, undefined);
	assert.equal(existsSync(join(meta.workspace!.shared!.repository, ".git", recovery.archiveRef)), false);
	assert.equal(
		jj(other.cwd, "--ignore-working-copy", "log", "--no-graph", "-r", recovery.commitId, "-T", "commit_id"),
		recovery.commitId,
	);
	assert.ok(jj(other.cwd, "bookmark", "list", "kept-history").includes("kept-history"));
	assert.equal(await readFile(join(other.cwd, "tracked.txt"), "utf8"), "base\n");
});

test("crash after jj forget retries partial removal without a recovery snapshot", async (t) => {
	const f = await fixture(t);
	const chat = await f.spawn();
	await f.sessions.archive(chat.id);
	await writeFile(join(chat.cwd, "untracked"), "authorized private work");
	const store = f.sessions["sharedWorkspaces"];
	const jj = store["jj"].bind(store);
	const seam = store as unknown as { jj: typeof jj };
	const crash = t.mock.method(seam, "jj", async (...args: Parameters<typeof jj>) => {
		const result = await jj(...args);
		if (args[0].includes("forget")) throw new Error("crash after unregister");
		return result;
	});
	await assert.rejects(f.sessions.reclaimWorkspace(chat.id), /crash after unregister/);
	assert.ok(existsSync(chat.cwd));
	assert.equal((await f.stored(chat.id)).workspaceDiscard?.phase, "removing");
	crash.mock.restore();
	await f.sessions.reclaimWorkspace(chat.id);
	assert.equal(existsSync(chat.cwd), false);
	assert.equal((await f.stored(chat.id)).workspaceDiscard?.phase, "discarded");
	await f.assertSourceUnchanged();
});

test("maintenance converts an already-reclaimed old snapshot into permanent discard", async (t) => {
	const f = await fixture(t);
	const chat = await f.spawn();
	await f.sessions.archive(chat.id);
	const meta = f.sessions["metas"].get(chat.id)!;
	const payload = join(f.home, "sessions", chat.id, "workspace-recovery");
	const store = f.sessions["sharedWorkspaces"];
	const recovery = await store.snapshot(meta.cwd, meta.workspace!.shared!, payload);
	await store.remove(meta.cwd, meta.workspace!.shared!, recovery);
	meta.workspaceRecovery = { ...recovery, phase: "reclaimed" };
	meta.archivedAt = 1;
	await f.sessions["save"](meta);
	await assert.rejects(f.sessions.restore(chat.id), /can no longer be restored/);
	await f.sessions["reclaimArchivedWorkspaces"]();
	assert.equal(existsSync(chat.cwd), false);
	assert.equal(existsSync(payload), false);
	assert.equal((await f.stored(chat.id)).workspaceRecovery, undefined);
	assert.equal((await f.stored(chat.id)).workspaceDiscard?.phase, "discarded");
});

test("aliased workspace paths and transferred ownership block deletion", async (t) => {
	const f = await fixture(t);
	const chat = await f.spawn();
	await f.sessions.archive(chat.id);
	const meta = f.sessions["metas"].get(chat.id)!;
	meta.continuedTo = "continuing-chat";
	await assert.rejects(f.sessions.reclaimWorkspace(chat.id), /continu/);
	delete meta.continuedTo;
	const kept = join(f.root, "kept-workspace");
	await rename(chat.cwd, kept);
	await symlink(kept, chat.cwd);
	await assert.rejects(f.sessions.reclaimWorkspace(chat.id), /Unsafe/);
	assert.equal(await readFile(join(kept, "tracked.txt"), "utf8"), "base\n");
	assert.equal((await f.stored(chat.id)).workspaceDiscard, undefined);
});
