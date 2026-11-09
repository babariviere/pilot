import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { KernelCommand, KernelPacket } from "@pilot/kernel";
import type { MissionControlCommand } from "@pilot/protocol";
import { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import { ProjectStore } from "./projects.ts";
import { SessionManager, type SessionWorker } from "./sessions.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}
async function fixture(
	t: TestContext,
	options: { lostAck?: boolean; remainingJobs?: number; failExit?: boolean; readyLost?: boolean } = {},
) {
	const home = await mkdtemp(join(tmpdir(), "pilot-mission-pause-"));
	const projects = new ProjectStore(home),
		store = new MissionStore(":memory:");
	const commands: { id: string; command: KernelCommand }[] = [];
	const opened: string[] = [],
		closed: string[] = [];
	let closeGate: Promise<void> | undefined;
	let closing: (() => void) | undefined;
	const sessions = new SessionManager(home, projects, undefined, {
		title: async () => undefined,
		worker: (spec, receive) => {
			const resumed = opened.includes(spec.sessionId);
			opened.push(spec.sessionId);
			const ready = resumed && options.readyLost ? Promise.reject(new Error("ready ACK lost")) : Promise.resolve();
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
							children: [
								{
									name: "child",
									storage: "/private/child",
									conversationId: "child-conversation",
									state: "idle",
								},
							],
							jobs: options.remainingJobs ?? 0,
							hasChildren: false,
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
			return worker;
		},
	});
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
		meta: async () => JSON.parse(await readFile(join(home, "sessions", a.id, "meta.json"), "utf8")),
		gate: (promise: Promise<void>, onClosing: () => void) => {
			closeGate = promise;
			closing = onClosing;
		},
	};
}

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
	const sessions = new SessionManager(home, new ProjectStore(home), undefined, {
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
	});
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
