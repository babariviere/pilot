import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { KernelCommand, KernelSpec } from "@pilot/kernel";
import type { AgentEvent, SessionState } from "@pilot/protocol";
import { ProjectStore } from "./projects.ts";
import { SessionManager, type SessionWorker } from "./sessions.ts";

const snapshot: AgentEvent = {
	type: "snapshot",
	entries: [],
	tools: [],
	compactions: [],
	inbox: [],
	agent: {},
	usage: { models: {}, tools: {} },
};
async function until(check: () => boolean): Promise<void> {
	const end = Date.now() + 3000;
	while (!check()) {
		assert.ok(Date.now() < end, "condition timed out");
		await delay(1);
	}
}
test("sleep pause closes workers without abort, persists across restart, and resumes only eligible work", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-sleep-sessions-"));
	const workers: Array<SessionWorker & { id: string; commands: KernelCommand[]; closed: boolean }> = [];
	const managers: SessionManager[] = [];
	const specs: KernelSpec[] = [];
	const manager = async () => {
		const sessions = new SessionManager(home, new ProjectStore(home), undefined, {
			title: async () => undefined,
			snapshot: async () => ({ events: [snapshot] }),
			worker(spec, packet, exited) {
				specs.push(spec);
				const worker = {
					id: spec.sessionId,
					commands: [] as KernelCommand[],
					closed: false,
					state: "idle" as SessionState,
					busy: false,
					ready: Promise.resolve(),
					send(command: KernelCommand) {
						this.commands.push(command);
					},
					async request(command: Extract<KernelCommand, { requestId: string }>) {
						this.commands.push(command);
						if (command.type === "input") {
							this.state = "working";
							this.busy = true;
							packet({ type: "working", working: true });
						} else if (command.type === "abort") {
							this.state = "idle";
							this.busy = false;
							packet({
								type: "working",
								working: false,
								completion: { outcome: "stopped", outcomeAt: Date.now() },
							});
						}
					},
					async close() {
						this.closed = true;
						// Closing must not consume pending work or turn the sleep pause into a completion/error.
						packet({ type: "working", working: false, completion: { outcome: "failed", outcomeAt: Date.now() } });
						exited(this, 0);
					},
				};
				queueMicrotask(() => packet({ type: "ready", working: false, model: "test/model", usage: {} }));
				workers.push(worker);
				return worker;
			},
		});
		managers.push(sessions);
		await sessions.load();
		return sessions;
	};
	t.after(async () => {
		for (const sessions of managers) await sessions.shutdown();
		await rm(home, { recursive: true, force: true });
	});
	const sessions = await manager();
	const active = await sessions.spawn({ cwd: home, title: "Active", message: "work" });
	const stopped = await sessions.spawn({ cwd: home, title: "Stopped", message: "stop" });
	const archived = await sessions.spawn({ cwd: home, title: "Archived", message: "archive" });
	const cancelled = await sessions.spawn({ cwd: home, title: "Stop during sleep", message: "work" });
	await until(
		() =>
			sessions.get(active.id)?.state === "working" &&
			sessions.get(stopped.id)?.state === "working" &&
			sessions.get(archived.id)?.state === "working" &&
			sessions.get(cancelled.id)?.state === "working",
	);
	await sessions.stop(stopped.id);
	const pausing = sessions.pauseForSleep("100:1");
	assert.ok(sessions.powerPause, "the admission barrier must be synchronous");
	await pausing;
	assert.equal(sessions.get(active.id)?.sleepPaused, true);
	assert.notEqual(sessions.get(active.id)?.outcome, "failed");
	assert.equal(sessions.get(stopped.id)?.sleepPaused, undefined);
	assert.ok(workers.every((worker) => worker.closed));
	assert.equal(
		workers.find((worker) => worker.id === active.id)!.commands.some((command) => command.type === "abort"),
		false,
	);
	const count = workers.length;
	await sessions.send(cancelled.id, "return this draft", "followUp", "sleep-stop-queued");
	await sessions.send(cancelled.id, "hold automatic work", "followUp", "mission:send:sleep-stop");
	assert.equal(sessions.pauseForUpdate().ready, true, "a sleep-paused update lease can be ready");
	assert.deepEqual(await sessions.stop(cancelled.id), { ok: true, draft: "return this draft" });
	assert.deepEqual(await sessions.stop(stopped.id), { ok: true }, "idle Stop is harmless during a global pause");
	(sessions as unknown as { resumeAfterUpdate(): void }).resumeAfterUpdate();
	assert.equal(workers.length, count, "Stop must not bypass the sleep admission latch");
	assert.equal(sessions.powerPause?.wakeToken, "100:1", "Stop cannot resume other chats");
	const stoppedMeta = JSON.parse(await readFile(join(home, "sessions", cancelled.id, "meta.json"), "utf8"));
	assert.deepEqual(
		stoppedMeta.pending.map((command: KernelCommand) => command.type),
		["abort", "input"],
	);
	const off = sessions.subscribe(active.id, () => {});
	await delay(10);
	off();
	assert.equal(workers.length, count, "viewing history must not reopen a paused kernel");
	await sessions.send(active.id, "queued while asleep", "followUp", "sleep-queued-id");
	assert.equal(workers.length, count);
	await sessions.archive(archived.id);
	assert.equal(sessions.get(archived.id)?.sleepPaused, undefined);
	await sessions.shutdown();
	const reopened = await manager();
	assert.equal(workers.length, count, "daemon restart must not act as a wake");
	assert.equal(reopened.powerPause?.wakeToken, "100:1");
	assert.equal(reopened.get(active.id)?.sleepPaused, true);
	await reopened.resumeAfterSleep();
	await until(() => workers.length === count + 2);
	const resumed = workers.slice(count);
	const cancelledWorker = resumed.find((worker) => worker.id === cancelled.id)!;
	assert.equal(specs.findLast((spec) => spec.sessionId === cancelled.id)?.stopOnOpen, true);
	await until(() => cancelledWorker.commands.length === 2);
	assert.deepEqual(
		cancelledWorker.commands.map((command) => command.type),
		["abort", "input"],
	);
	await until(() =>
		resumed
			.find((worker) => worker.id === active.id)!
			.commands.some((command) => command.type === "input" && command.requestId === "sleep-queued-id"),
	);
	assert.equal(JSON.parse(await readFile(join(home, "power-pause.json"), "utf8")), null);
});

