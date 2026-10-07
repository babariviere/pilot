import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProjectStore } from "./projects.ts";

test("creates, updates, persists and removes projects", async () => {
	const home = await mkdtemp(join(tmpdir(), "pilot-projects-"));
	try {
		const store = new ProjectStore(home);
		await store.load();
		const changes: number[] = [];
		store.onChange((projects) => changes.push(projects.length));

		const created = await store.create({ path: home, model: "openai/gpt" });
		assert.equal(created.path, home);
		assert.ok(created.name.startsWith("pilot-projects-"));
		await assert.rejects(store.create({ path: home }), /already uses/);
		await assert.rejects(store.create({ path: join(home, "missing") }), /Not a directory/);

		const updated = await store.update(created.id, { name: "Pilot", model: "" });
		assert.equal(updated.name, "Pilot");
		assert.equal(updated.model, undefined);

		const reopened = new ProjectStore(home);
		await reopened.load();
		assert.deepEqual(reopened.list(), [updated]);

		await store.remove(created.id);
		assert.deepEqual(store.list(), []);
		assert.deepEqual(changes, [1, 1, 0]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
