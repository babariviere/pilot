import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

test("storage preview lists unexpected folders without deleting or following links", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pilot-storage-preview-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const home = await realpath(directory);
	const session = join(home, "sessions", randomUUID());
	for (const name of ["artifacts", "scratch", "workspace", "durable", "workspace-recovery"])
		await mkdir(join(session, name), { recursive: true });
	await writeFile(join(session, "meta.json"), JSON.stringify({ archivedAt: 1 }));
	await writeFile(join(session, "artifacts", "kept.json"), "saved artifact");
	await writeFile(join(session, "scratch", "output"), "temporary output");
	await mkdir(join(home, "outside"));
	await writeFile(join(home, "outside", "secret"), "not counted");
	await symlink(join(home, "outside"), join(session, "scratch", "link"));
	const before = await readFile(join(session, "meta.json"), "utf8");
	const { stdout } = await promisify(execFile)(process.execPath, [
		fileURLToPath(new URL("./storage-preview.ts", import.meta.url)),
		home,
	]);
	const result = JSON.parse(stdout);
	assert.equal(result.sessions, 1);
	assert.equal(result.artifactBytes, Buffer.byteLength("saved artifact"));
	assert.deepEqual(result.review, [
		{
			path: join(session, "scratch"),
			bytes: Buffer.byteLength("temporary output"),
			partial: false,
			reason: "Unknown folder or legacy scratch; manual review required, never automatically deleted",
			archived: true,
		},
	]);
	assert.equal(await readFile(join(session, "meta.json"), "utf8"), before);
	assert.equal(await readFile(join(session, "scratch", "output"), "utf8"), "temporary output");
	assert.match(result.note, /No changes made/);
});
