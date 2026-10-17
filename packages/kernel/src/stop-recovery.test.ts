import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { stopRecoveryChildren } from "./stop-recovery.ts";
import { openSessionStorage } from "./storage.ts";

test("recovery cancellation respects the parent writer lease and requires no configured model or credentials", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-stop-recovery-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const owned = await openSessionStorage(root);
	const spec = { directory: root, cwd: root, sessionId: "offline-stop" };
	await assert.rejects(stopRecoveryChildren(spec), /already has an owner/);
	await owned.storage.close(BACKGROUND_CONTEXT);
	owned.release();
	t.mock.method(globalThis, "fetch", () => assert.fail("Cancellation must not access models or credentials"));
	assert.deepEqual(await stopRecoveryChildren(spec), []);
});
