import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { removeRetiredProjectMemory } from "./remove-retired-project-memory.ts";

test("startup removes old project logs, summaries, and diagnostics without touching other stores", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-retired-memory-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const retired = join(home, "memory");
	for (const file of [
		"memory/device.sqlite",
		"memory/active-project/log",
		"memory/deleted-project/tree/16",
		"memory/deleted-project/shared.sqlite",
		"memory/deleted-project/compaction-failure.json",
	]) {
		await mkdir(join(home, file, ".."), { recursive: true });
		await writeFile(join(home, file), "retired data");
	}
	const keep = ["missions.sqlite", "projects.json", "sessions/chat/history.sqlite"];
	await mkdir(join(home, "sessions", "chat"), { recursive: true });
	for (const file of keep) await writeFile(join(home, file), file);

	await removeRetiredProjectMemory(home);
	await removeRetiredProjectMemory(home);
	await assert.rejects(lstat(retired), { code: "ENOENT" });
	for (const file of keep) assert.equal(await readFile(join(home, file), "utf8"), file);
});

test("cleanup does not follow a symlink outside the retired store", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-retired-memory-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const sessions = join(home, "sessions");
	await mkdir(sessions);
	await writeFile(join(sessions, "chat"), "chat data");
	await symlink(sessions, join(home, "memory"), "dir");

	await removeRetiredProjectMemory(home);
	await assert.rejects(lstat(join(home, "memory")), { code: "ENOENT" });
	assert.equal(await readFile(join(sessions, "chat"), "utf8"), "chat data");
});
