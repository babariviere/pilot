import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { KernelCommand, KernelPacket } from "@pilot/kernel";
import type { MissionControlCommand } from "@pilot/protocol";
import { ActionRunner } from "./automation-runner.ts";
import { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import { ProjectStore } from "./projects.ts";
import { pauseRevisionWork, resumeRevisionWork } from "./revision-work-pause.ts";
import { SessionManager, type SessionWorker } from "./sessions.ts";
import { offlineSessionOptions } from "./testing/offline-session-options.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}
async function fixture(
	t: TestContext,
	options: {
		lostAck?: boolean;
		remainingJobs?: number;
		remainingChildren?: boolean;
		missingChild?: boolean;
		failExit?: boolean;
		readyLost?: boolean;
	} = {},
) {
	const home = await mkdtemp(join(tmpdir(), "pilot-mission-pause-"));
	const projects = new ProjectStore(home),
		store = new MissionStore(":memory:");
	const commands: { id: string; command: KernelCommand }[] = [];
	const opened: string[] = [],
		closed: string[] = [];
	const idle = new Map<string, () => void>();
	const child = {
		name: "child",
		task: "Synthetic subagent",
		createdAt: 1,
		cwd: home,
		model: "synthetic",
		storage: join(home, "child"),
		conversationId: "child-conversation",
		state: "idle" as const,
	};
	let closeGate: Promise<void> | undefined;
	let closing: (() => void) | undefined;
	const sessions = new SessionManager(
		home,
		projects,
		undefined,
		{
			title: async () => undefined,
			worker: (spec, receive) => {
				const resumed = opened.includes(spec.sessionId);
				opened.push(spec.sessionId);
				const ready =
					resumed && options.readyLost ? Promise.reject(new Error("ready ACK lost")) : Promise.resolve();
				void ready.catch(() => {});
				const worker: SessionWorker = {
					ready,
					state: "working",
					busy: false,
					send: (command) => {
						commands.push({ id: spec.sessionId, command });
					},
					request: async (command) => {
						commands.push({ id: spec.sessionId, command });
						if (command.type === "checkpointLifecycle") {
							if (options.lostAck) throw new Error("close ACK lost");
							receive({
								type: "lifecycle.checkpointed",
								requestId: command.requestId,
								operationId: command.operationId,
								conversationId: `conversation:${spec.sessionId}`,
								children: options.missingChild ? [] : [child],
								jobs: options.remainingJobs ?? 0,
								hasChildren: options.remainingChildren ?? false,
							} as KernelPacket);
						}
					},
					close: async () => {
						closing?.();
						await closeGate;
						if (options.failExit) throw new Error("worker exit uncertain");
						closed.push(spec.sessionId);
					},
					jobs: async () => [],
					hasChildren: async () => false,
				};
				idle.set(spec.sessionId, () => {
					receive({ type: "subagents", subagents: [child] });
					worker.state = "idle";
					receive({ type: "working", working: false });
				});
				return worker;
			},
		},
		{},
		offlineSessionOptions(),
	);
	const service = new MissionService(store, sessions, projects);
	service.controls.setScheduleDrain(async () => {});
	await sessions.load();
	const mission = store.create({ projectId: "p", title: "Synthetic" });
	const a = await sessions.spawn({ cwd: home, message: "Synthetic first input" });
	const b = await sessions.spawn({ cwd: home, message: "Synthetic unrelated input" });
	await Promise.all([...(sessions as unknown as { starting: Map<string, Promise<unknown>> }).starting.values()]);
	store.join(a.id, mission.id);
	await store.durable();
	const command = (action: "pause" | "resume" = "pause", pauseOperationId?: string): MissionControlCommand => ({
		version: 1,
		operationId: randomUUID(),
		home: { daemonId: "d", lineageId: "l" },
		projectId: "p",
		coordinatorSessionId: null,
		expectedRevision: store.controls.current(mission.id).revision,
		action,
		...(pauseOperationId ? { pauseOperationId } : {}),
	});
	t.after(async () => {
		closeGate = undefined;
		closing = undefined;
		options.failExit = false;
		await sessions.shutdown();
		store.close();
		await rm(home, { recursive: true, force: true });
	});
	return {
		sessions,
		service,
		store,
		mission,
		a,
		b,
		commands,
		opened,
		closed,
		command,
		parkIdleMember: async () => {
			idle.get(a.id)!();
			sessions["lastUse"].set(a.id, 0);
			await sessions["parkIdleWorkers"]();
			await sessions["parking"].get(a.id);
			await sessions["saving"].get(a.id);
		},
		meta: async () => JSON.parse(await readFile(join(home, "sessions", a.id, "meta.json"), "utf8")),
		gate: (promise: Promise<void>, onClosing: () => void) => {
			closeGate = promise;
			closing = onClosing;
		},
	};
}

test("mission Pause holds an idle member parked with child history, without reopening it on Resume", async (t) => {
	const f = await fixture(t);
	const exit = deferred();
	const closing = deferred();
	f.gate(exit.promise, closing.resolve);
	const parking = f.parkIdleMember();
	await closing.promise;
	const command = f.command();
	const pending = f.service.controls.execute(f.mission.id, command);
	assert.equal(f.store.controls.current(f.mission.id).state, "pausing");
	assert.deepEqual(f.closed, [], "parking ACK does not prove exit");
	exit.resolve();
	const [pause] = await Promise.all([pending, parking]);
	assert.deepEqual(f.closed, [f.a.id]);
	assert.equal(pause.control.state, "paused", JSON.stringify(pause.members));
	assert.equal(pause.state, "acknowledged");
	assert.deepEqual(pause.members, [{ sessionId: f.a.id, state: "held" }]);
	const saved = await f.meta();
	assert.equal(saved.subagents[0].state, "idle");
	assert.equal(saved.lifecycleCheckpoint, undefined);
	const resume = await f.service.controls.execute(f.mission.id, f.command("resume", command.operationId));
	assert.equal(resume.control.state, "running");
	assert.equal(f.opened.filter((id) => id === f.a.id).length, 1);
});

for (const options of [
	{ lostAck: true },
	{ remainingJobs: 1 },
	{ remainingChildren: true },
	{ missingChild: true },
	{ failExit: true },
]) {
	test(`parked child history without full quiescence proof stays unknown: ${JSON.stringify(options)}`, async (t) => {
		const f = await fixture(t, options);
		if (options.failExit) await assert.rejects(f.parkIdleMember(), /exit uncertain/);
		else await f.parkIdleMember();
		const command = f.command();
		const pause = await f.service.controls.execute(f.mission.id, command);
		assert.equal(pause.control.state, "pausing");
		assert.equal(pause.state, "unknown");
		assert.equal(pause.members[0]?.state, "unknown");
		await assert.rejects(
			f.service.controls.execute(f.mission.id, f.command("resume", command.operationId)),
			/acknowledged/,
		);
		assert.equal(f.opened.filter((id) => id === f.a.id).length, 1);
	});
}

test("a reopened worker cannot reuse the earlier parked child's quiescence proof", async (t) => {
	const options = { lostAck: false };
	const f = await fixture(t, options);
	await f.parkIdleMember();
	await f.sessions.send(f.a.id, "Synthetic new input");
	assert.equal(f.opened.filter((id) => id === f.a.id).length, 2);
	options.lostAck = true;
	await f.parkIdleMember();
	const pause = await f.service.controls.execute(f.mission.id, f.command());
	assert.equal(pause.control.state, "pausing");
	assert.equal(pause.members[0]?.state, "unknown");
});

test("Linear reassignment checkpoints only the affected worker and does not clear mission Pause", async (t) => {
	const f = await fixture(t);
	const task = f.store.addTask(f.mission.id, { title: "Linked" });
	f.store.claimTask(f.mission.id, task.id, f.a.id);
	const url = "https://linear.app/acme/issue/ENG-1";
	f.store.addResource(f.mission.id, { url, linearRole: "managed" });
	const link = f.store.addResource(f.mission.id, { url, taskId: task.id, linearRole: "contribution" });
	const exit = deferred(),
		entered = deferred();
	t.after(exit.resolve);
	f.gate(exit.promise, entered.resolve);
	f.store.observeLinearAssignee("p", link.id, { id: "other", name: "Other" }, "me");
	await entered.promise;
	try {
		assert.equal(f.store.task(f.mission.id, task.id).status, "delegated");
		await assert.rejects(f.sessions.send(f.a.id, "blocked by reassignment"), /paused/);
		assert.ok(!f.commands.some((c) => c.id === f.b.id && c.command.type === "checkpointLifecycle"));
		// The Stop generation is an independent, durable mission hold.
		f.store.controls.stop(f.mission.id);
		f.store.observeLinearAssignee("p", link.id, { id: "me", name: "You" }, "me");
		assert.equal(f.store.linearWorkHold(f.a.id), undefined);
		await assert.rejects(f.sessions.send(f.a.id, "still held"), /paused/);
	} finally {
		exit.resolve();
	}
});

test("mission Resume releases other work while a Linear assignment hold remains", async (t) => {
	const f = await fixture(t);
	const task = f.store.addTask(f.mission.id, { title: "Linked" });
	f.store.claimTask(f.mission.id, task.id, f.a.id);
	f.store.join(f.b.id, f.mission.id);
	const url = "https://linear.app/acme/issue/ENG-1";
	f.store.addResource(f.mission.id, { url, linearRole: "managed" });
	const link = f.store.addResource(f.mission.id, { url, taskId: task.id, linearRole: "contribution" });
	const command = f.command();
	await f.service.controls.execute(f.mission.id, command);
	f.store.observeLinearAssignee("p", link.id, { id: "other", name: "Other" }, "me");
	const resume = await f.service.controls.execute(f.mission.id, f.command("resume", command.operationId));
	assert.equal(resume.control.state, "running");
	assert.equal(resume.members.find((member) => member.sessionId === f.a.id)?.state, "held");
	assert.equal(resume.members.find((member) => member.sessionId === f.b.id)?.state, "resumed");
	assert.equal(f.opened.filter((id) => id === f.a.id).length, 1);
	const returned = deferred();
	const off = f.sessions.onChange(() => {
		if (f.opened.filter((id) => id === f.a.id).length === 2) returned.resolve();
	});
	t.after(off);
	f.store.observeLinearAssignee("p", link.id, { id: "me", name: "You" }, "me");
	await returned.promise;
	assert.equal(f.store.task(f.mission.id, task.id).status, "in_progress");
});

test("mission Pause proves ACK, census and joined exit; unrelated work stays running", async (t) => {
	const f = await fixture(t),
		exit = deferred(),
		entered = deferred();
	f.gate(exit.promise, entered.resolve);
	const command = f.command(),
		pause = f.service.controls.execute(f.mission.id, command);
	await entered.promise;
	assert.equal(f.store.controls.current(f.mission.id).state, "pausing");
	assert.equal(f.closed.length, 0, "close ACK is not joined exit");
	await assert.rejects(f.sessions.send(f.a.id, "cannot sneak through"), /paused/);
	assert.equal(
		f.commands.some((c) => c.id === f.b.id && c.command.type === "checkpointLifecycle"),
		false,
	);
	exit.resolve();
	const receipt = await pause;
	assert.equal(receipt.control.state, "paused");
	assert.deepEqual(f.closed, [f.a.id]);
	const saved = await f.meta();
	assert.equal(saved.lifecycleCheckpoint.quiescent, true);
	assert.equal(saved.lifecycleCheckpoint.children[0].conversationId, "child-conversation");
	assert.equal(saved.lifecycleCheckpoint.purpose, "mission-pause");
	// The paused chat keeps its turn for Resume (saved as working), but nothing runs.
	const held = f.sessions["metas"].get(f.a.id)!;
	const kept = held.working;
	held.working = true;
	assert.equal(f.sessions.get(f.a.id)?.working, false, "a chat its mission paused is not working");
	held.working = kept;
	const inputs = f.commands.filter((c) => c.command.type === "input").length;
	await f.sessions.resumeMaintenance();
	assert.equal(f.opened.filter((id) => id === f.a.id).length, 1, "upgrade release cannot resume mission-owned work");
	const resumed = await f.service.controls.execute(f.mission.id, f.command("resume", command.operationId));
	assert.equal(resumed.control.state, "running");
	assert.equal(f.opened.filter((id) => id === f.a.id).length, 2);
	assert.equal(
		f.commands.filter((c) => c.command.type === "input").length,
		inputs,
		"Resume must not synthesize a message",
	);
});

test("after Resume the coordinator can dispatch and its tasks can continue again", async (t) => {
	const f = await fixture(t),
		command = f.command();
	(f.sessions as unknown as { metas: Map<string, { taskIds?: string[] }> }).metas.get(f.a.id)!.taskIds = ["task"];
	f.sessions.missionDispatchFence(f.a.id);
	await f.service.controls.execute(f.mission.id, command);
	assert.throws(() => f.sessions.missionDispatchFence(f.a.id), /held or unavailable/);
	assert.throws(() => f.sessions.assertMissionTaskHolds(f.mission.id, ["task"]), /paused/);
	const resumed = await f.service.controls.execute(f.mission.id, f.command("resume", command.operationId));
	assert.equal(resumed.control.state, "running");
	assert.equal((await f.meta()).lifecycleCheckpoint.phase, "resume-acknowledged");
	f.sessions.missionDispatchFence(f.a.id);
	f.sessions.assertMissionTaskHolds(f.mission.id, ["task"]);
});

for (const options of [{ lostAck: true }, { remainingJobs: 1 }, { failExit: true }])
	test(`mission Pause stays uncertain: ${JSON.stringify(options)}`, async (t) => {
		const f = await fixture(t, options),
			command = f.command();
		const result = await f.service.controls.execute(f.mission.id, command);
		assert.equal(result.control.state, "pausing");
		assert.equal(result.state, "unknown");
		assert.equal((await f.meta()).lifecycleCheckpoint.quiescent, undefined);
		const checkpoints = f.commands.filter((c) => c.command.type === "checkpointLifecycle").length;
		await f.service.controls.execute(f.mission.id, command);
		assert.equal(f.commands.filter((c) => c.command.type === "checkpointLifecycle").length, checkpoints);
		await assert.rejects(
			f.service.controls.execute(f.mission.id, f.command("resume", command.operationId)),
			/acknowledged/,
		);
	});

test("later Stop wins over mission Resume and cannot reopen or synthesize work", async (t) => {
	const f = await fixture(t),
		command = f.command();
	await f.service.controls.execute(f.mission.id, command);
	await f.sessions.stop(f.a.id);
	assert.equal((await f.meta()).lifecycleCheckpoint.phase, "stopped");
	assert.equal(f.opened.filter((id) => id === f.a.id).length, 1);
	const result = await f.service.controls.execute(f.mission.id, f.command("resume", command.operationId));
	assert.equal(result.state, "acknowledged");
	assert.equal(result.members[0]!.state, "held");
	assert.equal(f.opened.filter((id) => id === f.a.id).length, 1);
});

test("lost resume ready ACK is Unknown and cannot be replayed by repeated Resume", async (t) => {
	const f = await fixture(t, { readyLost: true }),
		command = f.command();
	await f.service.controls.execute(f.mission.id, command);
	const resume = f.command("resume", command.operationId);
	const result = await f.service.controls.execute(f.mission.id, resume);
	assert.equal(result.state, "unknown");
	assert.equal(result.control.held, true);
	await f.service.controls.execute(f.mission.id, resume);
	assert.equal(f.opened.filter((id) => id === f.a.id).length, 2);
	assert.equal((await f.meta()).lifecycleCheckpoint.phase, "unknown");
});

test("owned flow reviewer chats pause with their root without acquiring membership", async (t) => {
	const f = await fixture(t);
	const internal = f.sessions as unknown as { metas: Map<string, { flowRootId?: string }> };
	internal.metas.get(f.b.id)!.flowRootId = f.a.id;
	assert.equal(f.store.membership(f.b.id), undefined);
	const command = f.command();
	const result = await f.service.controls.execute(f.mission.id, command);
	assert.equal(result.control.state, "paused");
	assert.deepEqual(new Set(result.members.map((member) => member.sessionId)), new Set([f.a.id, f.b.id]));
	assert.deepEqual(new Set(f.closed), new Set([f.a.id, f.b.id]));
	const resumed = await f.service.controls.execute(f.mission.id, f.command("resume", command.operationId));
	assert.equal(resumed.control.state, "running");
	assert.equal(f.store.membership(f.b.id), undefined);
});

test("Stop during durable mission resume admission vetoes worker creation", async (t) => {
	const f = await fixture(t),
		command = f.command();
	await f.service.controls.execute(f.mission.id, command);
	const internal = f.sessions as unknown as {
		save(meta: { lifecycleCheckpoint?: { phase: string } }, ...args: unknown[]): Promise<void>;
	};
	const save = internal.save;
	let stopped = false;
	t.mock.method(internal, "save", async (meta: { lifecycleCheckpoint?: { phase: string } }, ...args: unknown[]) => {
		await save.call(f.sessions, meta, ...args);
		if (!stopped && meta.lifecycleCheckpoint?.phase === "resume-admitted") {
			stopped = true;
			f.store.controls.stop(f.mission.id);
			await f.store.durable();
		}
	});
	const result = await f.service.controls.execute(f.mission.id, f.command("resume", command.operationId));
	assert.equal(result.state, "unknown");
	assert.equal(f.opened.filter((id) => id === f.a.id).length, 1);
});

test("revision source change inside durable session Resume vetoes worker admission", async (t) => {
	const f = await fixture(t);
	const source = f.store.revisions.source(f.mission.id);
	const proposal = await f.store.revisions.propose(
		f.mission.id,
		{ operationId: randomUUID(), source, summary: "Reviewed goal", delta: { goal: "New goal" } },
		{},
	);
	const pause = await pauseRevisionWork(f.store, f.sessions, f.mission.id, {
		operationId: randomUUID(),
		proposalId: proposal.id,
		digest: proposal.digest,
		source,
	});
	assert.equal(pause.state, "paused", pause.reason ?? "");
	const internal = f.sessions as unknown as {
		save(meta: { lifecycleCheckpoint?: { phase: string } }, ...args: unknown[]): Promise<void>;
	};
	const save = internal.save;
	let changed = false;
	t.mock.method(internal, "save", async (meta: { lifecycleCheckpoint?: { phase: string } }, ...args: unknown[]) => {
		await save.call(f.sessions, meta, ...args);
		if (!changed && meta.lifecycleCheckpoint?.phase === "resume-admitted") {
			changed = true;
			f.store.update(f.mission.id, { goal: "Concurrent goal" });
		}
	});
	const result = await resumeRevisionWork(f.store, f.sessions, f.mission.id, {
		operationId: randomUUID(),
		pauseOperationId: pause.operationId,
		source,
	});
	assert.equal(changed, true);
	assert.equal(result.state, "unknown");
	assert.equal(f.opened.filter((id) => id === f.a.id).length, 1);
	assert.equal(f.service.controls.fence(f.a.id)?.held, true);
});

test("cold queued input is admission-only, never a fabricated kernel census", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-mission-queue-")),
		id = randomUUID();
	const directory = join(home, "sessions", id);
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, "meta.json"),
		JSON.stringify({
			id,
			cwd: home,
			createdAt: 1,
			updatedAt: 1,
			title: "Synthetic",
			pending: [{ type: "input", requestId: "original", content: "Original queued input", mode: "followUp" }],
		}),
	);
	const fence = { missionId: "mission", pauseGeneration: 1, stopGeneration: 0, held: true };
	const commands: KernelCommand[] = [];
	const sessions = new SessionManager(
		home,
		new ProjectStore(home),
		undefined,
		{
			title: async () => undefined,
			worker: () => ({
				ready: Promise.resolve(),
				state: "idle",
				busy: false,
				send() {},
				request: async (command) => {
					commands.push(command);
				},
				close: async () => {},
			}),
		},
		{},
		offlineSessionOptions(),
	);
	sessions.setMissionBridge({
		upgradeResumeFence: () => fence,
		membership: () => ({ missionId: "mission", active: true }),
		context: () => undefined,
		spawnProject: () => home,
		joinSpawn() {},
		call: async () => undefined,
	});
	t.after(async () => {
		await sessions.shutdown();
		await rm(home, { recursive: true, force: true });
	});
	await sessions.load();
	assert.equal(commands.length, 0);
	const operationId = randomUUID();
	assert.equal(await sessions.checkpointMission(id, operationId, fence), "paused");
	const saved = JSON.parse(await readFile(join(directory, "meta.json"), "utf8"));
	assert.equal(saved.lifecycleCheckpoint.admissionOnly, true);
	assert.equal(saved.lifecycleCheckpoint.census, undefined);
	assert.equal(saved.lifecycleCheckpoint.quiescent, undefined);
	assert.equal(await sessions.resumeMission(id, operationId, fence), "resumed");
	assert.deepEqual(
		commands.filter((command) => command.type === "input").map((command) => command.requestId),
		["original"],
	);
});

