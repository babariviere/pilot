import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { MissionControlCommand } from "@pilot/protocol";
import { MissionControls, type MissionPauseParticipants, parseMissionControl } from "./mission-controls.ts";
import { MissionStore } from "./missions.ts";

const home = { daemonId: "daemon", lineageId: "lineage" };
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}
function fixture(t: TestContext, port: Partial<MissionPauseParticipants> = {}) {
	const store = new MissionStore(":memory:");
	t.after(() => store.close());
	const mission = store.create({ projectId: "project", title: "Synthetic" });
	const ids = [randomUUID(), randomUUID()];
	for (const id of ids) store.join(id, mission.id);
	const pauses: string[] = [],
		resumes: string[] = [];
	const controls = new MissionControls(store, {
		checkpointMission: async (id) => {
			pauses.push(id);
			return "paused";
		},
		resumeMission: async (id) => {
			resumes.push(id);
			return "resumed";
		},
		...port,
	});
	controls.setScheduleDrain(async () => {});
	const command = (action: "pause" | "resume" = "pause", pauseOperationId?: string): MissionControlCommand => ({
		version: 1,
		operationId: randomUUID(),
		home,
		projectId: mission.projectId,
		coordinatorSessionId: null,
		expectedRevision: store.controls.current(mission.id).revision,
		action,
		...(pauseOperationId ? { pauseOperationId } : {}),
	});
	return { store, controls, mission, ids, pauses, resumes, command };
}

test("native confirmation is exact and host qualified", () => {
	const command: MissionControlCommand = {
		version: 1,
		home,
		operationId: randomUUID(),
		projectId: "p",
		coordinatorSessionId: null,
		expectedRevision: 0,
		action: "pause",
	};
	assert.deepEqual(parseMissionControl(command, home), command);
	assert.throws(() => parseMissionControl({ ...command, actor: "user" }, home));
	assert.throws(() => parseMissionControl(command, { ...home, lineageId: "other" }));
	assert.throws(() => parseMissionControl({ ...command, expectedRevision: -1 }, home));
	assert.throws(() => parseMissionControl({ ...command, action: "resume" }, home));
});

test("Pause fences before I/O, joins schedules, shows Pausing, and Resume owns only its members", async (t) => {
	const drain = deferred();
	const f = fixture(t, {
		checkpointMission: async (id) => {
			f.pauses.push(id);
			return id === f.ids[0] ? "paused" : "held";
		},
	});
	f.controls.setScheduleDrain(() => drain.promise);
	const command = f.command();
	const pausing = f.controls.execute(f.mission.id, command);
	assert.equal(f.store.controls.current(f.mission.id).state, "pausing");
	assert.throws(() => f.controls.assertOpen(f.mission.id), /paused/);
	assert.equal(f.pauses.length, 0);
	drain.resolve();
	const pause = await pausing;
	assert.equal(pause.state, "acknowledged");
	assert.equal(pause.control.state, "paused");
	assert.equal(f.pauses.length, 2);
	const resume = await f.controls.execute(f.mission.id, f.command("resume", command.operationId));
	assert.equal(resume.control.state, "running");
	assert.deepEqual(f.resumes, [f.ids[0]]);
	assert.equal(f.controls.fence(f.ids[0]!)!.pauseGeneration, 1);
	assert.equal(f.controls.fence("unrelated"), null);
	assert.deepEqual(
		await f.controls.execute(f.mission.id, command),
		pause,
		"lost client ACK returns its historical receipt",
	);
	assert.equal(f.pauses.length, 2);
});

test("concurrent control CAS, changed payloads, owner and home cannot broaden admission", async (t) => {
	const f = fixture(t),
		command = f.command();
	const first = f.controls.execute(f.mission.id, command);
	await assert.rejects(f.controls.execute(f.mission.id, { ...command, operationId: randomUUID() }), /changed/);
	await first;
	await assert.rejects(f.controls.execute(f.mission.id, { ...command, projectId: "other" }), /identity/);
	await assert.rejects(
		f.controls.execute(f.mission.id, {
			...f.command("resume", command.operationId),
			coordinatorSessionId: randomUUID(),
		}),
		/owner/,
	);
});

test("failed/lost participant ACK stays Pausing and exact retries never call it again", async (t) => {
	let calls = 0;
	const f = fixture(t, {
		checkpointMission: async () => {
			calls++;
			throw new Error("close ACK lost");
		},
	});
	const command = f.command(),
		result = await f.controls.execute(f.mission.id, command);
	assert.equal(result.state, "unknown");
	assert.equal(result.control.state, "pausing");
	assert.equal(result.control.held, true);
	assert.equal(
		result.members.every((m) => m.state === "unknown"),
		true,
	);
	await f.controls.execute(f.mission.id, command);
	assert.equal(calls, 2);
	await assert.rejects(f.controls.execute(f.mission.id, f.command("resume", command.operationId)), /acknowledged/);
});

