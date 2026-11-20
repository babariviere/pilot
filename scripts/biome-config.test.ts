import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("formatting skips target caches and installer-owned skill lock metadata", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pilot-biome-target-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const project = join(directory, "project");
	const cache = join(directory, "shared-cache");
	for (const path of [join(project, "apps/day"), join(project, "nested/helper"), cache])
		await mkdir(path, { recursive: true });
	await copyFile(new URL("../biome.json", import.meta.url), join(project, "biome.json"));
	const unformatted = '{"cache":true}';
	const lock = '{\n  "skills": { "fixture": { "hash": "unchanged" } }\n}\n';
	await writeFile(join(project, "skills-lock.json"), lock);
	await writeFile(join(cache, "writable.json"), unformatted);
	await writeFile(join(cache, "invalid.json"), "{ invalid generated JSON");
	await symlink(cache, join(project, "apps/day/target"), "dir");
	await symlink(join(directory, "missing-cache"), join(project, "nested/helper/target"), "dir");
	await mkdir(join(project, "target"));
	await writeFile(join(project, "target/invalid.json"), "{ invalid local build output");
	const source = join(project, "apps/day/sources/source.ts");
	await writeFile(source, "export const source={value:1};");
	const result = spawnSync(
		process.execPath,
		[fileURLToPath(new URL("../node_modules/@biomejs/biome/bin/biome", import.meta.url)), "format", "--write", "."],
		{ cwd: project, encoding: "utf8", timeout: 10_000 },
	);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.equal(await readFile(join(cache, "writable.json"), "utf8"), unformatted);
	assert.equal(await readFile(join(project, "skills-lock.json"), "utf8"), lock);
	assert.equal(await readFile(join(cache, "invalid.json"), "utf8"), "{ invalid generated JSON");
	assert.equal(await readFile(join(project, "target/invalid.json"), "utf8"), "{ invalid local build output");
	assert.equal(await readFile(source, "utf8"), "export const source = { value: 1 };\n");
	// Negative control: the same disposable tree exposes generated files without the exclusion.
	const config = join(project, "biome.json");
	const configuration = JSON.parse(await readFile(config, "utf8"));
	configuration.files.includes = configuration.files.includes.filter((pattern: string) => pattern !== "!!**/target");
	await writeFile(config, JSON.stringify(configuration, null, "\t"));
	const exposed = spawnSync(
		process.execPath,
		[fileURLToPath(new URL("../node_modules/@biomejs/biome/bin/biome", import.meta.url)), "format", "."],
		{ cwd: project, encoding: "utf8", timeout: 10_000 },
	);
	assert.notEqual(exposed.status, 0);
	assert.match(exposed.stdout + exposed.stderr, /target\/invalid\.json/);
});
