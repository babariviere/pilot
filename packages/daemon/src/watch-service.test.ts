import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WatchService } from "./watch-service.ts";
import { validateWatch, type WatchInput } from "./watches.ts";

const input: WatchInput = {
	event: "chat.settled",
	target: { kind: "chat", id: "chat" },
	mode: "once",
	note: "Continue the work",
};
test("watches persist, list in creation order, remove idempotently, and reject invalid combinations", async () => {
	const dir = await mkdtemp(join(tmpdir(), "watches-"));
	const path = join(dir, "watches.sqlite");
	let service = new WatchService(path);
	try {
		const a = await service.add(input);
		await service.add({ ...input, event: "pr.merged", target: { kind: "pr", id: "https://github.com/O/R/pull/12" } });
		await service.close();
		service = new WatchService(path);
		assert.equal((await service.list())[0]!.id, a.id);
		assert.equal((await service.list())[1]!.target.id, "https://github.com/o/r/pull/12");
		assert.equal(await service.remove(a.id), true);
		assert.equal(await service.remove(a.id), false);
		await assert.rejects(service.add({ ...input, target: { kind: "linear", id: "ABC-1" } }));
		assert.throws(() => validateWatch({ ...input, note: "x".repeat(4097) }));
		assert.throws(() => validateWatch({ ...input, expiresAt: 1 }));
	} finally {
		await service.close();
		await rm(dir, { recursive: true, force: true });
	}
});
test("expired watches are pruned off-thread", async () => {
	const service = new WatchService(":memory:");
	try {
		await service.list();
		await service.add({ ...input, expiresAt: Date.now() + 500 });
		await new Promise((resolve) => setTimeout(resolve, 550));
		assert.deepEqual(await service.list(), []);
	} finally {
		await service.close();
	}
});
