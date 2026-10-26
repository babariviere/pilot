import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MissionReplica, replicaReply } from "./mission-replica.ts";

test("watch-mode notices are not replica replies and never wedge durability", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pilot-replica-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const failures: Error[] = [];
	const replica = new MissionReplica(join(dir, "missions.sqlite"), (error) => failures.push(error));
	try {
		// Node's watch mode posts the worker's imported modules to the same parent port.
		replica.applyReply({ "watch:import": ["file:///tmp/module.ts"] });
		replica.applyReply({ seq: undefined });
		replica.applyReply({ seq: Number.NaN });
		assert.equal(replicaReply({ "watch:import": [] }), undefined);
		assert.equal(replicaReply({ seq: 3 })?.seq, 3);
		const settled = await Promise.race([
			replica.durable().then(
				() => "durable",
				() => "failed",
			),
			new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 1_000)),
		]);
		assert.equal(settled, "durable", "a foreign message must never wedge the mission store");
		assert.equal(replica.pending, false);
		assert.deepEqual(failures, []);
	} finally {
		replica.close();
	}
});

test("a failed batch is reported instead of acknowledged as saved", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pilot-replica-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const failures: Error[] = [];
	const replica = new MissionReplica(join(dir, "missions.sqlite"), (error) => failures.push(error));
	try {
		replica.applyReply({ seq: 1, error: "disk full" });
		assert.equal(failures.length, 1);
		assert.match(failures[0]?.message ?? "", /could not be saved/);
	} finally {
		replica.close();
	}
});

test("close does not wait out its timeout when the worker cannot open the file", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pilot-replica-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	t.mock.method(console, "warn", () => {});
	for (const pending of [0, 2]) {
		const failures: Error[] = [];
		const replica = new MissionReplica(join(dir, "missing", "missions.sqlite"), (error) => failures.push(error));
		for (let i = 0; i < pending; i++) replica.push(new Uint8Array(1));
		const started = Date.now();
		replica.close();
		assert.ok(Date.now() - started < 5_000, `close took ${Date.now() - started} ms with ${pending} pending`);
	}
});
