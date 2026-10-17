import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MissionReplica } from "./mission-replica.ts";

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
