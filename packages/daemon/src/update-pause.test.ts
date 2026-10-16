import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { KernelCommand, KernelPacket } from "@pilot/kernel";
import { ServiceUnavailable } from "./errors.ts";
import { ProjectStore } from "./projects.ts";
import { SessionManager, type SessionWorker } from "./sessions.ts";

async function until(check: () => boolean | Promise<boolean>) {
	const deadline = Date.now() + 3_000;
	while (!(await check())) {
		assert.ok(Date.now() < deadline, "condition did not settle");
		await delay(1);
	}
}

async function updateSleepFixture(t: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "pilot-update-sleep-"));
	const workers: Array<SessionWorker & { commands: KernelCommand[] }> = [];
	const sessions = new SessionManager(home, new ProjectStore(home), undefined, {
		title: async () => undefined,
		worker: (_spec, report) => {
			const worker: SessionWorker & { commands: KernelCommand[] } = {
				ready: Promise.resolve(),
				state: "idle",
				busy: false,
				commands: [],
				send(command) {
					this.commands.push(command);
					if (command.type === "update.pause") report({ type: "update.paused", id: command.id });
				},
				request: async () => {},
				close: async () => {},
			};
			workers.push(worker);
			return worker;
		},
	});
	t.after(async () => {
		await sessions.shutdown();
		await rm(home, { recursive: true, force: true });
	});
	await sessions.load();
	const chat = await sessions.spawn({ cwd: home, message: "work" });
	const internal = sessions as unknown as {
		starting: Map<string, Promise<unknown>>;
		resumeAfterUpdate(): void;
		save(meta: { id: string }): Promise<void>;
		savePowerPause(...args: unknown[]): Promise<void>;
	};
	await Promise.all(internal.starting.values());
	await until(() => sessions.pauseForUpdate().ready);
	const metadata = async () => JSON.parse(await readFile(join(home, "sessions", chat.id, "meta.json"), "utf8"));
	return { sessions, internal, workers, metadata };
}

test("runtime safety snapshot preserves parent jobs, child OS processes and unknown inspection after drain", async (t) => {
	const { sessions, internal, workers } = await updateSleepFixture(t);
	const release = sessions.freezeAdmissions();
	try {
		const worker = workers[0]!;
		worker.jobs = async () => [{ id: "job", name: "live", state: "running", startedAt: 1, outputPath: "/tmp/job" }];
		worker.hasChildren = async () => true;
		assert.deepEqual((await sessions.blockers()).map((blocker) => blocker.kind).sort(), ["child-process", "job"]);
		worker.stopJob = async () => {};
		await worker.stopJob("job");
		assert.ok(
			(await sessions.blockers()).some((blocker) => blocker.kind === "job"),
			"stop response is not process exit proof",
		);
		worker.jobs = async () => [];
		assert.ok(
			(await sessions.blockers()).some((blocker) => blocker.kind === "child-process"),
			"child jobs are not ruled out by the parent's empty list",
		);
		worker.jobs = async () => {
			throw new Error("IPC lost");
		};
		assert.ok((await sessions.blockers()).some((blocker) => blocker.kind === "unknown-process"));
		worker.jobs = async () => [];
		worker.hasChildren = async () => false;
		assert.deepEqual(await sessions.blockers(), []);
		internal.resumeAfterUpdate();
		assert.equal(
			worker.commands.some((command) => command.type === "update.resume"),
			false,
			"legacy lease expiry cannot thaw an externally frozen drain",
		);
	} finally {
		release();
	}
});

