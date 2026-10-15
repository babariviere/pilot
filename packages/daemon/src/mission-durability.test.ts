import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MissionStore } from "./missions.ts";
import { acknowledgeWhenDurable } from "./server.ts";

async function withFile(run: (file: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pilot-mission-durability-"));
	try {
		await run(join(dir, "missions.sqlite"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function onDisk<T>(file: string, read: (db: DatabaseSync) => T): T {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		return read(db);
	} finally {
		db.close();
	}
}

test("disk-backed stores run in memory and save each commit through the replica", async () => {
	await withFile(async (file) => {
		const store = new MissionStore(file);
		try {
			const internal = store as unknown as { db: DatabaseSync; replica?: { pending: boolean } };
			const main = internal.db.prepare("PRAGMA database_list").all()[0] as { file: string };
			assert.equal(main.file, "", "the event loop never touches the disk file");
			const { id } = store.create({ projectId: "project", title: "Durable" });
			assert.equal(internal.replica?.pending, true, "the commit returns before the disk write");
			assert.ok(store.whenDurable());
			await store.durable();
			assert.equal(store.whenDurable(), undefined);
			assert.equal(
				onDisk(file, (db) => db.prepare("SELECT title FROM missions WHERE id = ?").get(id)?.title),
				"Durable",
			);
			// Autocommit writes outside transactions, cascades and AUTOINCREMENT rows are saved too.
			store.setNoticeActivity(id, true, 1);
			store.addComment(id, { text: "first" });
			const task = store.addTask(id, { title: "Task" });
			store.removeTask(id, task.id);
			await Promise.all([store.durable(), store.durable()]);
			assert.equal(
				onDisk(file, (db) => db.prepare("SELECT busy FROM notice_activity WHERE mission_id = ?").get(id)?.busy),
				1,
			);
			assert.equal(
				onDisk(file, (db) => db.prepare("SELECT COUNT(*) AS n FROM tasks").get()?.n),
				0,
			);
			assert.deepEqual(
				onDisk(file, (db) => db.prepare("SELECT COUNT(*) AS n FROM events WHERE mission_id = ?").get(id)?.n),
				internal.db.prepare("SELECT COUNT(*) AS n FROM events WHERE mission_id = ?").get(id)?.n,
			);
		} finally {
			store.close();
		}
	});
});

test("a failed transaction ships nothing and later commits still save", async () => {
	await withFile(async (file) => {
		const store = new MissionStore(file);
		try {
			const { id } = store.create({ projectId: "project", title: "Rollback" });
			await store.durable();
			assert.throws(() => store.addTask(id, { title: "x", body: "y".repeat(9_000) }));
			assert.equal(store.whenDurable(), undefined, "a rollback leaves nothing to save");
			store.addTask(id, { title: "Kept" });
			await store.durable();
			assert.deepEqual(
				onDisk(file, (db) =>
					db
						.prepare("SELECT title FROM tasks")
						.all()
						.map((row) => row.title),
				),
				["Kept"],
			);
		} finally {
			store.close();
		}
	});
});

test("close saves pending commits, and a reopened store loads them with the same IDs", async () => {
	await withFile(async (file) => {
		const first = new MissionStore(file);
		const { id } = first.create({ projectId: "project", title: "Before close", tasks: [{ title: "A" }] });
		for (let i = 0; i < 200; i++) first.addComment(id, { text: `comment ${i}` });
		const before = first.detail(id);
		const waiting = first.durable();
		first.close();
		await waiting;
		const second = new MissionStore(file);
		try {
			assert.deepEqual(second.detail(id), before);
			// AUTOINCREMENT counters were loaded too, so new rows never reuse an old ID.
			const event = second.addComment(id, { text: "after reopen" });
			assert.ok(!before.comments.some((comment) => comment.id === event.id));
		} finally {
			second.close();
		}
	});
});

test("mutating responses are held until mission writes are durable", async () => {
	let release!: () => void;
	const durable = new Promise<void>((resolve) => {
		release = resolve;
	});
	const ended: unknown[][] = [];
	const res = { end: (...args: unknown[]) => ended.push(args) } as unknown as ServerResponse;
	acknowledgeWhenDurable(res, { durable: () => durable });
	res.end("body");
	await Promise.resolve();
	assert.deepEqual(ended, [], "not acknowledged before the save");
	release();
	await durable;
	await Promise.resolve();
	assert.deepEqual(ended, [["body"]]);
});

test("in-memory stores are durable immediately", async () => {
	const store = new MissionStore(":memory:");
	try {
		store.create({ projectId: "project", title: "Memory" });
		assert.equal(store.whenDurable(), undefined);
		await store.durable();
	} finally {
		store.close();
	}
});
