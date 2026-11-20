import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MissionControls } from "./mission-controls.ts";
import { MissionStore } from "../missions.ts";
import {
	pauseRevisionWork,
	type RevisionWorkPause,
	resumeRevisionWork,
	revisionPauseOwnershipMatches,
} from "./revision-work-pause.ts";
import { pauseParticipants } from "../../testing/pause-participants.ts";

test("revision checkpoints affected owners and dependents only; explicit Resume is separate", async (t) => {
	const store = new MissionStore(":memory:");
	t.after(() => store.close());
	const { id } = store.create({
		projectId: "p",
		title: "M",
		tasks: [{ title: "Changed" }, { title: "Dependent" }, { title: "Independent" }],
	});
	for (const owner of ["a", "b", "c"]) store.join(owner, id);
	store.updateTask(id, "1", { sessionId: "a" });
	store.updateTask(id, "2", { sessionId: "b", dependsOn: [store.resolveTask(id, "1").id] });
	store.updateTask(id, "3", { sessionId: "c" });
	const source = store.revisions.source(id);
	const p = await store.revisions.propose(
		id,
		{
			operationId: randomUUID(),
			source,
			summary: "Changed task",
			delta: { tasks: [{ id: "1", title: "Reviewed" }] },
		},
		{},
	);
	const calls: string[] = [],
		resumes: string[] = [];
	const participants = pauseParticipants({
		checkpointMission: async (sessionId: string) => {
			calls.push(sessionId);
			return "paused" as const;
		},
		resumeMission: async (sessionId: string) => {
			resumes.push(sessionId);
			return "resumed" as const;
		},
	});
	const controls = new MissionControls(store, participants);
	const input = { operationId: randomUUID(), proposalId: p.id, digest: p.digest, source };
	await assert.rejects(store.revisions.confirm(id, p.id, { digest: p.digest, humanSource: "human" }), /Pause/);
	const pause = await pauseRevisionWork(store, participants, id, input);
	assert.equal(pause.state, "paused");
	assert.deepEqual(calls, ["a", "b"]);
	assert.equal(controls.fence("a")?.held, true);
	assert.equal(controls.fence("c")?.held, false);
	assert.equal(store.controls.current(id).state, "running", "not a global Paused claim");
	assert.equal(store.revisionTaskHeld(id, store.resolveTask(id, "1").id), true);
	assert.equal(store.revisionTaskHeld(id, store.resolveTask(id, "2").id), true);
	assert.equal(store.revisionTaskHeld(id, store.resolveTask(id, "3").id), false);
	assert.equal(store.revisions.source(id), source);
	assert.deepEqual(await pauseRevisionWork(store, participants, id, input), pause);
	assert.equal(calls.length, 2);
	await store.revisions.confirm(id, p.id, { digest: p.digest, humanSource: "human" });
	assert.equal(controls.fence("a")?.held, true, "confirmation keeps exact hold");
	assert.deepEqual(resumes, []);
	const resume = await resumeRevisionWork(store, participants, id, {
		operationId: randomUUID(),
		pauseOperationId: input.operationId,
		source: store.revisions.source(id),
	});
	assert.equal(resume.state, "resumed");
	assert.deepEqual(resumes, ["a", "b"]);
	assert.equal(controls.fence("a")?.held, false);
	assert.equal(store.revisionTaskHeld(id, store.resolveTask(id, "1").id), false);
});

test("unknown selective checkpoint is lookup-only, never safe application or global Pause", async (t) => {
	const store = new MissionStore(":memory:");
	t.after(() => store.close());
	const { id } = store.create({ projectId: "p", title: "M", tasks: [{ title: "Work" }] });
	store.join("a", id);
	store.updateTask(id, "1", { sessionId: "a" });
	const source = store.revisions.source(id);
	const p = await store.revisions.propose(
		id,
		{ operationId: randomUUID(), source, summary: "Global", delta: { goal: "New goal" } },
		{},
	);
	let calls = 0;
	const participants = pauseParticipants({
		checkpointMission: async () => {
			calls++;
			throw new Error("Lost checkpoint reply");
		},
		resumeMission: async () => "resumed" as const,
	});
	const input = { operationId: randomUUID(), proposalId: p.id, digest: p.digest, source };
	const pause = await pauseRevisionWork(store, participants, id, input);
	assert.equal(pause.state, "unknown");
	assert.equal(store.controls.current(id).held, false);
	await pauseRevisionWork(store, participants, id, input);
	assert.equal(calls, 1);
	await assert.rejects(store.revisions.confirm(id, p.id, { digest: p.digest, humanSource: "human" }), /Pause/);
	await assert.rejects(
		resumeRevisionWork(store, participants, id, {
			operationId: randomUUID(),
			pauseOperationId: input.operationId,
			source,
		}),
		/checkpoint changed/,
	);
});

