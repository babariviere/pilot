import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openSessionStorage } from "./storage.ts";

test("session writer enables synced WAL commits before exposing storage", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-synced-storage-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const original = SqliteStorage.open;
	let checked = false;
	t.mock.method(SqliteStorage, "open", async (...args: Parameters<typeof SqliteStorage.open>) => {
		const [database, options] = args;
		assert.equal((await database.get<{ synchronous: number }>("PRAGMA synchronous"))?.synchronous, 2);
		assert.equal((await database.get<{ fullfsync: number }>("PRAGMA fullfsync"))?.fullfsync, 1);
		checked = true;
		return original.call(SqliteStorage, database, options);
	});
	const owned = await openSessionStorage(home);
	try {
		assert.ok(checked);
	} finally {
		await owned.storage.close(BACKGROUND_CONTEXT);
		owned.release();
	}
});
