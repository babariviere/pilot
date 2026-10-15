import assert from "node:assert/strict";
import { test } from "node:test";
import { MissionStore } from "./missions.ts";

test("continuation atomically retains multi-task claims, coordinator role, PR links and deletion tombstones", (t) => {
	const store = new MissionStore(":memory:");
	t.after(() => store.close());
	const mission = store.create({ projectId: "p", title: "Work", tasks: [{ title: "One" }, { title: "Two" }] });
	store.join("old", mission.id);
	store.claimTask(mission.id, "1", "old");
	const removed = "https://github.com/octo/repo/pull/1";
	const owned = "https://github.com/octo/repo/pull/2";
	store.linkAutomaticPullRequests("old", [removed]);
	store.removeResource(mission.id, store.detail(mission.id).resources[0]!.id);
	store.applyPullRequestBinding({
		id: "bind",
		sessionId: "old",
		url: owned,
		bound: true,
		taskId: store.resolveTask(mission.id, "1").id,
		missionId: mission.id,
		previousSessionIds: [],
		actor: {},
	});
	store.applyPullRequestBinding({
		id: "exclude",
		sessionId: "old",
		url: "https://github.com/octo/repo/pull/3",
		bound: false,
		missionId: mission.id,
		previousSessionIds: [],
		actor: {},
	});
	store.claimTask(mission.id, "2", "old");
	store.update(mission.id, { coordinatorSessionId: "old" });
	const before = store.detail(mission.id);
	store.continueSession("old", "new");
	store.continueSession("old", "new");
	assert.equal(store.missionOf("old"), undefined);
	assert.throws(() => store.join("old", mission.id), /continued elsewhere/);
	assert.equal(store.missionOf("new"), mission.id);
	assert.equal(store.require(mission.id).coordinatorSessionId, "new");
	assert.deepEqual(
		store.detail(mission.id).tasks.map(({ sessionId, status }) => ({ sessionId, status })),
		[
			{ sessionId: "new", status: "in_progress" },
			{ sessionId: "new", status: "in_progress" },
		],
	);
	assert.deepEqual(
		store.detail(mission.id).resources.map(({ id, taskId, url }) => ({ id, taskId, url })),
		before.resources.map(({ id, taskId, url }) => ({ id, taskId, url })),
	);
	// Removing ambiguity later must not resurrect a first-observation deletion in the successor.
	store.releaseTask(mission.id, "2");
	store.linkAutomaticPullRequests("new", [removed]);
	assert.ok(!store.detail(mission.id).resources.some((resource) => resource.url === removed));
	// biome-ignore lint/complexity/useLiteralKeys: Inspect durable negative binding tombstones.
	const binding = store["db"]
		.prepare("SELECT session_id, url, bound, task_id FROM pull_request_bindings WHERE session_id = ? ORDER BY url")
		.all("new");
	assert.equal(binding.length, 2);
	assert.equal(binding[0]?.bound, 1);
	assert.equal(binding[0]?.task_id, store.resolveTask(mission.id, "1").id);
	assert.equal(binding[1]?.bound, 0, "negative binding tombstones transfer too");
});