test("Stop during Pause retains its generation and cannot be overwritten by completion", async (t) => {
	const f = fixture(t, {
		checkpointMission: async () => {
			f.store.controls.stop(f.mission.id);
			return "paused";
		},
	});
	const result = await f.controls.execute(f.mission.id, f.command());
	assert.equal(result.state, "unknown");
	assert.equal(result.control.held, true);
	assert.equal(result.control.stopGeneration, 1);
	assert.equal(result.members.filter((m) => m.state === "paused").length, 1);
});

test("membership and coordinator races never grant selective resume", async (t) => {
	const f = fixture(t),
		command = f.command();
	await f.controls.execute(f.mission.id, command);
	f.store.leave(f.ids[0]!);
	await assert.rejects(f.controls.execute(f.mission.id, f.command("resume", command.operationId)), /membership/);
	assert.equal(f.resumes.length, 0);
});

test("missing schedule adapter or uncertain dispatch cannot claim Paused", async (t) => {
	const f = fixture(t);
	f.controls.setScheduleDrain(async () => {
		throw new Error("schedule dispatch Unknown");
	});
	const result = await f.controls.execute(f.mission.id, f.command());
	assert.equal(result.state, "unknown");
	assert.equal(result.control.state, "pausing");
	assert.equal(f.pauses.length, 2, "known local work must still checkpoint");
	assert.match(result.issues![0]!, /schedule dispatch Unknown/);
});

test("Resume preserves independent holds; their later release needs the exact durable operation", async (t) => {
	const f = fixture(t, { resumeMission: async () => "held" });
	const pause = f.command();
	await f.controls.execute(f.mission.id, pause);
	assert.equal(f.controls.resumeAuthorized(f.ids[0]!, pause.operationId), false);
	await f.controls.execute(f.mission.id, f.command("resume", pause.operationId));
	assert.equal(f.controls.resumeAuthorized(f.ids[0]!, pause.operationId), true);
	assert.equal(f.controls.resumeAuthorized(f.ids[0]!, randomUUID()), false);
	f.store.controls.stop(f.mission.id);
	await f.store.durable();
	assert.equal(f.controls.resumeAuthorized(f.ids[0]!, pause.operationId), false);
});

test("coordinator ABA during participant I/O keeps the operation uncertain", async (t) => {
	const f = fixture(t, {
		checkpointMission: async () => {
			f.store.update(f.mission.id, { coordinatorSessionId: f.ids[0]! });
			f.store.update(f.mission.id, { coordinatorSessionId: null });
			return "paused";
		},
	});
	const result = await f.controls.execute(f.mission.id, f.command());
	assert.equal(result.state, "unknown");
	assert.equal(result.control.held, true);
});

test("recovery after entered effect is lookup-only and keeps the admission fence", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-mission-controls-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const file = join(dir, "missions.sqlite"),
		store = new MissionStore(file);
	const mission = store.create({ projectId: "p", title: "Synthetic" });
	store.join(randomUUID(), mission.id);
	let calls = 0;
	const controls = new MissionControls(store, {
		checkpointMission: async () => {
			calls++;
			return "paused";
		},
		resumeMission: async () => {
			calls++;
			return "resumed";
		},
	});
	controls.setScheduleDrain(async () => {});
	const command: MissionControlCommand = {
		version: 1,
		operationId: randomUUID(),
		home,
		projectId: "p",
		coordinatorSessionId: null,
		expectedRevision: 0,
		action: "pause",
	};
	await store.durable();
	const durable = store.durable.bind(store);
	let barriers = 0;
	t.mock.method(store, "durable", async () => {
		if (++barriers === 2) throw new Error("crash before participant");
		await durable();
	});
	// Failure is saved as Unknown if its durable writer is still usable.
	await assert.rejects(controls.execute(mission.id, command), /crash before participant/);
	assert.equal((await controls.lookup(mission.id, command.operationId))!.state, "unknown");
	assert.equal(calls, 0);
	await durable();
	store.close();
	const reopened = new MissionStore(file);
	t.after(() => reopened.close());
	const recovered = new MissionControls(reopened, {
		checkpointMission: async () => {
			throw new Error("must not replay");
		},
		resumeMission: async () => {
			throw new Error("must not replay");
		},
	});
	assert.equal((await recovered.lookup(mission.id, command.operationId))!.state, "unknown");
	assert.equal(reopened.controls.current(mission.id).held, true);
	assert.equal((await recovered.execute(mission.id, command)).state, "unknown");
});