for (const change of ["source", "archive", "membership"] as const) {
	test(`Resume ${change} race inside participant admission remains Unknown`, async (t) => {
		const store = new MissionStore(":memory:");
		t.after(() => store.close());
		const { id } = store.create({ projectId: "p", title: "M", tasks: [{ title: "One" }, { title: "Two" }] });
		for (const [ref, owner] of [
			["1", "a"],
			["2", "b"],
		]) {
			store.join(owner!, id);
			store.updateTask(id, ref!, { sessionId: owner! });
		}
		const source = store.revisions.source(id);
		const p = await store.revisions.propose(
			id,
			{ operationId: randomUUID(), source, summary: "Global", delta: { goal: "Reviewed" } },
			{},
		);
		let entered!: () => void, release!: () => void;
		const waiting = new Promise<void>((r) => {
				entered = r;
			}),
			gate = new Promise<void>((r) => {
				release = r;
			});
		let calls = 0,
			admitted = 0;
		const participants = pauseParticipants({
			checkpointMission: async () => "paused" as const,
			resumeMission: async (_id: string, _op: string, _fence: unknown, guard?: () => void) => {
				calls++;
				entered();
				await gate;
				guard?.();
				admitted++;
				return "resumed" as const;
			},
		});
		const pause = await pauseRevisionWork(store, participants, id, {
			operationId: randomUUID(),
			proposalId: p.id,
			digest: p.digest,
			source,
		});
		const input = { operationId: randomUUID(), pauseOperationId: pause.operationId, source };
		const resume = resumeRevisionWork(store, participants, id, input);
		await waiting;
		if (change === "source") store.update(id, { goal: "Concurrent" });
		else if (change === "archive") store.lifecycle(id, "p", "active", "archive");
		else store.leave("a");
		release();
		assert.equal((await resume).state, "unknown");
		assert.equal(admitted, 0);
		assert.equal(calls, 1, "no second member admitted");
		assert.equal((await resumeRevisionWork(store, participants, id, input)).state, "unknown");
		assert.equal(calls, 1, "retry is lookup only");
	});
}

for (const stage of ["resuming", "resumed"] as const) {
	test(`Resume rechecks ${stage} persistence before admission or acknowledgement`, async (t) => {
		const store = new MissionStore(":memory:");
		t.after(() => store.close());
		const { id } = store.create({ projectId: "p", title: "M", tasks: [{ title: "One" }] });
		store.join("a", id);
		store.updateTask(id, "1", { sessionId: "a" });
		const source = store.revisions.source(id);
		const p = await store.revisions.propose(
			id,
			{ operationId: randomUUID(), source, summary: "Global", delta: { goal: "Reviewed" } },
			{},
		);
		let calls = 0;
		const participants = pauseParticipants({
			checkpointMission: async () => "paused" as const,
			resumeMission: async () => {
				calls++;
				return "resumed" as const;
			},
		});
		const pause = await pauseRevisionWork(store, participants, id, {
			operationId: randomUUID(),
			proposalId: p.id,
			digest: p.digest,
			source,
		});
		const write = store.controls.writeRevisionPause.bind(store.controls);
		let changed = false;
		t.mock.method(store.controls, "writeRevisionPause", async (record: RevisionWorkPause) => {
			await write(record);
			if (!changed && record.state === stage) {
				changed = true;
				store.update(id, { goal: "Concurrent" });
			}
		});
		const result = await resumeRevisionWork(store, participants, id, {
			operationId: randomUUID(),
			pauseOperationId: pause.operationId,
			source,
		});
		assert.equal(result.state, "unknown");
		assert.equal(store.controls.revisionPause(pause.operationId)?.state, "unknown");
		assert.equal(calls, stage === "resuming" ? 0 : 1);
	});
}

test("a separately held member's delayed release still needs its exact Resume source", async (t) => {
	const store = new MissionStore(":memory:");
	t.after(() => store.close());
	const { id } = store.create({ projectId: "p", title: "M" });
	store.join("a", id);
	const source = store.revisions.source(id);
	const p = await store.revisions.propose(
		id,
		{ operationId: randomUUID(), source, summary: "Global", delta: { goal: "Reviewed" } },
		{},
	);
	const participants = pauseParticipants({
		checkpointMission: async () => "paused" as const,
		resumeMission: async () => "held" as const,
	});
	const controls = new MissionControls(store, participants);
	const pause = await pauseRevisionWork(store, participants, id, {
		operationId: randomUUID(),
		proposalId: p.id,
		digest: p.digest,
		source,
	});
	await resumeRevisionWork(store, participants, id, {
		operationId: randomUUID(),
		pauseOperationId: pause.operationId,
		source,
	});
	assert.equal(controls.resumeAuthorized("a", pause.operationId), true);
	store.update(id, { goal: "Changed later" });
	assert.equal(controls.resumeAuthorized("a", pause.operationId), false);
});