test("sleep preserves the pending result turn after the last live job ends", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-sleep-job-result-"));
	const workers: Array<SessionWorker & { closed: boolean }> = [];
	let finishJob!: () => void;
	const sessions = new SessionManager(home, new ProjectStore(home), undefined, {
		title: async () => undefined,
		worker(_spec, packet, exited) {
			const worker = {
				state: "idle" as SessionState,
				busy: false,
				ready: Promise.resolve(),
				closed: false,
				send() {},
				async request() {},
				async close() {
					this.closed = true;
					exited(this, 0);
				},
			};
			finishJob = () => {
				packet({
					type: "jobs.changed",
					jobs: [{ id: "tests", name: "Tests", state: "running", startedAt: 1, outputPath: "/tmp/tests.log" }],
				});
				packet({ type: "jobs.changed", jobs: [] });
			};
			workers.push(worker);
			queueMicrotask(() => packet({ type: "ready", working: false, model: "test/model", usage: {} }));
			return worker;
		},
	});
	t.after(async () => {
		await sessions.shutdown();
		await rm(home, { recursive: true, force: true });
	});
	await sessions.load();
	const created = await sessions.spawn({ cwd: home, message: "work" });
	await until(() => sessions.get(created.id)?.state === "idle");
	finishJob();
	assert.equal(sessions.get(created.id)?.working, true);
	assert.equal(sessions.get(created.id)?.runningJobs, undefined);
	await sessions.pauseForSleep("100:1");
	assert.equal(sessions.get(created.id)?.sleepPaused, true);
	assert.equal(sessions.get(created.id)?.working, false);
	assert.equal(sessions.get(created.id)?.state, "parked");
	assert.equal(workers[0]!.closed, true);
	assert.equal(JSON.parse(await readFile(join(home, "sessions", created.id, "meta.json"), "utf8")).sleepPaused, true);
	await sessions.resumeAfterSleep();
	await until(() => workers.length === 2);
});

test("a synchronous startup pause wins over an older persisted wake token during session load", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-sleep-startup-latch-"));
	await writeFile(join(home, "power-pause.json"), JSON.stringify({ since: 1, wakeToken: "100:1" }));
	const sessions = new SessionManager(home, new ProjectStore(home));
	t.after(async () => {
		await sessions.shutdown();
		await rm(home, { recursive: true, force: true });
	});
	const pause = sessions.pauseForSleep("200:1");
	await sessions.load();
	await pause;
	assert.equal(sessions.powerPause?.wakeToken, "200:1");
	assert.equal(JSON.parse(await readFile(join(home, "power-pause.json"), "utf8")).wakeToken, "200:1");
});

test("wake drains paused startup, and another sleep cancels an in-flight resume without losing queued input", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-sleep-startup-"));
	let resolveReady!: () => void;
	const ready = {
		promise: new Promise<void>((resolve) => {
			resolveReady = resolve;
		}),
		resolve: () => resolveReady(),
	};
	const workers: Array<SessionWorker & { commands: KernelCommand[]; closed: boolean }> = [];
	const sessions = new SessionManager(home, new ProjectStore(home), undefined, {
		title: async () => undefined,
		worker(_spec, packet, exited) {
			const worker = {
				commands: [] as KernelCommand[],
				closed: false,
				state: "starting" as SessionState,
				busy: true,
				ready: ready.promise,
				send(command: KernelCommand) {
					this.commands.push(command);
				},
				async request(command: Extract<KernelCommand, { requestId: string }>) {
					assert.equal(this.closed, false, "an old startup cannot deliver after a sleep pause");
					this.commands.push(command);
					packet({ type: "working", working: true });
				},
				async close() {
					this.closed = true;
					exited(this, 0);
				},
			};
			workers.push(worker);
			return worker;
		},
	});
	t.after(async () => {
		ready.resolve();
		await sessions.shutdown();
		await rm(home, { recursive: true, force: true });
	});
	await sessions.load();
	const active = await sessions.spawn({ cwd: home, message: "one durable admission" });
	await until(() => workers.length === 1);
	await sessions.pauseForSleep("100:1");
	const waking = sessions.resumeAfterSleep();
	assert.ok(sessions.powerPause, "unfinished startup must drain before clearing the latch");
	const sleepingAgain = sessions.pauseForSleep("200:1");
	ready.resolve();
	await waking;
	await sleepingAgain;
	assert.equal(sessions.powerPause?.wakeToken, "200:1");
	assert.equal(JSON.parse(await readFile(join(home, "power-pause.json"), "utf8")).wakeToken, "200:1");
	assert.equal(workers.length, 1);
	assert.equal(sessions.get(active.id)?.sleepPaused, true);
	await sessions.resumeAfterSleep();
	await until(() => workers.length === 2 && workers[1]!.commands.some((command) => command.type === "input"));
	assert.equal(
		workers[0]!.commands.some((command) => command.type === "input"),
		false,
	);
});
