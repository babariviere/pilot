import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { SessionSummary } from "@pilot/protocol";
import type { SessionManager } from "./sessions.ts";
import { WatchService } from "./watch-service.ts";
import { SessionWatchSource } from "./watch-sessions.ts";

test("10,000 indexed watches and 500 active chats keep streaming off SQLite and the event loop responsive", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "watch-stress-"));
	const path = join(dir, "watches.sqlite");
	let service = new WatchService(path);
	await service.list();
	await service.close();
	const db = new DatabaseSync(path);
	const insert = db.prepare("INSERT INTO watches VALUES(?,?,?,?,?,?,NULL)");
	db.exec("BEGIN");
	for (let i = 0; i < 10000; i++) {
		const watch = {
			id: String(i),
			event: "chat.settled",
			target: { kind: "chat", id: `c${i}` },
			mode: "persistent",
			note: "Follow up",
			createdAt: 0,
		};
		insert.run(watch.id, watch.event, "chat", watch.target.id, "", JSON.stringify(watch));
	}
	db.exec("COMMIT");
	db.close();
	service = new WatchService(path);
	await service.list();
	let callback!: (s: SessionSummary) => void;
	const chats = Array.from(
		{ length: 500 },
		(_, i) =>
			({
				id: `c${i}`,
				title: "chat",
				state: "working",
				working: true,
				mode: "build",
				cwd: "/tmp",
				sessionPath: "/tmp",
				createdAt: 0,
				updatedAt: 0,
			}) as SessionSummary,
	);
	const source = new SessionWatchSource(service, {
		list: () => chats,
		onChange: (f: typeof callback) => {
			callback = f;
			return () => {};
		},
	} as unknown as SessionManager);
	const histogram = monitorEventLoopDelay({ resolution: 10 });
	histogram.enable();
	try {
		const started = performance.now();
		for (let i = 0; i < 100; i++) for (const chat of chats) callback({ ...chat, updatedAt: i });
		const streaming = performance.now() - started;
		assert.ok(streaming < 1000, `streaming projection: ${streaming}ms`);
		const at = Date.now();
		const settled = performance.now();
		for (const chat of chats) callback({ ...chat, state: "idle", working: false, outcome: "done", outcomeAt: at });
		await source.idle();
		let total = 0;
		service.bindSink({
			sessionId: "control",
			canSend: () => true,
			deliver: async (n) => {
				total += n.items.length;
				return true;
			},
		});
		for (let i = 0; i < 5; i++) await service.flush(at + 60000);
		assert.equal(total, 500);
		t.diagnostic(
			`50,000 streaming snapshots ${streaming.toFixed(1)}ms; 500 settlements + 5 deliveries ${(performance.now() - settled).toFixed(1)}ms; loop max ${(histogram.max / 1e6).toFixed(1)}ms, mean ${(histogram.mean / 1e6).toFixed(1)}ms`,
		);
	} finally {
		histogram.disable();
		await source.stop();
		await service.close();
		await rm(dir, { recursive: true, force: true });
	}
});