for (const race of ["interrupted-action", "changed-fence"] as const) {
	test(`cold checkpoint refuses ${race} before successful held return`, async (t) => {
		const home = await mkdtemp(join(tmpdir(), "pilot-cold-checkpoint-")),
			id = randomUUID();
		const directory = join(home, "sessions", id);
		await mkdir(directory, { recursive: true });
		await writeFile(
			join(directory, "meta.json"),
			JSON.stringify({ id, cwd: home, title: "Cold", createdAt: 1, updatedAt: 1 }),
		);
		const fence = { missionId: "mission", pauseGeneration: 1, stopGeneration: 0, held: true };
		let current = { ...fence },
			active = false;
		const actions = new ActionRunner();
		const sessions = new SessionManager(
			home,
			new ProjectStore(home),
			undefined,
			{ title: async () => undefined },
			{},
			{ ...offlineSessionOptions(), actionRunner: actions },
		);
		sessions.setMissionBridge({
			upgradeResumeFence: () => current,
			membership: () => ({ missionId: "mission", active: true }),
			context: () => undefined,
			spawnProject: () => home,
			joinSpawn() {},
			call: async () => undefined,
		});
		t.after(async () => {
			await sessions.shutdown();
			await rm(home, { recursive: true, force: true });
		});
		await sessions.load();
		active = race === "interrupted-action";
		t.mock.method(actions, "isWorking", () => active);
		t.mock.method(actions, "checkpointSession", async () => {
			active = false;
			if (race === "changed-fence") current = { ...fence, stopGeneration: 1 };
		});
		await assert.rejects(
			sessions.checkpointMission(id, randomUUID(), fence),
			race === "interrupted-action" ? /Interrupted shell effects/ : /fence changed/,
		);
		const saved = JSON.parse(await readFile(join(directory, "meta.json"), "utf8"));
		assert.equal(saved.lifecycleCheckpoint?.quiescent, undefined);
	});
}
