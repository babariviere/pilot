import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readModelDefaults, writeModelDefaults } from "./model-controls-store.ts";

test("native defaults preserve advanced bytes and pins; CAS refuses external edits", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "model-defaults-write-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const path = join(home, "settings.json");
	const advanced =
		'"extensions": [ "private-extension" ], "modelThinkingLevels": { "p/a": "high" }, "enabledModels": ["p/*:low"]';
	await writeFile(path, `{ ${advanced}, "defaultModel": "a", "defaultProvider": "p" }`);
	const original = await readModelDefaults(home);
	await writeModelDefaults(home, original.defaultsHash, {
		...original.defaults,
		defaultModel: "b",
		pilotTaskPriceLimit: 24,
	});
	assert.ok((await readFile(path, "utf8")).includes(advanced));
	const after = await readModelDefaults(home);
	assert.equal(after.defaults.defaultModel, "b");
	assert.equal(after.defaults.pilotTaskPriceLimit, 24);
	await assert.rejects(writeModelDefaults(home, original.defaultsHash, original.defaults), /changed/);
	assert.equal((await readModelDefaults(home)).defaults.defaultModel, "b");
	await writeModelDefaults(home, after.defaultsHash, { ...after.defaults, defaultModel: null, defaultProvider: null });
	assert.ok((await readFile(path, "utf8")).includes(advanced));
	assert.equal(JSON.parse(await readFile(path, "utf8")).defaultModel, undefined);
});

test("native default edits follow settings links but reject dangling links and malformed settings", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "model-defaults-link-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const path = join(home, "settings.json"),
		target = join(home, "external.json");
	await writeFile(target, "{}");
	await symlink(target, path);
	const before = await readModelDefaults(home);
	await writeModelDefaults(home, before.defaultsHash, { ...before.defaults, defaultThinkingLevel: "high" });
	assert.equal((await lstat(path)).isSymbolicLink(), true);
	assert.equal(JSON.parse(await readFile(target, "utf8")).defaultThinkingLevel, "high");
	await writeFile(target, "{broken");
	await assert.rejects(readModelDefaults(home));
	await assert.rejects(writeModelDefaults(home, before.defaultsHash, before.defaults));
	assert.equal(await readFile(target, "utf8"), "{broken");
	await rm(target);
	await assert.rejects(readModelDefaults(home));
});