test("runtime inspection bounds concurrency/output, retains overflow and fences replaced workers", async (t) => {
	const { sessions } = await updateSleepFixture(t);
	const release = sessions.freezeAdmissions();
	const internals = sessions as unknown as {
		workers: Map<string, SessionWorker>;
		updatePausing: Map<SessionWorker, { id: string; ready: boolean }>;
	};
	const original = [...internals.workers];
	let active = 0,
		peak = 0;
	try {
		for (let i = 0; i < 140; i++) {
			const worker: SessionWorker = {
				ready: Promise.resolve(),
				state: "idle",
				send() {},
				request: async () => {},
				close: async () => {},
				jobs: async () => {
					active++;
					peak = Math.max(peak, active);
					await delay(1);
					active--;
					return Array.from({ length: 256 }, (_, j) => ({
						id: `job-${j}`,
						name: "job",
						state: "running" as const,
						startedAt: 1,
						outputPath: "/tmp/job",
					}));
				},
				hasChildren: async () => true,
			};
			internals.workers.set(`worker-${i}`, worker);
			internals.updatePausing.set(worker, { id: `${i}`, ready: true });
		}
		const blockers = await sessions.blockers();
		assert.ok(peak <= 4);
		assert.ok(blockers.length <= 1024);
		assert.ok(blockers.some((blocker) => blocker.id === "blocker-overflow"));
		assert.ok(blockers.some((blocker) => blocker.id === "worker-inspection-overflow"));
		internals.workers.clear();
		const [id, worker] = original[0]!;
		internals.workers.set(id, worker);
		worker.hasChildren = async () => false;
		worker.jobs = async () => {
			internals.workers.set(id, { ...worker });
			return [];
		};
		assert.ok((await sessions.blockers()).some((blocker) => blocker.kind === "unknown-process"));
	} finally {
		internals.workers.clear();
		for (const [id, worker] of original) internals.workers.set(id, worker);
		release();
	}
});

test("update expiry preserves recovery while the sleep latch is still being persisted", async (t) => {
	const { sessions, internal, workers, metadata } = await updateSleepFixture(t);
	let entered!: () => void;
	let finish!: () => void;
	const saving = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const save = internal.savePowerPause.bind(sessions);
	t.mock.method(internal, "savePowerPause", async (...args: unknown[]) => {
		entered();
		await gate;
		await save(...args);
	});
	const sleeping = sessions.pauseForSleep("sleep:1");
	try {
		await saving;
		internal.resumeAfterUpdate();
		assert.equal(
			workers[0]!.commands.some((command) => command.type === "update.resume"),
			false,
		);
		assert.equal((await metadata()).updatePaused, true, "sleep still needs this idle parent's recovery marker");
	} finally {
		finish();
		await sleeping;
	}
	await sessions.resumeAfterSleep();
	await until(async () => workers.length === 2 && !(await metadata()).updatePaused);
});

test("an update lease expiring during sleep preserves idle-parent recovery until wake", async (t) => {
	const { sessions, internal, workers, metadata } = await updateSleepFixture(t);
	await sessions.pauseForSleep("sleep:1");
	assert.equal(sessions.pauseForUpdate().ready, true);
	assert.equal((await metadata()).sleepPaused, undefined, "only the update marker owns this idle parent's recovery");
	internal.resumeAfterUpdate();
	assert.equal(workers.length, 1, "expiry must not override the durable sleep latch");
	assert.equal(
		workers[0]!.commands.some((command) => command.type === "update.resume"),
		false,
		"expiry must not thaw a worker already detached for sleep",
	);
	assert.equal((await metadata()).updatePaused, true);
	await sessions.resumeAfterSleep();
	await until(async () => workers.length === 2 && !(await metadata()).updatePaused);
});

test("wake defers idle-parent recovery until an update lease is released", async (t) => {
	const { sessions, internal, workers, metadata } = await updateSleepFixture(t);
	await sessions.pauseForSleep("sleep:1");
	await sessions.resumeAfterSleep();
	assert.equal(sessions.powerPause, undefined);
	assert.equal(workers.length, 1, "wake cannot launch fresh tools into a leased update window");
	assert.equal((await metadata()).updatePaused, true);
	assert.equal(sessions.pauseForUpdate().ready, true);
	internal.resumeAfterUpdate();
	await until(async () => workers.length === 2 && !(await metadata()).updatePaused);
});

test("update readiness waits for the sleep detach-to-save transition", async (t) => {
	const { sessions, internal } = await updateSleepFixture(t);
	let entered!: () => void;
	let finish!: () => void;
	const saving = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const save = internal.save.bind(sessions);
	t.mock.method(internal, "save", async (meta: { id: string }) => {
		entered();
		await gate;
		await save(meta);
	});
	const sleeping = sessions.pauseForSleep("sleep:1");
	try {
		await saving;
		assert.equal(sessions.pauseForUpdate().ready, false, "detached workers are not yet durably recoverable");
	} finally {
		finish();
		await sleeping;
	}
	assert.equal(sessions.pauseForUpdate().ready, true);
});

