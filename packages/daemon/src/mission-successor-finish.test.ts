import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { MissionControls } from "./mission-controls.ts";
import { MissionStore } from "./missions.ts";
import { publishedPlanningFixture } from "./published-planning.fixture.ts";
import { pauseParticipants } from "./testing/pause-participants.ts";

test("native migration binds old and published successor; archives only after exact safe Pause", async (t) => {
	const f = await publishedPlanningFixture(t);
	const old = f.store.create({
		projectId: f.project.id,
		title: "Legacy",
		brief: "Historical brief",
		tasks: [{ title: "Kept unpublished work" }],
	});
	f.store.join("old-worker", old.id);
	f.store.updateTask(old.id, "1", { sessionId: "old-worker" });
	f.store.linkSuccessor(old.id, f.missionId, f.project.id, randomUUID());
	const before = f.store.successorPreview(old.id);
	const intent = (p: typeof before) =>
		f.operation(
			old.id,
			{
				purpose: "mission-replan-finish",
				newMissionId: p.newMissionId,
				projectId: p.projectId,
				oldSource: p.oldSource,
				newSource: p.newSource,
				transferLinear: false,
			},
			p.oldSource,
		);
	assert.equal((await f.execute(intent(before))).state, "rejected", "idle is not checkpoint proof");
	const controls = new MissionControls(
		f.store,
		pauseParticipants({
			checkpointMission: async () => "paused",
			resumeMission: async () => "resumed",
		}),
	);
	controls.setScheduleDrain(async () => {});
	const control = f.store.controls.current(old.id);
	const pause = await controls.execute(old.id, {
		version: 1,
		operationId: randomUUID(),
		home: { daemonId: "fixture", lineageId: "fixture" },
		projectId: f.project.id,
		coordinatorSessionId: null,
		expectedRevision: control.revision,
		action: "pause",
	});
	assert.equal(pause.state, "acknowledged");
	assert.equal((await f.execute(intent(before))).state, "rejected", "Pause changed reviewed source");
	const preview = f.store.successorPreview(old.id);
	const tasks = f.store.tasks(old.id),
		brief = f.store.brief(old.id),
		members = f.store.members(old.id);
	const op = intent(preview);
	assert.equal((await f.execute(op)).state, "accepted");
	assert.equal(f.store.require(old.id).status, "archived");
	assert.equal(f.store.successor(old.id)?.state, "finished");
	assert.equal(f.store.require(f.missionId).status, "active");
	assert.deepEqual(f.store.tasks(old.id), tasks);
	assert.deepEqual(f.store.brief(old.id), brief);
	assert.deepEqual(f.store.members(old.id), members);
	assert.equal(f.store.controls.current(old.id).held, true);
	const saved = f.store.successorFinishLookup(op.operationId);
	assert.ok(saved);
	assert.equal((await f.native.lookup(op))?.state, "accepted");
	assert.deepEqual(f.store.successorFinishLookup(op.operationId), saved);
	assert.equal(f.inputs.length, 0, "no model, Start or grant admitted");
	const reopened = new MissionStore(join(f.home, "missions.sqlite"));
	try {
		assert.equal(reopened.require(old.id).status, "archived");
		assert.deepEqual(reopened.successorFinishLookup(op.operationId), saved);
	} finally {
		reopened.close();
	}
});

test("migration refuses abandoned links and changed published source", async (t) => {
	const f = await publishedPlanningFixture(t);
	const old = f.store.create({ projectId: f.project.id, title: "Legacy" });
	f.store.linkSuccessor(old.id, f.missionId, f.project.id, randomUUID());
	const p = f.store.successorPreview(old.id);
	f.store.update(f.missionId, { goal: "Changed publication context" });
	await assert.rejects(
		f.store.finishSuccessor(old.id, {
			operationId: randomUUID(),
			newMissionId: p.newMissionId,
			projectId: p.projectId,
			oldSource: p.oldSource,
			newSource: p.newSource,
			transferLinear: false,
		}),
		/preview changed/,
	);
	f.store.abandonSuccessor(old.id, f.missionId);
	assert.throws(() => f.store.successorPreview(old.id), /No open/);
	assert.equal(f.store.require(old.id).status, "active");
});

test("migration requires published successor and refuses automatic Linear transfer", async (t) => {
	const f = await publishedPlanningFixture(t, { published: false, native: true });
	const old = f.store.create({ projectId: f.project.id, title: "Legacy" });
	f.store.linkSuccessor(old.id, f.missionId, f.project.id, randomUUID());
	assert.throws(() => f.store.successorPreview(old.id), /published successor/);
	const response = await fetch(`${f.root}/api/missions/${old.id}/successor/preview`, {
		headers: { "x-pilot-github-capability": "wrong" },
	});
	assert.equal(response.status, 403);
	const op = f.operation(
		old.id,
		{
			purpose: "mission-replan-finish",
			newMissionId: f.missionId,
			projectId: f.project.id,
			oldSource: "a".repeat(64),
			newSource: "b".repeat(64),
			transferLinear: true,
		},
		"a".repeat(64),
	);
	assert.equal((await f.execute(op)).state, "rejected");
	assert.equal(f.store.require(old.id).status, "active");
});

test("migration preview shows exact agreement/tasks and pins kept-chat facts across durability", async (t) => {
	const f = await publishedPlanningFixture(t, { native: true });
	const old = f.store.create({
		projectId: f.project.id,
		title: "Legacy",
		brief: "Exact old agreement",
		tasks: [{ title: "Kept work" }],
	});
	f.store.linkSuccessor(old.id, f.missionId, f.project.id, randomUUID());
	let title = "Unpublished changes";
	const list = f.sessions.list.bind(f.sessions);
	t.mock.method(f.sessions, "list", (query: Parameters<typeof list>[0] = {}) =>
		query.missionId === old.id
			? [
					{
						id: "kept",
						title,
						cwd: f.home,
						projectId: f.project.id,
						createdAt: 1,
						updatedAt: 1,
						state: "parked" as const,
						unpublishedWork: true,
					},
				]
			: list(query),
	);
	const response = await fetch(`${f.root}/api/missions/${old.id}/successor/preview`, {
		headers: { "x-pilot-github-capability": f.capability },
	});
	assert.equal(response.status, 200);
	const first = await f.native.successorPreview(old.id);
	assert.deepEqual(await response.json(), first);
	assert.deepEqual(first.oldBrief, f.store.brief(old.id));
	assert.deepEqual(first.newBrief, f.store.brief(f.missionId));
	assert.deepEqual(first.oldTasks, f.store.tasks(old.id));
	assert.deepEqual(first.newTasks, f.store.tasks(f.missionId));
	assert.deepEqual(first.keptChats, [{ id: "kept", title, archivedAt: null, unpublishedWork: true }]);
	title = "Changed after review";
	const next = await f.native.successorPreview(old.id);
	assert.notEqual(next.oldSource, first.oldSource);
	const op = f.operation(
		old.id,
		{
			purpose: "mission-replan-finish",
			newMissionId: first.newMissionId,
			projectId: first.projectId,
			oldSource: first.oldSource,
			newSource: first.newSource,
			transferLinear: false,
		},
		first.oldSource,
	);
	assert.equal((await f.execute(op)).state, "rejected");
	assert.equal(f.store.require(old.id).status, "active");
	const durable = f.store.durable.bind(f.store);
	let changed = false;
	t.mock.method(f.store, "durable", async () => {
		await durable();
		if (!changed) {
			changed = true;
			title = "Changed during read";
		}
	});
	await assert.rejects(f.native.successorPreview(old.id), /changed during read/);
});
