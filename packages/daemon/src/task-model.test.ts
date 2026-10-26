import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MissionStore } from "./missions.ts";
import { parseTaskModel } from "./task-model.ts";

test("passive preference parser pins home, requires both nullable fields, rejects task mutations", () => {
	const home = { daemonId: "daemon", lineageId: "lineage" };
	const value = {
		operationId: randomUUID(),
		home,
		projectId: "project",
		preferredModel: "provider/model*#~",
		preferredThinking: null,
	};
	assert.deepEqual(parseTaskModel(value, home), value);
	assert.ok(parseTaskModel({ ...value, preferredModel: null }, home));
	for (const bad of [
		{ ...value, home: { ...home, daemonId: "other" } },
		{ ...value, operationId: "wrong" },
		{ ...value, preferredModel: null, preferredThinking: "high" },
		{ ...value, preferredThinking: "" },
		{ ...value, preferredModel: undefined },
		{ ...value, preferredThinking: undefined },
		{ ...value, status: "done" },
		{ ...value, sessionId: null },
		{ ...value, dependsOn: [] },
	])
		assert.throws(() => parseTaskModel(bad, home));
});

test("passive preference is durable and preserves all task fields, notices, phases and membership", async () => {
	const dir = await mkdtemp(join(tmpdir(), "task-model-"));
	const path = join(dir, "missions.sqlite");
	let store = new MissionStore(path);
	try {
		const m = store.create({
			projectId: "project",
			title: "M",
			tasks: [{ title: "Keep", body: "Body" }],
		});
		store.join("lead", m.id);
		store.join("member", m.id);
		store.update(m.id, { coordinatorSessionId: "lead" });
		const task = store.tasks(m.id)[0]!;
		store.updateTask(m.id, task.id, { sessionId: "member" });
		store.addComment(m.id, { text: "Existing notice" });
		const before = store.task(m.id, task.id),
			members = store.members(m.id),
			phases = store.phases(m.id);
		const pending = store.prepareNotice(m.id, "lead", Date.now() + 120000);
		const changes: unknown[] = [],
			memberChanges: string[] = [];
		store.onChange((...args) => changes.push(args));
		store.onMembershipChange((id) => memberChanges.push(id));
		const changed = store.taskModel(m.id, "project", task.id, {
			preferredModel: "provider/model*#~",
			preferredThinking: "high",
		});
		assert.equal(changed.preferredModelSetBy, "user");
		assert.deepEqual(
			{
				...changed,
				updatedAt: before.updatedAt,
				preferredModel: undefined,
				preferredThinking: undefined,
				preferredModelSetBy: undefined,
			},
			{ ...before, preferredModel: undefined, preferredThinking: undefined, preferredModelSetBy: undefined },
		);
		assert.deepEqual(changes, [[m.id, true, true]]);
		assert.deepEqual(memberChanges, []);
		assert.deepEqual(store.members(m.id), members);
		assert.deepEqual(store.phases(m.id), phases);
		assert.deepEqual(store.pendingNotice(m.id), pending);
		assert.throws(() => store.taskModel(m.id, "other", task.id, { preferredModel: null, preferredThinking: null }));
		assert.throws(() =>
			store.taskModel(m.id, "project", String(task.number), { preferredModel: null, preferredThinking: null }),
		);
		assert.throws(() =>
			store.taskModel(m.id, "project", task.id, { preferredModel: null, preferredThinking: null, status: "done" }),
		);
		store.taskModel(m.id, "project", task.id, { preferredModel: "provider/model*#~", preferredThinking: null });
		assert.equal(store.task(m.id, task.id).preferredThinking, undefined);
		await store.durable();
		store.close();
		store = new MissionStore(path);
		assert.equal(store.task(m.id, task.id).preferredModel, "provider/model*#~");
		assert.equal(store.task(m.id, task.id).preferredModelSetBy, "user");
		const cleared = store.taskModel(m.id, "project", task.id, { preferredModel: null, preferredThinking: null });
		assert.equal(cleared.preferredModel, undefined);
		assert.equal(cleared.preferredThinking, undefined);
		assert.equal(cleared.preferredModelSetBy, undefined);
	} finally {
		store.close();
		await rm(dir, { recursive: true, force: true });
	}
});
