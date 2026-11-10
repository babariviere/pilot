import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { abandonedAtomicFiles, cleanTemporaryStorage, TEMPORARY_RETENTION_MS } from "./temporary-storage.ts";

test("only old exact atomic files are candidates; links, locks and arbitrary tmp files stay", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-temporary-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = await realpath(root);
	const candidate = join(directory, `meta.json.${randomUUID()}.tmp`);
	await writeFile(candidate, "abandoned");
	for (const name of ["meta.json", "custom.tmp", ".daemon-upgrade.lock", `projects.json.${randomUUID()}.tmp`])
		await writeFile(join(directory, name), "keep");
	await symlink(candidate, join(directory, `ai-usage.json.${randomUUID()}.tmp`));
	const hardlink = join(directory, `meta.json.${randomUUID()}.tmp`);
	await writeFile(hardlink, "keep");
	await link(hardlink, join(directory, "hardlink"));
	assert.deepEqual(await abandonedAtomicFiles(directory, "session", Date.now()), []);
	const now = Date.now() + TEMPORARY_RETENTION_MS + 1_000;
	assert.deepEqual(await abandonedAtomicFiles(directory, "session", now), [candidate]);
	await cleanTemporaryStorage(directory, "session", now, () => {});
	assert.equal(existsSync(candidate), false);
	assert.equal(await readFile(hardlink, "utf8"), "keep");
	assert.equal(existsSync(join(directory, "custom.tmp")), true);
});

test("safety rejection prevents deletion and unknown directories are always preserved", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-temporary-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = await realpath(root);
	const path = join(directory, `meta.json.${randomUUID()}.tmp`);
	await writeFile(path, "abandoned");
	const now = Date.now() + TEMPORARY_RETENTION_MS + 1_000;
	for (const name of ["artifacts", "scratch", "durable", "workspace-recovery", "extra-checkout"]) {
		await mkdir(join(directory, name));
		await writeFile(join(directory, name, "keep"), "saved");
	}
	await assert.rejects(
		cleanTemporaryStorage(directory, "session", now, () => {
			throw new Error("busy");
		}),
		/busy/,
	);
	assert.equal(existsSync(path), true);
	await cleanTemporaryStorage(directory, "session", now, () => {});
	assert.equal(existsSync(path), false);
	assert.equal(await readFile(join(directory, "artifacts", "keep"), "utf8"), "saved");
	assert.equal(await readFile(join(directory, "extra-checkout", "keep"), "utf8"), "saved");
});

test("symlinked directories are never traversed, and home scope excludes session files", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-temporary-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = await realpath(root);
	await mkdir(join(directory, "outside"));
	await symlink(join(directory, "outside"), join(directory, "temporary"));
	const candidate = join(directory, "outside", `meta.json.${randomUUID()}.tmp`);
	await writeFile(candidate, "keep");
	const now = Date.now() + TEMPORARY_RETENTION_MS + 1_000;
	assert.deepEqual(await abandonedAtomicFiles(join(directory, "temporary"), "session", now), []);
	await cleanTemporaryStorage(join(directory, "temporary"), "session", now, () => {});
	assert.equal(existsSync(candidate), true);
	assert.deepEqual(await abandonedAtomicFiles(join(directory, "outside"), "home", now), []);
	const homeFile = join(directory, "outside", `projects.json.${randomUUID()}.tmp`);
	await writeFile(homeFile, "abandoned");
	await cleanTemporaryStorage(join(directory, "outside"), "home", now, () => {});
	assert.equal(existsSync(homeFile), false);
	assert.equal(existsSync(candidate), true);
});
