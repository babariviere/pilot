// biome-ignore-all lint/complexity/useLiteralKeys: Bracket access tests private reader concurrency bounds.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ColdViewReader } from "./cold-view-reader.ts";

test("cold-reader threads are concurrency bounded, leave the event loop responsive, and drain on close", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-cold-thread-"));
	const reader = new ColdViewReader();
	t.after(async () => {
		await reader.close();
		await rm(dir, { recursive: true, force: true });
	});
	const results = Promise.allSettled([
		reader.read(join(dir, "one"), dir),
		reader.read(join(dir, "two"), dir),
		reader.read(join(dir, "three"), dir),
	]);
	assert.equal(reader["active"].size, 2);
	assert.equal(reader["waiting"].length, 1);
	await delay(1);
	await reader.close();
	const settled = await results;
	assert.equal(settled[2]?.status, "rejected", "queued work is cancelled on shutdown");
	assert.equal(reader["active"].size, 0);
	assert.equal(reader["waiting"].length, 0);
	await assert.rejects(reader.read(join(dir, "four"), dir), /closed/);
});
