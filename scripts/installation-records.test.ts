import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeNewDurableFile } from "./installation-records.ts";

test("installation evidence preserves exact bytes and refuses replacement", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pilot-installation-records-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "entry");
	const bytes = '{ "draft": "日本語 👩‍💻" }\n';
	await writeNewDurableFile(path, bytes);
	assert.equal(await readFile(path, "utf8"), bytes);
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	await assert.rejects(writeNewDurableFile(path, "replacement"), { code: "EEXIST" });
	assert.equal(await readFile(path, "utf8"), bytes);
});

test("concurrent evidence writers admit one winner and never follow a symlink", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pilot-installation-records-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "entry");
	const payloads = ["first", "second"];
	const results = await Promise.allSettled(payloads.map((bytes) => writeNewDurableFile(path, bytes)));
	assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
	const winner = results.findIndex((result) => result.status === "fulfilled");
	assert.equal(await readFile(path, "utf8"), payloads[winner]);
	for (const result of results) {
		if (result.status === "rejected") assert.equal(result.reason.code, "EEXIST");
	}
	const target = join(directory, "target");
	await writeFile(target, "keep");
	const alias = join(directory, "alias");
	await symlink(target, alias);
	await assert.rejects(writeNewDurableFile(alias, "overwrite"), { code: "EEXIST" });
	assert.equal(await readFile(target, "utf8"), "keep");
});
