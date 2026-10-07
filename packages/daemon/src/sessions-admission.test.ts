import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { KernelCommand, KernelPacket } from "@pilot/kernel";
import type { AgentEvent } from "@pilot/protocol";
import { ServiceUnavailable } from "./errors.ts";
import { ProjectStore } from "./projects.ts";
import { SessionManager } from "./sessions.ts";

test("spawn is counted synchronously before metadata exists, and failures release it", async () => {
	const home = await mkdtemp(join(tmpdir(), "pilot-admission-"));
	try {
		const sessions = new SessionManager(home, new ProjectStore(home));
		const spawn = sessions.spawn({ cwd: join(home, "missing"), message: "hello" });
		assert.deepEqual(sessions.list(), []);
		assert.deepEqual(sessions.prepareUpdate(), { ready: false });
		await assert.rejects(spawn, /Not a directory/);
		await assert.rejects(sessions.send("missing", "hello"), /Unknown session/);
		await assert.rejects(sessions.editQueuedMessage("missing", 42, "edited"), /Unknown session/);
		await assert.rejects(sessions.removeQueuedMessage("missing", 42), /Unknown session/);
		assert.deepEqual(sessions.prepareUpdate(), { ready: true });
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("a lease rejects spawn, send, queued mutations and subscription reopening before side effects", async () => {
	const home = await mkdtemp(join(tmpdir(), "pilot-quiescence-"));
	try {
		const id = randomUUID();
		const dir = join(home, "sessions", id);
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "meta.json"),
			JSON.stringify({ id, cwd: home, title: "Parked", createdAt: 0, updatedAt: 0 }),
		);
		let workersCreated = 0;
		const sessions = new SessionManager(home, new ProjectStore(home), undefined, {
			worker: () => {
				workersCreated++;
				assert.fail("an update lease must not reopen a parked worker");
			},
		});
		await sessions.load();
		assert.deepEqual(sessions.prepareUpdate(), { ready: true });
		await assert.rejects(sessions.spawn({ cwd: home, message: "hello" }), ServiceUnavailable);
		await assert.rejects(sessions.send(id, "hello"), ServiceUnavailable);
		await assert.rejects(sessions.editQueuedMessage(id, 42, "edited"), ServiceUnavailable);
		await assert.rejects(sessions.removeQueuedMessage(id, 42), ServiceUnavailable);
		assert.throws(() => sessions.subscribe(id, () => undefined), ServiceUnavailable);
		assert.equal(sessions.get(id)?.state, "parked");
		assert.equal(sessions.list().length, 1);
		assert.equal(workersCreated, 0);
		await sessions.stop(id); // Stopping remains allowed and must not create a worker.
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (!(await check())) {
		assert.ok(Date.now() < deadline, "condition did not settle");
		await delay(1);
	}
}

test("real Worker blocks accepted-before-working and queued inbox gaps until a fresh idle snapshot", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-worker-activity-"));
	const commands: KernelCommand[] = [];
	const child = Object.assign(new EventEmitter(), {
		connected: true,
		exitCode: null as number | null,
		send(command: KernelCommand) {
			commands.push(command);
			if (command.type === "shutdown") {
				queueMicrotask(() => {
					child.exitCode = 0;
					child.emit("exit", 0);
				});
			}
			return true;
		},
	});
	const fork = mock.method(childProcess, "fork", () => child as unknown as ChildProcess);
	syncBuiltinESMExports();
	const sessions = new SessionManager(home, new ProjectStore(home), undefined, { title: async () => undefined });
	t.after(async () => {
		await sessions.shutdown();
		fork.mock.restore();
		syncBuiltinESMExports();
		await rm(home, { recursive: true, force: true });
	});
	await sessions.load();
	const created = await sessions.spawn({ cwd: home, message: "accepted but not yet working" });
	await until(() => commands.some((command) => command.type === "watch"));
	const watches = () => commands.filter((command) => command.type === "watch");
	const originalWatch = watches().at(-1)!;
	const idle: AgentEvent = {
		type: "snapshot",
		entries: [],
		tools: [],
		compactions: [],
		inbox: [],
		agent: {},
		usage: { models: {}, tools: {} },
	};
	const packet = (packet: KernelPacket) => child.emit("message", packet);
	packet({ type: "ready", model: "test/model", working: false, usage: {} });
	packet({ type: "events", watchId: originalWatch.watchId, events: [idle] });
	await until(() => commands.some((command) => command.type === "input"));
	assert.deepEqual(sessions.prepareUpdate(), { ready: false });
	const input = commands.find((command) => command.type === "input")!;
	packet({ type: "accepted", requestId: input.requestId });
	const freshWatch = watches().at(-1)!;
	assert.notEqual(freshWatch.watchId, originalWatch.watchId);
	await until(async () => {
		const meta = JSON.parse(await readFile(join(home, "sessions", created.id, "meta.json"), "utf8"));
		return !meta.initializing && meta.pending.length === 0;
	});
	assert.equal(sessions.get(created.id)?.state, "idle");
	assert.deepEqual(sessions.prepareUpdate(), { ready: false });
	// A late snapshot from the old watch is not the post-acceptance barrier.
	packet({ type: "events", watchId: originalWatch.watchId, events: [idle] });
	assert.deepEqual(sessions.prepareUpdate(), { ready: false });
	packet({
		type: "events",
		watchId: freshWatch.watchId,
		events: [
			{
				...idle,
				inbox: [{ id: 1 as Extract<AgentEvent, { type: "snapshot" }>["inbox"][number]["id"], mode: "followUp" }],
			},
		],
	});
	assert.deepEqual(sessions.prepareUpdate(), { ready: false });
	packet({ type: "events", watchId: freshWatch.watchId, events: [idle] });
	await until(() => sessions.prepareUpdate().ready);
	const off = sessions.subscribe(created.id, () => {});
	assert.equal(commands.at(-1)?.type, "watch");
	await assert.rejects(sessions.send(created.id, "blocked"), ServiceUnavailable);
	off();
});
