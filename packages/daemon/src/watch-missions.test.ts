import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MissionStore } from "./missions.ts";
import type { WatchNotice } from "./watch-delivery.ts";
import { MissionWatchSource } from "./watch-missions.ts";
import { WatchService } from "./watch-service.ts";

test("committed task and mission Done activity fires once, distinguishes dropped, preserves notes and suppresses self", async () => {
	const store = new MissionStore(":memory:");
	const watches = new WatchService(":memory:");
	const source = new MissionWatchSource(store, watches);
	const mission = store.create({ projectId: "p", title: "Mission", tasks: [{ title: "One" }, { title: "Two" }] });
	const sent: WatchNotice[] = [];
	try {
		const task = store.tasks(mission.id)[0]!;
		await watches.add({
			event: "mission.task_done",
			target: { kind: "task", id: task.id, missionId: mission.id },
			mode: "once",
			note: "Task action",
		});
		await watches.add({
			event: "mission.task_done",
			target: { kind: "mission", id: mission.id },
			mode: "persistent",
			note: "Any task",
		});
		await watches.add({
			event: "mission.done",
			target: { kind: "mission", id: mission.id },
			mode: "persistent",
			note: "Mission action",
		});
		watches.bindSink({
			sessionId: "control",
			canSend: () => true,
			deliver: async (n) => {
				sent.push(n);
				return true;
			},
		});
		store.updateTask(mission.id, "2", { status: "dropped" });
		store.updateTask(mission.id, "1", { status: "done" });
		store.updateTask(mission.id, "1", { title: "Renamed" });
		store.update(mission.id, { status: "done" });
		await source.idle();
		await watches.flush(Date.now() + 60000);
		assert.equal(sent[0]!.items.length, 3);
		assert.equal((await watches.list()).length, 2);
		store.update(mission.id, { status: "active" });
		store.updateTask(mission.id, "1", { status: "in_progress" });
		store.updateTask(mission.id, "1", { status: "done" }, { sessionId: "control" });
		await source.idle();
		await watches.flush(Date.now() + 60000);
		assert.equal(sent.length, 1);
	} finally {
		await source.stop();
		await watches.close();
		store.close();
	}
});
test("activity committed while bridge is down recovers, with a durable cursor across repeated restart", async () => {
	const dir = await mkdtemp(join(tmpdir(), "watch-missions-"));
	const path = join(dir, "watches.sqlite");
	const store = new MissionStore(":memory:");
	let watches = new WatchService(path);
	const mission = store.create({ projectId: "p", title: "Mission", tasks: [{ title: "Task" }] });
	let source: MissionWatchSource | undefined;
	try {
		await watches.add({
			event: "mission.task_done",
			target: { kind: "mission", id: mission.id },
			mode: "persistent",
			note: "Recover",
		});
		store.updateTask(mission.id, "1", { status: "done" });
		source = new MissionWatchSource(store, watches);
		await source.idle();
		await source.stop();
		await watches.close();
		watches = new WatchService(path);
		const sent: WatchNotice[] = [];
		watches.bindSink({
			sessionId: "control",
			canSend: () => true,
			deliver: async (n) => {
				sent.push(n);
				return true;
			},
		});
		source = new MissionWatchSource(store, watches);
		await source.idle();
		await watches.flush(Date.now() + 60000);
		assert.equal(sent.length, 1);
		assert.equal(sent[0]!.items[0]!.count, 1);
		assert.equal(await watches.cursor("missions"), 1);
		// Replay the source again, not the event.
		await source.stop();
		source = new MissionWatchSource(store, watches);
		await source.idle();
		await watches.flush(Date.now() + 120000);
		assert.equal(sent.length, 1);
	} finally {
		await source?.stop();
		await watches.close();
		store.close();
		await rm(dir, { recursive: true, force: true });
	}
});