test("update pauses working chats at the tool barrier, not their final answer, and preserves durable recovery", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-update-pause-"));
	let report!: (packet: KernelPacket) => void;
	const sent: KernelCommand[] = [];
	const worker: SessionWorker = {
		ready: Promise.resolve(),
		state: "working",
		busy: true,
		send: (command) => {
			sent.push(command);
		},
		request: async () => {},
		close: async () => {},
	};
	const sessions = new SessionManager(home, new ProjectStore(home), undefined, {
		title: async () => undefined,
		worker: (_spec, onPacket) => {
			report = onPacket;
			return worker;
		},
	});
	t.after(async () => {
		await sessions.shutdown();
		await rm(home, { recursive: true, force: true });
	});
	await sessions.load();
	const chat = await sessions.spawn({ cwd: home, message: "unfinished work" });
	await until(() => typeof report === "function");
	report({ type: "working", working: true });
	await until(() => {
		sessions.pauseForUpdate();
		return sent.some((c) => c.type === "update.pause");
	});
	const pause = sent.find((c) => c.type === "update.pause")!;
	assert.equal(sessions.pauseForUpdate().ready, false);
	await assert.rejects(sessions.send(chat.id, "new work"), ServiceUnavailable);
	report({ type: "update.paused", id: "stale" });
	assert.equal(sessions.pauseForUpdate().ready, false);
	report({ type: "update.paused", id: pause.id });
	await until(() => sessions.pauseForUpdate().ready);
	assert.deepEqual(sessions.pauseForUpdate(), { ready: true, processId: process.pid });
	assert.equal(JSON.parse(await readFile(join(home, "sessions", chat.id, "meta.json"), "utf8")).updatePaused, true);
	assert.equal(worker.state, "working");
	assert.equal(
		sent.filter((c) => c.type === "update.pause").length,
		1,
		"retries renew the lease without restarting drains",
	);
	assert.equal(
		sent.some((c) => c.type === "abort" || c.type === "shutdown"),
		false,
	);
	const internal = sessions as unknown as { resumeAfterUpdate(): void };
	internal.resumeAfterUpdate();
	assert.equal(sent.filter((c) => c.type === "update.resume").length, 1);
	assert.equal(sessions.pauseForUpdate().ready, false);
	const retry = sent.filter((c) => c.type === "update.pause").at(-1)!;
	assert.notEqual(retry.id, pause.id);
	report({ type: "update.paused", id: pause.id });
	assert.equal(sessions.pauseForUpdate().ready, false, "an old acknowledgement cannot grant a later update");
	report({ type: "update.paused", id: retry.id, error: "Child tool drain failed" });
	assert.throws(() => sessions.pauseForUpdate(), /Child tool drain failed/);
});

test("an abandoned update releases the admission lease", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-update-lease-"));
	const sessions = new SessionManager(home, new ProjectStore(home));
	t.after(async () => {
		await sessions.shutdown();
		await rm(home, { recursive: true, force: true });
	});
	await sessions.load();
	assert.equal(sessions.pauseForUpdate().ready, true);
	await assert.rejects(sessions.spawn({ cwd: home, message: "blocked" }), ServiceUnavailable);
	// Exercise the exact expiry callback without a real thirty-second sleep.
	const internal = sessions as unknown as { resumeAfterUpdate(): void };
	internal.resumeAfterUpdate();
	assert.equal(sessions.prepareUpdate().ready, true, "expired pause no longer owns an update window");
});

test("update recovery reopens an idle parent for unfinished child work and consumes its marker", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-update-recovery-"));
	const id = "00000000-0000-4000-8000-000000000001";
	const directory = join(home, "sessions", id);
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, "meta.json"),
		JSON.stringify({
			id,
			cwd: home,
			title: "Parent",
			createdAt: 0,
			updatedAt: 0,
			working: false,
			updatePaused: true,
		}),
	);
	const opened: string[] = [];
	const sent: KernelCommand[] = [];
	const sessions = new SessionManager(home, new ProjectStore(home), undefined, {
		title: async () => undefined,
		worker: (spec) => {
			opened.push(spec.sessionId);
			return {
				ready: Promise.resolve(),
				state: "idle",
				busy: false,
				send: (c) => {
					sent.push(c);
				},
				request: async () => {},
				close: async () => {},
			};
		},
	});
	t.after(async () => {
		await sessions.shutdown();
		await rm(home, { recursive: true, force: true });
	});
	await sessions.load();
	await until(async () => !JSON.parse(await readFile(join(directory, "meta.json"), "utf8")).updatePaused);
	assert.deepEqual(opened, [id]);
	assert.equal(
		sent.some((c) => c.type === "input" || c.type === "abort"),
		false,
		"reopen resumes durable work without synthesizing messages",
	);
});
