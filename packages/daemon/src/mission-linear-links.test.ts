import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MissionStore } from "./missions.ts";

const url = "https://linear.app/acme/issue/ENG-12/title";

test("Linear links default to references; upgrades, contributions and detach are explicit", (t) => {
	const store = new MissionStore(":memory:");
	t.after(() => store.close());
	const { id } = store.create({ projectId: "p", title: "Work", tasks: [{ title: "A" }, { title: "B" }] });
	const reference = store.addResource(id, { url });
	const taskReference = store.addResource(id, { url, taskId: "1" });
	store.shareMission(id);
	assert.equal(reference.linearRole, "reference");
	assert.equal(reference.linearKey, "acme/ENG-12");
	assert.equal(taskReference.linearRole, "reference");
	assert.deepEqual(store.linearTaskLinks(), []);
	store.observeLinearAssignee("p", taskReference.id, { id: "other", name: "Alex" }, "me");
	assert.equal(store.resolveTask(id, "1").status, "todo");
	assert.throws(() => store.addResource(id, { url, linearRole: "managed" }), /PATCH/);
	assert.throws(
		() => store.updateResource(id, taskReference.id, { linearRole: "contribution" }),
		/Manage the Linear ticket/,
	);
	store.updateResource(id, reference.id, { linearRole: "managed" });
	store.updateResource(id, taskReference.id, { linearRole: "contribution" });
	const snapshot = store.sharedSnapshot(id);
	assert.equal(snapshot.detail.resources.find((r) => r.id === taskReference.id)?.linearRole, "contribution");
	const shared = snapshot.entities.find((entity) => entity.kind === "resource" && entity.id === taskReference.id);
	assert.ok(shared);
	assert.equal((shared.value as typeof taskReference).linearRole, "contribution");
	assert.equal(
		store.addResource(id, { url, linearRole: "managed" }).id,
		reference.id,
		"repeated creates are idempotent",
	);
	assert.equal(store.addResource(id, { url, taskId: "1", linearRole: "contribution" }).id, taskReference.id);
	const second = store.addResource(id, { url, taskId: "2", linearRole: "contribution" });
	assert.equal(store.linearTaskLinks().length, 2);
	const anotherUrl = "https://linear.app/acme/issue/ENG-13";
	const anotherManager = store.addResource(id, { url: anotherUrl, linearRole: "managed" });
	const anotherContribution = store.addResource(id, { url: anotherUrl, taskId: "1", linearRole: "contribution" });
	assert.equal(store.linearTaskLinks().length, 3, "one task may contribute to multiple tickets");
	store.removeResource(id, anotherContribution.id);
	store.removeResource(id, anotherManager.id);
	assert.throws(() => store.removeResource(id, reference.id), /Detach task contributions/);
	assert.throws(
		() => store.updateResource(id, reference.id, { linearRole: "reference" }),
		/Detach task contributions/,
	);
	assert.throws(() => store.removeTask(id, "1"), /Detach Linear contributions/);
	store.updateTask(id, "1", { status: "done" });
	store.updateTask(id, "2", { status: "dropped" });
	assert.throws(
		() => store.removeResource(id, reference.id),
		/Detach task contributions/,
		"dropped and done still contribute",
	);
	store.updateResource(id, taskReference.id, { linearRole: "reference" });
	const changes = store.sharedChanges(snapshot.sequence);
	assert.ok(changes.some((change) => change.entity.id === taskReference.id));
	// An already in-flight assignment read is harmless after demotion.
	store.observeLinearAssignee("p", taskReference.id, { id: "other", name: "Alex" }, "me");
	assert.equal(store.resolveTask(id, "1").status, "done");
	store.removeResource(id, second.id);
	store.updateResource(id, reference.id, { linearRole: "reference" });
	assert.equal(store.resolveTask(id, "2").status, "dropped");
	assert.deepEqual(store.linearTaskLinks(), []);
	store.removeTask(id, "1");
	assert.equal(store.detail(id).resources.find((r) => r.id === taskReference.id)?.linearRole, "reference");
});

