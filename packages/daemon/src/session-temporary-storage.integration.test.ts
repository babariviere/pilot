// biome-ignore-all lint/complexity/useLiteralKeys: Exercise private maintenance admission seams.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { TEMPORARY_RETENTION_MS } from "./temporary-storage.ts";
import { deferred, fixture } from "./testing/session-workspace.ts";

test("temporary cleanup requires archived age, worker exit and quiescence; saved data stays", async (t) => {
	const f = await fixture(t);
	const created = await f.spawn("direct");
	const directory = join(f.home, "sessions", created.id);
	const file = join(directory, `meta.json.${randomUUID()}.tmp`);
	await writeFile(file, "abandoned");
	for (const name of ["artifacts", "scratch", "extra-checkout"]) {
		await mkdir(join(directory, name), { recursive: true });
		await writeFile(join(directory, name, "keep"), "saved");
	}
	const meta = f.sessions["metas"].get(created.id)!;
	const now = Date.now() + TEMPORARY_RETENTION_MS + 1_000;
	t.mock.method(Date, "now", () => now);
	const sweep = async () => {
		f.sessions["temporaryStorageSweepAt"] = 0;
		await f.sessions["cleanArchivedTemporaryStorage"]();
	};
	await sweep();
	assert.equal(existsSync(file), true, "active chat is not eligible");
	await f.sessions.archive(created.id);
	meta.archivedAt = now - TEMPORARY_RETENTION_MS + 1;
	await sweep();
	assert.equal(existsSync(file), true, "recent archive is not eligible");
	meta.archivedAt--;
	await sweep();
	assert.equal(existsSync(file), true, "even idle live workers prevent deletion");
	await f.workers[0]!.close();
	f.sessions.setWorkspaceProcessGuard(() => true);
	await sweep();
	assert.equal(existsSync(file), true, "detached terminals prevent deletion");
	f.sessions.setWorkspaceProcessGuard(() => false);
	await sweep();
	assert.equal(existsSync(file), false, "exact archived age boundary is eligible");
	// The existing archive operation owns scratch removal. This sweep never deletes unknown folders.
	assert.equal(await readFile(join(directory, "artifacts", "keep"), "utf8"), "saved");
	assert.equal(await readFile(join(directory, "extra-checkout", "keep"), "utf8"), "saved");
	assert.equal(f.workers.length, 1, "maintenance never opens a worker");
});

test("restore waits for temporary cleanup", async (t) => {
	const f = await fixture(t);
	const created = await f.spawn("direct");
	await f.sessions.archive(created.id);
	await f.workers[0]!.close();
	const now = Date.now() + TEMPORARY_RETENTION_MS;
	t.mock.method(Date, "now", () => now);
	f.sessions["metas"].get(created.id)!.archivedAt = now - TEMPORARY_RETENTION_MS;
	const entered = deferred();
	const release = deferred();
	const unparked = f.sessions["unparked"].bind(f.sessions);
	const parking = f.sessions as unknown as { unparked(id: string): Promise<void> };
	t.mock.method(parking, "unparked", async (id: string) => {
		entered.resolve();
		await release.promise;
		await unparked(id);
	});
	const sweep = f.sessions["cleanArchivedTemporaryStorage"]();
	await entered.promise;
	let restored = false;
	const restore = f.sessions.restore(created.id).then(() => {
		restored = true;
	});
	await Promise.resolve();
	assert.equal(restored, false);
	release.resolve();
	await Promise.all([sweep, restore]);
	assert.equal(f.sessions.get(created.id)!.archivedAt, undefined);
	assert.equal(f.sessions["workspaceMaintenance"].has(created.id), false);
});