for (const change of ["reassign", "drop", "project", "flow-root", "ownership-ABA"] as const) {
	test(`Resume refuses ${change} against persisted Pause ownership even with a fresh source`, async (t) => {
		const store = new MissionStore(":memory:");
		t.after(() => store.close());
		const { id } = store.create({ projectId: "p", title: "M", tasks: [{ title: "Owned" }] });
		store.join("a", id);
		store.join("b", id);
		store.updateTask(id, "1", { sessionId: "a" });
		let projectId = "p",
			root = "a",
			calls = 0;
		const participants = pauseParticipants({
			get: () => ({ projectId, createdAt: 1 }),
			missionWorkSessions: () => ["flow"],
			missionWorkOwner: (id: string) => (id === "flow" ? root : id),
			checkpointMission: async () => "paused" as const,
			resumeMission: async () => {
				calls++;
				return "resumed" as const;
			},
		});
		const source = store.revisions.source(id);
		const p = await store.revisions.propose(
			id,
			{ operationId: randomUUID(), source, summary: "Title", delta: { tasks: [{ id: "1", title: "Changed" }] } },
			{},
		);
		const pause = await pauseRevisionWork(store, participants, id, {
			operationId: randomUUID(),
			proposalId: p.id,
			digest: p.digest,
			source,
		});
		assert.equal(pause.state, "paused");
		if (change === "reassign") store.updateTask(id, "1", { sessionId: "b" });
		else if (change === "drop") store.updateTask(id, "1", { status: "dropped" });
		else if (change === "project") projectId = "other-project";
		else if (change === "flow-root") root = "b";
		else {
			store.updateTask(id, "1", { sessionId: "b" });
			store.updateTask(id, "1", { sessionId: "a" });
		}
		assert.equal(revisionPauseOwnershipMatches(store, participants, pause), false);
		await assert.rejects(
			resumeRevisionWork(store, participants, id, {
				operationId: randomUUID(),
				pauseOperationId: pause.operationId,
				source: store.revisions.source(id),
			}),
			/checkpoint changed/,
		);
		assert.equal(calls, 0);
	});
}

for (const change of ["reassign", "drop", "project", "flow-root"] as const) {
	test(`delayed held release refuses ${change} from saved Pause binding after reopen`, async (t) => {
		const home = await mkdtemp(join(tmpdir(), "revision-pause-owner-")),
			path = join(home, "missions.sqlite");
		let store = new MissionStore(path);
		t.after(async () => {
			store.close();
			await rm(home, { recursive: true, force: true });
		});
		const { id } = store.create({ projectId: "p", title: "M", tasks: [{ title: "Owned" }] });
		store.join("a", id);
		store.join("b", id);
		store.updateTask(id, "1", { sessionId: "a" });
		let projectId = "p",
			root = "a";
		const participants = pauseParticipants({
			get: () => ({ projectId, createdAt: 1 }),
			missionWorkSessions: () => ["flow"],
			missionWorkOwner: (id: string) => (id === "flow" ? root : id),
			checkpointMission: async () => "paused" as const,
			resumeMission: async () => "held" as const,
		});
		const source = store.revisions.source(id);
		const p = await store.revisions.propose(
			id,
			{ operationId: randomUUID(), source, summary: "Title", delta: { tasks: [{ id: "1", title: "Changed" }] } },
			{},
		);
		const pause = await pauseRevisionWork(store, participants, id, {
			operationId: randomUUID(),
			proposalId: p.id,
			digest: p.digest,
			source,
		});
		assert.equal(
			(
				await resumeRevisionWork(store, participants, id, {
					operationId: randomUUID(),
					pauseOperationId: pause.operationId,
					source,
				})
			).state,
			"resumed",
		);
		await store.durable();
		store.close();
		store = new MissionStore(path);
		const controls = new MissionControls(store, participants);
		assert.equal(
			controls.resumeAuthorized("a", pause.operationId),
			true,
			"saved release survives restart without temporary guards",
		);
		const saved = store.controls.revisionPause(pause.operationId)!;
		assert.deepEqual(saved.ownership, pause.ownership);
		if (change === "reassign") store.updateTask(id, "1", { sessionId: "b" });
		else if (change === "drop") store.updateTask(id, "1", { status: "dropped" });
		else if (change === "project") projectId = "other-project";
		else root = "b";
		await store.durable();
		assert.equal(revisionPauseOwnershipMatches(store, participants, saved), false);
		assert.equal(controls.resumeAuthorized("a", pause.operationId), false);
	});
}