test("one mission manages each workspace-scoped ticket across projects and URL variants", (t) => {
	const store = new MissionStore(":memory:");
	t.after(() => store.close());
	const a = store.create({ projectId: "a", title: "A", tasks: [{ title: "A" }] }).id;
	const b = store.create({ projectId: "b", title: "B", tasks: [{ title: "B" }] }).id;
	const manager = store.addResource(a, { url, linearRole: "managed" });
	const variant = "https://linear.app/ACME/issue/eng-12/new-title?view=1#comment";
	assert.equal(store.addResource(a, { url: variant, linearRole: "managed" }).id, manager.id);
	assert.throws(
		() => store.addResource(b, { url: "http://linear.app/acme/issue/ENG-12", linearRole: "managed" }),
		/already has a managing mission/,
	);
	assert.throws(() => store.addResource(b, { url: variant, linearRole: "managed" }), /already has a managing mission/);
	const ref = store.addResource(b, { url: variant, taskId: "1" });
	assert.equal(ref.linearRole, "reference");
	assert.throws(() => store.updateResource(b, ref.id, { linearRole: "contribution" }), /Manage the Linear ticket/);
	const missionRef = store.addResource(b, { url: variant });
	assert.throws(
		() => store.updateResource(b, missionRef.id, { linearRole: "managed" }),
		/already has a managing mission/,
	);
	assert.equal(store.detail(b).resources.find((r) => r.id === missionRef.id)?.linearRole, "reference");
	store.addResource(b, { url: "https://linear.app/other/issue/ENG-12", linearRole: "managed" });
	store.removeResource(a, manager.id);
	store.updateResource(b, missionRef.id, { linearRole: "managed" });
	store.updateResource(b, ref.id, { linearRole: "contribution" });
	store.remove(b);
	assert.equal(store.addResource(a, { url, linearRole: "managed" }).linearRole, "managed");
});

test("Linear roles validate issue kind, scope, task membership and authority without partial changes", (t) => {
	const store = new MissionStore(":memory:");
	t.after(() => store.close());
	const { id } = store.create({ projectId: "p", title: "Work", tasks: [{ title: "A" }] });
	const other = store.create({ projectId: "p", title: "Other", tasks: [{ title: "B" }] });
	const foreignTask = store.resolveTask(other.id, "1");
	for (const write of [
		{ url, linearRole: "bogus" },
		{ url, linearRole: null },
		{ url: "https://example.com", linearRole: "managed" },
		{ url: "https://linear.app/acme/project/thing", linearRole: "managed" },
		{ url: "https://linear.app/acme/issue/not-an-id", linearRole: "managed" },
		{ url: "https://linear.app/%61cme/issue/ENG-12", linearRole: "managed" },
		{ url: "https://linear.app/acme/issue/%45NG-12", linearRole: "managed" },
		{ url: "https://linear.app/acme/issue/ENG-012", linearRole: "managed" },
		{ url: "https://linear.app/acme/issue/ENG-0", linearRole: "managed" },
		{ url, taskId: "1", linearRole: "managed" },
		{ url, linearRole: "contribution" },
		{ url, taskId: foreignTask.id, linearRole: "contribution" },
	] as const)
		assert.throws(() => store.addResource(id, write as never));
	assert.deepEqual(store.detail(id).resources, []);
	store.join("coordinator", id);
	store.update(id, { coordinatorSessionId: "coordinator" });
	const actor = { sessionId: "coordinator" };
	assert.throws(
		() => store.addResource(id, { url, linearRole: "managed" }, { sessionId: "member" }),
		/Only the user or coordinator/,
	);
	const managed = store.addResource(id, { url, linearRole: "managed" }, actor);
	const ref = store.addResource(id, { url, taskId: "1" }, { sessionId: "member" });
	assert.throws(
		() => store.updateResource(id, ref.id, { linearRole: "contribution" }, { sessionId: "member" }),
		/Only the user or coordinator/,
	);
	store.updateResource(id, ref.id, { linearRole: "contribution" }, actor);
	assert.throws(() => store.removeResource(id, ref.id, { sessionId: "member" }), /Only the user or coordinator/);
	assert.throws(() => store.updateResource(id, managed.id, {} as never), /Invalid Linear role/);
	assert.throws(() => store.updateResource(other.id, ref.id, { linearRole: "reference" }), /Unknown resource/);
});

