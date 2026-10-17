import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { RecoveryStops } from "./recovery-stops.ts";

test("the cancellation worker needs no credentials and closes before releasing admission", async (t) => {
	const root = await mkdtemp(`${tmpdir()}/pilot-recovery-stop-worker-`);
	const stops = new RecoveryStops();
	t.after(async () => {
		stops.close();
		await rm(root, { recursive: true, force: true });
	});
	const spec = { directory: root, cwd: root, sessionId: "offline" };
	const results = await Promise.all([stops.stop(spec), stops.stop(spec)]);
	assert.deepEqual(results, [[], []]);
	stops.close();
	await assert.rejects(stops.stop(spec), /shutting down/);
});
