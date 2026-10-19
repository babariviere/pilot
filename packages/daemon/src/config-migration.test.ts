import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { migratePilotConfig } from "./config-migration.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
	const root = await mkdtemp(join(tmpdir(), "pilot-config-migration-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const agent = join(root, "agent");
	const config = join(root, "config", "pilot");
	await mkdir(agent);
	return { root, agent, config };
}

test("startup moves legacy configuration unchanged, preserving permissions, before readers start", async (t) => {
	const f = await fixture(t);
	for (const [oldName, , mode] of [
		["pilot-databases.json", "database.json", 0o600],
		["pilot-tracking.json", "tracking.json", 0o640],
	] as const) {
		// Migration must not parse, rewrite, repair permissions or print credential-bearing content.
		const bytes = `  { "private-fixture": "${oldName}" }\n`;
		await writeFile(join(f.agent, oldName), bytes);
		await chmod(join(f.agent, oldName), mode);
	}
	await migratePilotConfig(f.agent, f.config);
	for (const [oldName, newName, mode] of [
		["pilot-databases.json", "database.json", 0o600],
		["pilot-tracking.json", "tracking.json", 0o640],
	] as const) {
		assert.equal(await readFile(join(f.config, newName), "utf8"), `  { "private-fixture": "${oldName}" }\n`);
		assert.equal((await stat(join(f.config, newName))).mode & 0o777, mode);
		await assert.rejects(stat(join(f.agent, oldName)), { code: "ENOENT" });
	}
	assert.equal((await stat(f.config)).mode & 0o777, 0o700);
	await migratePilotConfig(f.agent, f.config);
	await rm(join(f.config, "database.json"));
	await migratePilotConfig(f.agent, f.config);
	await assert.rejects(stat(join(f.config, "database.json")), { code: "ENOENT" });
});

test("an unavailable config directory leaves legacy files intact and reports only fixed messages", async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.agent, "pilot-databases.json"), "private-fixture");
	await writeFile(join(f.agent, "pilot-tracking.json"), "private-fixture");
	await writeFile(join(f.root, "config"), "not-a-directory");
	const warnings: string[] = [];
	t.mock.method(console, "warn", (message: string) => warnings.push(message));
	await migratePilotConfig(f.agent, f.config);
	assert.equal(await readFile(join(f.agent, "pilot-databases.json"), "utf8"), "private-fixture");
	assert.equal(await readFile(join(f.agent, "pilot-tracking.json"), "utf8"), "private-fixture");
	assert.equal(warnings.length, 2);
	assert.ok(warnings.every((message) => !message.includes("private-fixture") && !message.includes(f.root)));
});

test("migration never overwrites existing Pilot files, including invalid files or symlinks", async (t) => {
	const f = await fixture(t);
	await mkdir(f.config, { recursive: true });
	await writeFile(join(f.agent, "pilot-databases.json"), "legacy-database");
	await writeFile(join(f.agent, "pilot-tracking.json"), "legacy-tracking");
	await writeFile(join(f.config, "database.json"), "invalid-but-do-not-overwrite");
	const target = join(f.root, "target");
	await writeFile(target, "keep-target");
	await symlink(target, join(f.config, "tracking.json"));
	await migratePilotConfig(f.agent, f.config);
	assert.equal(await readFile(join(f.config, "database.json"), "utf8"), "invalid-but-do-not-overwrite");
	assert.equal(await readFile(target, "utf8"), "keep-target");
	assert.equal(await readFile(join(f.agent, "pilot-databases.json"), "utf8"), "legacy-database");
	assert.equal(await readFile(join(f.agent, "pilot-tracking.json"), "utf8"), "legacy-tracking");
});

test("missing legacy configuration does not create a directory; nonregular sources stay untouched", async (t) => {
	const f = await fixture(t);
	await migratePilotConfig(f.agent, f.config);
	await assert.rejects(stat(f.config), { code: "ENOENT" });
	const target = join(f.root, "target");
	await writeFile(target, "private-fixture");
	await symlink(target, join(f.agent, "pilot-databases.json"));
	await mkdir(join(f.agent, "pilot-tracking.json"));
	const warnings: string[] = [];
	t.mock.method(console, "warn", (message: string) => warnings.push(message));
	await migratePilotConfig(f.agent, f.config);
	assert.equal(await readFile(target, "utf8"), "private-fixture");
	await assert.rejects(stat(f.config), { code: "ENOENT" });
	assert.equal(warnings.length, 2);
	assert.ok(warnings.every((message) => !message.includes("private-fixture")));
});
