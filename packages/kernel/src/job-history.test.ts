import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JobHistory } from "./job-history.ts";

test("new-owner history becomes durable uncertainty before admission and never resets", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "job-history-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const file = join(root, "history");
	const history = await JobHistory.open(file, true);
	history.assertClear();
	const admission = history.admit();
	assert.throws(() => history.assertClear(), /descendant exit/);
	await admission;
	assert.equal(JSON.parse(await readFile(file, "utf8")).state, "unknown");
	assert.equal((await stat(file)).mode & 0o777, 0o600);
	for (const fresh of [false, true]) {
		const reopened = await JobHistory.open(file, fresh);
		assert.throws(() => reopened.assertClear(), /descendant exit/);
	}
});

test("missing legacy, malformed and symlinked histories cannot certify clean ownership", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "job-history-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const file = join(root, "history");
	const missing = await JobHistory.open(file);
	assert.throws(() => missing.assertClear(), /descendant exit/);
	await missing.admit();
	assert.equal(JSON.parse(await readFile(file, "utf8")).state, "unknown");
	await writeFile(file, "partial");
	const partial = await JobHistory.open(file, true);
	assert.throws(() => partial.assertClear(), /descendant exit/);
	await rm(file);
	await writeFile(join(root, "other"), '{"schema":1,"state":"clean"}');
	await symlink(join(root, "other"), file);
	const link = await JobHistory.open(file, true);
	assert.throws(() => link.assertClear(), /descendant exit/);
	await assert.rejects(link.admit());
});

test("failed history persistence blocks admission and remains failed", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "job-history-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const file = join(root, "history");
	const history = await JobHistory.open(file, true);
	await rm(file);
	await mkdir(file);
	await assert.rejects(history.admit());
	await assert.rejects(history.admit());
	assert.throws(() => history.assertClear(), /descendant exit/);
});
