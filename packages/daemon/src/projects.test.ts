import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("PR requirements default on for legacy projects and persist explicit settings", async () => {
	const home = await mkdtemp(join(tmpdir(), "pilot-project-pr-"));
	try {
		const legacy = { id: "legacy", name: "Legacy", path: home, createdAt: 1 };
		await writeFile(join(home, "projects.json"), JSON.stringify([legacy]));
		const store = new ProjectStore(home);
		await store.load();
		assert.notEqual(store.require(legacy.id).requirePullRequest, false);
		await store.update(legacy.id, { requirePullRequest: false });
		await store.update(legacy.id, { name: "Renamed" });
		const reopened = new ProjectStore(home);
		await reopened.load();
		assert.equal(reopened.require(legacy.id).requirePullRequest, false);
		await reopened.update(legacy.id, { requirePullRequest: true });
		await store.load();
		assert.equal(store.require(legacy.id).requirePullRequest, true);
		await store.remove(legacy.id);
		const created = await store.create({ path: home, requirePullRequest: false });
		assert.equal(created.requirePullRequest, false);
		await reopened.load();
		assert.equal(reopened.require(created.id).requirePullRequest, false);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("rejects invalid PR requirement values without changing projects", async () => {
	const home = await mkdtemp(join(tmpdir(), "pilot-project-pr-"));
	try {
		const store = new ProjectStore(home);
		await store.load();
		for (const invalid of ["false", 0, null, {}]) {
			// API JSON is untyped at runtime, even though callers normally supply a boolean.
			await assert.rejects(
				store.create({ path: home, requirePullRequest: invalid as boolean }),
				/requirePullRequest must be a boolean/,
			);
		}
		assert.deepEqual(store.list(), []);
		const created = await store.create({ path: home });
		await assert.rejects(
			store.update(created.id, { requirePullRequest: "false" as unknown as boolean }),
			/requirePullRequest must be a boolean/,
		);
		assert.equal(store.require(created.id).requirePullRequest, undefined);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
