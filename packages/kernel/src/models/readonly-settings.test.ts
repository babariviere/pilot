import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readonlySettings } from "./readonly-settings.ts";

test("read-only SDK settings retain global/project discovery and reload without creating locks or writing configuration", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-readonly-settings-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const agent = join(root, "agent"),
		cwd = join(root, "project");
	await mkdir(agent);
	await mkdir(join(cwd, ".pi"), { recursive: true });
	const path = join(agent, "settings.json"),
		initial = JSON.stringify({ extensions: ["fixture.ts"], defaultModel: "old" });
	await writeFile(path, initial);
	await writeFile(join(cwd, ".pi/settings.json"), JSON.stringify({ defaultModel: "project" }));
	const manager = readonlySettings(cwd, agent);
	assert.deepEqual(manager.getGlobalSettings().extensions, ["fixture.ts"]);
	assert.equal(manager.getSettings().defaultModel, "project");
	manager.setDefaultModelAndProvider("faux", "runtime-only");
	await manager.flush();
	assert.match(manager.drainErrors()[0]!.error.message, /read-only/);
	assert.equal(await readFile(path, "utf8"), initial);
	assert.deepEqual(await readdir(agent), ["settings.json"]);
	await writeFile(join(root, "replacement"), JSON.stringify({ extensions: ["new.ts"] }));
	await rename(join(root, "replacement"), path);
	await manager.reload();
	assert.deepEqual(manager.getGlobalSettings().extensions, ["new.ts"]);
	await writeFile(join(cwd, ".pi/settings.json"), "invalid");
	assert.throws(() => readonlySettings(cwd, agent), /Read-only settings/);
	assert.deepEqual(readonlySettings(cwd, agent, { projectTrusted: false }).getProjectSettings(), {});
});

test("read-only settings refuse writer locks, malformed/oversized files and failed reloads, while permitting read-only dotfile symlinks", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-readonly-settings-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const canonical = join(root, "canonical"),
		path = join(root, "settings.json");
	await writeFile(canonical, "{}");
	await symlink(canonical, path);
	const manager = readonlySettings(root, root);
	await mkdir(`${path}.lock`);
	assert.throws(() => readonlySettings(root, root), /Read-only settings/);
	await assert.rejects(manager.reload(), /Read-only settings/);
	await rm(`${path}.lock`, { recursive: true });
	for (const value of ["not JSON", "[]", " ".repeat(4 * 1024 * 1024 + 1)]) {
		await writeFile(canonical, value);
		assert.throws(() => readonlySettings(root, root), /Read-only settings/);
	}
	await writeFile(canonical, "{}");
	await manager.reload();
	assert.deepEqual(manager.getGlobalSettings(), {});
});
