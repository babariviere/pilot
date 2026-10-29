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
	assert.equal(parseMissionLifecycle({ ...v, action: "complete" }, home).action, "complete");
	for (const bad of [
		{ ...v, home: { ...home, daemonId: "other" } },
		{ ...v, status: "archived" },
		{ ...v, action: "delete" },
		{ ...v, operationId: "bad" },
		{ ...v, expectedStatus: "unknown" },
	])
		assert.throws(() => parseMissionLifecycle(bad, home));
});

test("passive completion follows finished-task semantics and atomically rejects reopened work", async () => {
	const dir = await mkdtemp(join(tmpdir(), "complete-mission-"));
	let store = new MissionStore(join(dir, "missions.sqlite"));
	try {
		const m = store.create({
			projectId: "project",
			title: "Keep",
			brief: "# Brief",
			tasks: [{ title: "Done" }, { title: "Dropped" }],
		});
		store.join("lead", m.id);
		store.join("working-member", m.id);
		store.update(m.id, { coordinatorSessionId: "lead" });
		const [a, b] = store.tasks(m.id);
		assert.ok(a && b);
		for (const status of ["todo", "in_progress", "blocked", "in_review", "delegated"] as const) {
			store.updateTask(m.id, a.id, { status });
			assert.throws(() => store.lifecycle(m.id, "project", "active", "complete"), /every remaining task/);
			assert.equal(store.require(m.id).status, "active");
		}
		store.updateTask(m.id, a.id, { status: "done" });
		store.updateTask(m.id, b.id, { status: "dropped" });
		// User saw all work finished, then another writer reopened a task before admission.
		assert.equal(store.require(m.id).tasksDone, store.require(m.id).tasksTotal);
		store.updateTask(m.id, a.id, { status: "todo" });
		assert.throws(() => store.lifecycle(m.id, "project", "active", "complete"), /every remaining task/);
		store.updateTask(m.id, a.id, { status: "done" });
		assert.throws(() => store.lifecycle(m.id, "other", "active", "complete"), /confirmed mission/);
		assert.throws(() => store.lifecycle(m.id, "project", "done", "complete"), /confirmed mission/);
		store.addComment(m.id, { text: "Pending notice" });
		const pending = store.prepareNotice(m.id, "lead", Date.now() + 120000);
		const tasks = store.tasks(m.id);
		const members = store.members(m.id);
		const brief = store.brief(m.id);
		let completions = 0;
		store.onCompleted(() => completions++);
		const changes: boolean[] = [];
		store.onChange((_, passive) => changes.push(!!passive));
		const done = store.lifecycle(m.id, "project", "active", "complete");
		assert.equal(done.status, "done");
		assert.equal(done.passiveLifecycle, true);
		assert.ok(done.completedAt);
		assert.equal(completions, 0, "no tracker completion side effect");
		assert.deepEqual(changes, [true]);
		assert.deepEqual(store.tasks(m.id), tasks);
		assert.deepEqual(store.members(m.id), members);
		assert.deepEqual(store.brief(m.id), brief);
		assert.deepEqual(store.pendingNotice(m.id), pending);
		assert.throws(() => store.lifecycle(m.id, "project", "done", "complete"), /transition/);
		await store.durable();
		store.close();
		store = new MissionStore(join(dir, "missions.sqlite"));
		assert.equal(store.require(m.id).status, "done");
		assert.equal(store.require(m.id).completedAt, done.completedAt);
		assert.equal(store.require(m.id).passiveLifecycle, true);
		store.lifecycle(m.id, "project", "done", "reopen");
		assert.deepEqual(store.tasks(m.id), tasks);
		assert.equal(store.require(m.id).completedAt, undefined);
		for (const droppedOnly of [false, true]) {
			const empty = store.create({
				projectId: "project",
				title: "Empty",
				tasks: droppedOnly ? [{ title: "Drop" }] : [],
			});
			if (droppedOnly) store.updateTask(empty.id, "1", { status: "dropped" });
			assert.throws(() => store.lifecycle(empty.id, "project", "active", "complete"), /at least one done task/);
		}
	} finally {
		store.close();
		await rm(dir, { recursive: true, force: true });
	}
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
