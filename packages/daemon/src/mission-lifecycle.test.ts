import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseMissionLifecycle } from "./mission-lifecycle.ts";
import { MissionStore } from "./missions.ts";

test("lifecycle parser pins home and admits only the exact action payload", () => {
	const home = { daemonId: "daemon", lineageId: "lineage" };
	const v = { operationId: randomUUID(), home, projectId: "project", expectedStatus: "active", action: "archive" };
	assert.deepEqual(parseMissionLifecycle(v, home), v);
	for (const bad of [
		{ ...v, home: { ...home, daemonId: "other" } },
		{ ...v, status: "archived" },
		{ ...v, action: "delete" },
		{ ...v, operationId: "bad" },
		{ ...v, expectedStatus: "unknown" },
	])
		assert.throws(() => parseMissionLifecycle(bad, home));
});

test("passive lifecycle is durable, status-only, and never reconciles tasks or drops pending notices", async () => {
	const dir = await mkdtemp(join(tmpdir(), "passive-mission-"));
	const file = join(dir, "missions.sqlite");
	let store = new MissionStore(file);
	try {
		const m = store.create({
			projectId: "project",
			title: "Keep",
			goal: "Goal",
			brief: "# Brief",
			tasks: [{ title: "Task" }],
		});
		store.join("lead", m.id);
		store.join("member", m.id);
		store.update(m.id, { coordinatorSessionId: "lead" });
		store.addComment(m.id, { text: "Pending notice" });
		const pending = store.prepareNotice(m.id, "lead", Date.now() + 120000)!;
		assert.ok(pending);
		assert.ok(store.noticeAllowed("lead", pending.requestId));
		const tasks = store.tasks(m.id);
		const members = store.members(m.id);
		const brief = store.brief(m.id);
		const events = store.events(m.id);
		const changes: boolean[] = [];
		store.onChange((_, passive) => changes.push(!!passive));
		const archived = store.lifecycle(m.id, "project", "active", "archive");
		assert.equal(archived.passiveLifecycle, true);
		assert.equal(archived.title, m.title);
		assert.equal(archived.goal, m.goal);
		assert.throws(() => store.lifecycle(m.id, "project", "active", "archive"));
		assert.throws(() => store.lifecycle(m.id, "other", "archived", "reopen"));
		store.lifecycle(m.id, "project", "archived", "reopen");
		assert.deepEqual(store.tasks(m.id), tasks);
		assert.deepEqual(store.members(m.id), members);
		assert.deepEqual(store.brief(m.id), brief);
		assert.equal(store.events(m.id).length, events.length + 2);
		assert.deepEqual(changes, [true, true]);
		assert.deepEqual(store.pendingNotice(m.id), pending);
		assert.equal(store.noticeAllowed("lead", pending.requestId), false);
		assert.equal(store.prepareNotice(m.id, "lead", Date.now() + 240000), undefined);
		await store.durable();
		store.close();
		store = new MissionStore(file);
		assert.equal(store.passiveLifecycle(m.id), true);
		assert.equal(store.noticeAllowed("lead", pending.requestId), false);
		assert.deepEqual(store.pendingNotice(m.id), pending);
	} finally {
		store.close();
		await rm(dir, { recursive: true, force: true });
	}
});
