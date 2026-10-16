import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MissionStore } from "./missions.ts";

test("sharing feed is enrollment-scoped, seeded transactionally and rolls back with canonical writes", () => {
	const store = new MissionStore(":memory:");
	try {
		const mission = store.create({ projectId: "p", title: "Local", tasks: [{ title: "Before enrollment" }] });
		store.updateTask(mission.id, "1", { body: "Local-only edit" });
		assert.equal(store.sharedHead(), 0);
		store.shareMission(mission.id);
		assert.equal(store.sharedSnapshot(mission.id).entities.filter((entity) => entity.kind === "task").length, 1);
		const before = store.sharedHead();
		assert.throws(
			() =>
				store.sharingTransaction(() => {
					store.updateTask(mission.id, "1", { body: "rolled back" });
					throw new Error("fault");
				}),
			/fault/,
		);
		assert.equal(store.sharedHead(), before);
		assert.equal(store.resolveTask(mission.id, "1").body, "Local-only edit");
		store.updateTask(mission.id, "1", { body: "Shared edit" });
		const changes = store.sharedChanges(before);
		assert.ok(
			changes.some(
				(change) =>
					change.entity.kind === "task" && (change.entity.value as { body: string }).body === "Shared edit",
			),
		);
		store.removeTask(mission.id, "1");
		assert.ok(store.sharedChanges(before).some((change) => change.entity.kind === "task" && change.entity.deleted));
	} finally {
		store.close();
	}
});

test("file-backed mission changeset apply preserves exact shared sequence/revisions across restart", async () => {
	const home = await mkdtemp(join(tmpdir(), "pilot-sharing-durable-"));
	const file = join(home, "missions.sqlite");
	let store = new MissionStore(file);
	try {
		const mission = store.create({ projectId: "p", title: "Shared", tasks: [{ title: "Task" }] });
		store.shareMission(mission.id);
		store.writeBrief(mission.id, "Initial", 0);
		store.updateTask(mission.id, "1", { body: "Revision two" });
		const decision = store.addDecision(mission.id, "Keep provenance");
		store.removeDecision(mission.id, decision.id);
		const head = store.sharedHead(),
			snapshot = store.sharedSnapshot(mission.id),
			changes = store.sharedChanges(0);
		await store.durable();
		const disk = new DatabaseSync(file, { readOnly: true });
		assert.equal(
			Number(disk.prepare("SELECT MAX(sequence) n FROM shared_changes").get()!.n),
			head,
			"applyChangeset must not execute source triggers twice",
		);
		disk.close();
		store.close();
		store = new MissionStore(file);
		assert.equal(store.sharedHead(), head);
		assert.deepEqual(store.sharedSnapshot(mission.id), snapshot);
		assert.deepEqual(store.sharedChanges(0), changes);
		const revision = store.sharedDefinitionRevision(store.resolveTask(mission.id, "1").id);
		store.updateTask(mission.id, "1", { status: "blocked" });
		assert.ok(
			store.sharedDefinitionRevision(store.resolveTask(mission.id, "1").id) > revision,
			"explicit status intent fences stale result projection",
		);
		await store.durable();
	} finally {
		store.close();
		await rm(home, { recursive: true, force: true });
	}
});
