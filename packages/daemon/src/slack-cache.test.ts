import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SLACK_DAILY_BUDGET, TrackedItemDisk } from "./tracked-items-disk.ts";
import { TrackedItemStore } from "./tracked-items.ts";

const result = {
	type: "unknown" as const,
	confidence: 0.99,
	severity: "low" as const,
	summary: "Weekly update",
	label: null,
};
const now = Date.UTC(2026, 9, 13);
test("durable project cache includes Unknown, errors and interrupted attempts; budget survives restart", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "slack-cache-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const path = join(home, "tracked.sqlite");
	let disk = new TrackedItemDisk(path);
	assert.equal(disk.slackCached("C1", "1.000001", "p"), undefined);
	assert.deepEqual(disk.reserveSlack("C1", "1.000001", now, "p"), { state: "reserved" });
	assert.deepEqual(disk.reserveSlack("C1", "1.000001", now, "p"), { state: "pending" });
	disk.finishSlack("C1", "1.000001", result, "p");
	assert.deepEqual(disk.reserveSlack("C1", "1.000001", now, "p"), { state: "done", result });
	assert.deepEqual(disk.reserveSlack("C2", "1.000001", now, "p"), { state: "reserved" });
	disk.finishSlack("C2", "1.000001", undefined, "p");
	for (let i = 3; i <= SLACK_DAILY_BUDGET; i++)
		assert.deepEqual(disk.reserveSlack("C1", `${i}.000001`, now, "p"), { state: "reserved" });
	disk.close();
	disk = new TrackedItemDisk(path);
	t.after(() => disk.close());
	assert.deepEqual(disk.slackCached("C1", "1.000001", "p"), { state: "done", result });
	assert.deepEqual(disk.slackCached("C2", "1.000001", "p"), { state: "error" });
	assert.deepEqual(disk.reserveSlack("C1", "3.000001", now + 86_400_000, "p"), { state: "pending" });
	assert.deepEqual(disk.reserveSlack("C1", "101.000001", now, "p"), { state: "budget" });
	assert.deepEqual(disk.reserveSlack("C1", "101.000001", now + 86_400_000, "p"), { state: "reserved" });
	assert.throws(() => disk.reserveSlack("#bugs", "bad", now, "p"), /Invalid Slack thread key/);
	assert.throws(
		() => disk.finishSlack("C1", "101.000001", { ...result, confidence: 2 }, "p"),
		/Invalid Slack classification/,
	);
});
test("worker reservations are atomic under concurrent calls and preserve completed records", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "slack-cache-worker-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const store = new TrackedItemStore(join(home, "tracked.sqlite"));
	t.after(() => store.close());
	const rows = await Promise.all(Array.from({ length: 8 }, () => store.reserveSlack("C1", "1.000001", now, "p")));
	assert.equal(rows.filter((row) => row.state === "reserved").length, 1);
	await store.finishSlack("C1", "1.000001", result, "p");
	await store.finishSlack("C1", "1.000001", undefined, "p");
	assert.deepEqual(await store.slackCached("C1", "1.000001", "p"), { state: "done", result });
});
