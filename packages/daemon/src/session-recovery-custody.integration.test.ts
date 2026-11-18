// biome-ignore-all lint/complexity/useLiteralKeys: Existing lifecycle test seam.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { deferred, fixture, seedHistory } from "./testing/session-workspace.ts";

test("native coding copies keep all files through archive, inactivity and restart while final archive waits", async (t) => {
	const f = await fixture(t, { workspaceRetentionMs: 0 });
	const id = randomUUID();
	await f.sessions.spawnDurable({ projectId: f.project.id, message: "Keep the original context" }, id, randomUUID());
	await f.sessions["starting"].get(id);
	await f.sessions.stop(id);
	const chat = f.sessions.get(id)!;
	const dir = join(f.home, "sessions", id);
	await seedHistory(dir);
	await mkdir(join(chat.cwd, "node_modules"));
	await writeFile(join(chat.cwd, "node_modules", "leftover"), "kept build output");
	await writeFile(join(chat.cwd, "ignored-secret"), "kept local input");
	await f.sessions.archive(id);
	await f.sessions["reclaimArchivedWorkspaces"]();
	assert.equal(await readFile(join(chat.cwd, "node_modules", "leftover"), "utf8"), "kept build output");
	await f.sessions.shutdown();
	const reopened = await f.manager();
	const now = Date.now() + 40 * 86_400_000;
	t.mock.method(Date, "now", () => now);
	await reopened["reclaimArchivedWorkspaces"]();
	await reopened["cleanArchivedTemporaryStorage"]();
	await assert.rejects(reopened.reclaimWorkspace(id), /final archive|review/i);
	assert.equal(await readFile(join(chat.cwd, "ignored-secret"), "utf8"), "kept local input");
	assert.equal((await reopened.history(id, Number.MAX_SAFE_INTEGER, 100)).entries.length, 1);
	await reopened.restore(id);
	assert.equal(reopened.get(id)?.cwd, chat.cwd);
	await f.assertSourceUnchanged();
});

test("review custody arriving during subprocess inspection blocks permanent discard", async (t) => {
	const f = await fixture(t);
	const chat = await f.spawn();
	await f.sessions.archive(chat.id);
	const entered = deferred();
	const release = deferred();
	t.after(() => release.resolve());
	t.mock.method(f.workers[0]!, "hasChildren", async () => {
		entered.resolve();
		await release.promise;
		return false;
	});
	const refused = assert.rejects(f.sessions.reclaimWorkspace(chat.id), /review|final archive/);
	await entered.promise;
	await f.sessions.preserveWorkingContext(chat.id);
	release.resolve();
	await refused;
	assert.equal(await readFile(join(chat.cwd, "tracked.txt"), "utf8"), "base\n");
	assert.equal((await f.stored(chat.id)).workspaceDiscard, undefined);
	assert.equal((await f.stored(chat.id)).workspaceCustody, "review");
});

test("cold recovery never discards an interrupted native preparation's original files", async (t) => {
	const f = await fixture(t);
	const created = await f.spawn();
	const id = created.id;
	const cwd = created.cwd;
	await writeFile(join(cwd, "ignored-secret"), "Original interrupted work");
	const meta = f.sessions["metas"].get(id)!;
	// Crash after a ready copy materialized, before the preparation record was replaced.
	meta.workspaceCustody = "review";
	meta.preparing = { source: f.source, jj: true };
	delete meta.workspace;
	meta.initializing = true;
	meta.pending = [{ type: "input", requestId: randomUUID(), content: "Original goal", mode: "followUp" }];
	await f.sessions["save"](meta, undefined, undefined, true);
	await f.sessions.shutdown();
	const reopened = await f.manager();
	await reopened["starting"].get(id);
	assert.equal(await readFile(join(cwd, "ignored-secret"), "utf8"), "Original interrupted work");
	assert.equal(reopened.get(id)?.state, "failed");
	assert.match(reopened.get(id)?.error ?? "", /kept|preparation/i);
	await f.assertSourceUnchanged();
});
