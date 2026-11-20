import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { durableJSON } from "./durable-file.ts";

test("durable replacement writes private JSON and removes its own failed temporaries", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-durable-file-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const file = join(home, "record.json");
	await durableJSON(file, { previous: true });
	await durableJSON(file, { text: "café", state: "pending" });
	assert.equal(await readFile(file, "utf8"), '{"text":"café","state":"pending"}');
	assert.equal((await stat(file)).mode & 0o777, 0o600);
	await assert.rejects(durableJSON(file, { invalid: 1n }), TypeError);
	assert.equal(await readFile(file, "utf8"), '{"text":"café","state":"pending"}');
	const blocked = join(home, "directory");
	await mkdir(blocked);
	await assert.rejects(durableJSON(blocked, { state: "pending" }));
	assert.deepEqual((await readdir(home)).sort(), ["directory", "record.json"]);
});