test("Linear identity fields are bounded and unsupported identity forms cannot be upgraded", (t) => {
	const store = new MissionStore(":memory:");
	t.after(() => store.close());
	const { id } = store.create({ projectId: "p", title: "Work" });
	const largest = `https://linear.app/${"a".repeat(249)}/issue/ENG-12`;
	assert.equal(store.addResource(id, { url: largest, linearRole: "managed" }).linearKey?.length, 256);
	for (const unsupported of [
		`https://linear.app/${"a".repeat(250)}/issue/ENG-12`,
		"https://linear.app/acme/issue/ENG-012",
		"https://linear.app/%61cme/issue/ENG-12",
		"https://linear.app/acme/issue/%45NG-12",
	]) {
		const reference = store.addResource(id, { url: unsupported });
		assert.equal(reference.linearRole, "reference");
		assert.equal(reference.linearKey, undefined);
		assert.throws(
			() => store.updateResource(id, reference.id, { linearRole: "managed" }),
			/workspace and issue identifier/,
		);
	}
	assert.throws(() => store.addResource(id, { url: `${url}/${"x".repeat(2048)}` }), /url/);
});

test("legacy links migrate as references without resetting delegated tasks or replaying observations", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pilot-linear-migration-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "missions.sqlite");
	let store = new MissionStore(file);
	t.after(() => store.close());
	const { id } = store.create({ projectId: "p", title: "Work", tasks: [{ title: "A" }, { title: "B" }] });
	const mission = store.addResource(id, { url, linearRole: "managed" });
	const link = store.addResource(id, { url, taskId: "1", linearRole: "contribution" });
	const other = store.addResource(id, { url, taskId: "2" });
	store.observeLinearAssignee("p", link.id, { id: "other", name: "Alex" }, "me");
	await store.durable();
	store.close();
	const db = new DatabaseSync(file);
	// Simulate the previous schema, retaining old assignment observations and task provenance.
	db.exec(
		"DROP INDEX linear_ticket_manager; DROP INDEX linear_task_contribution; DROP INDEX resources_by_linear_key; DROP INDEX resources_by_managed_linear; DROP INDEX resources_by_linear_uuid; DROP INDEX resources_by_contributing_task; ALTER TABLE resources DROP COLUMN linear_sync; ALTER TABLE resources DROP COLUMN linear_role; ALTER TABLE resources DROP COLUMN linear_key",
	);
	db.close();
	store = new MissionStore(file);
	const delegated = store.resolveTask(id, "1");
	assert.equal(delegated.status, "delegated");
	assert.equal(delegated.delegatedTo, "Alex");
	for (const resource of store.detail(id).resources) assert.equal(resource.linearRole, "reference");
	assert.deepEqual(store.linearTaskLinks(), []);
	store.observeLinearAssignee("p", link.id, { id: "me", name: "You" }, "me");
	assert.equal(store.resolveTask(id, "1").status, "delegated");
	store.observeLinearAssignee("p", other.id, { id: "other", name: "Alex" }, "me");
	assert.equal(store.resolveTask(id, "2").status, "todo");
	store.updateResource(id, mission.id, { linearRole: "managed" });
	store.updateResource(id, link.id, { linearRole: "contribution" });
	store.observeLinearAssignee("p", link.id, { id: "me", name: "You" }, "me");
	assert.equal(store.resolveTask(id, "1").status, "todo", "only explicit upgrade re-enables restoration");
	await store.durable();
	store.close();
	store = new MissionStore(file);
	assert.equal(store.detail(id).resources.find((r) => r.id === mission.id)?.linearRole, "managed");
	assert.equal(store.detail(id).resources.find((r) => r.id === link.id)?.linearRole, "contribution");
	assert.equal(store.detail(id).resources.find((r) => r.id === other.id)?.linearRole, "reference");
	assert.equal(store.resolveTask(id, "1").status, "todo");
});
