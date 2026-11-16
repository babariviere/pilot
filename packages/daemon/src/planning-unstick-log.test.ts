import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { UNSTICK_LOG_BYTES, UnstickLog } from "./planning-unstick-log.ts";

test("the unstick log appends entries in order and keeps one older file past its size", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "unstick-log-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const file = join(root, "diagnostics", "unstick.jsonl");
	const log = new UnstickLog(file);
	log.record({ action: "continue", missionId: "m1" });
	log.record({ action: "stalled", missionId: "m1" });
	await log.written();
	const lines = (await readFile(file, "utf8"))
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
	assert.deepEqual(
		lines.map((l) => l.action),
		["continue", "stalled"],
	);
	assert.match(lines[0].at, /^\d{4}-\d{2}-\d{2}T/);
	assert.equal((await stat(file)).mode & 0o777, 0o600);
	// Past the size, the current file becomes the older one and a new file starts.
	const big = "x".repeat(UNSTICK_LOG_BYTES / 2);
	for (let i = 0; i < 3; i++) log.record({ action: "repair-agent", note: big });
	await log.written();
	const older = await readFile(`${file}.1`, "utf8");
	const now = await readFile(file, "utf8");
	assert.ok(Buffer.byteLength(now) <= UNSTICK_LOG_BYTES);
	assert.equal(now.trim().split("\n").length, 1);
	assert.ok(older.length > 0);
});
