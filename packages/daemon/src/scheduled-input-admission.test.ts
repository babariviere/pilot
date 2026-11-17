// biome-ignore-all lint/complexity/useLiteralKeys: Test the real outbox and final kernel boundary.
import assert from "node:assert/strict";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { ScheduleStore } from "./schedule-store.ts";
import { type ScheduleClock, ScheduleService } from "./schedules.ts";
import { CommandRejected } from "./sessions.ts";
import { deferred, fixture, until } from "./testing/session-workspace.ts";

async function setup(t: TestContext, coordinator = false) {
	let release = () => {};
	t.after(() => release());
	let enabled = true;
	const f = await fixture(t, { automationsEnabled: () => enabled });
	const chat = await f.sessions.spawn({
		projectId: f.project.id,
		workspace: "direct",
		message: "initial fixture input",
	});
	await f.sessions["starting"].get(chat.id);
	const worker = f.workers.at(-1)!;
	worker.state = "idle";
	worker["onPacket"]({ type: "working", working: false });
	await Promise.all(f.sessions["saving"].values());
	if (coordinator) {
		const get = f.sessions.get.bind(f.sessions);
		t.mock.method(f.sessions, "get", (id: string) => {
			const row = get(id);
			return row ? { ...row, activeMissionCoordinator: true, missionId: "fixture-mission" } : undefined;
		});
	}
	const clock: ScheduleClock & { time: number } = {
		time: Date.UTC(2026, 10, 18, 9),
		now() {
			return this.time;
		},
		setTimeout() {
			return () => {};
		},
	};
	const file = join(f.home, "schedules.sqlite"),
		store = new ScheduleStore(file);
	const deps = {
		home: { daemonId: "fixture-daemon", lineageId: "fixture-lineage" },
		sessions: f.sessions,
		projects: f.projects,
		automationsEnabled: () => enabled,
		clock,
		triggers: { online: true, subscribe: () => () => {} },
	};
	const service = new ScheduleService(store, deps);
	await service.load();
	service.start();
	await service["tail"];
	f.beforeRemove(async () => {
		await service.stop();
		await store.close();
	});
	function holdBoundary() {
		const arrived = deferred(),
			done = deferred();
		release = done.resolve;
		const capture = f.sessions["captureRunBoundary"].bind(f.sessions);
		let once = true;
		f.sessions["captureRunBoundary"] = async (meta, id) => {
			await capture(meta, id);
			if (id.startsWith("schedule:") && once) {
				once = false;
				arrived.resolve();
				await done.promise;
			}
		};
		return { arrived: arrived.promise, release: done.resolve };
	}
	async function schedule(expiresAt = clock.time + 100000) {
		const row = await service.create({
			trigger: "at",
			at: clock.time + 1,
			expiresAt,
			target: { kind: "message", sessionId: chat.id, message: "Check the saved work" },
		});
		await service["tail"];
		return row;
	}
	return {
		f,
		chat,
		worker,
		service,
		store,
		file,
		clock,
		deps,
		schedule,
		holdBoundary,
		enable: (v: boolean) => {
			enabled = v;
		},
		inputs: () =>
			f.workers
				.flatMap((w) => w.requests)
				.filter((c) => c.type === "input")
				.filter((c) => c.requestId.startsWith("schedule:")),
	};
}

test("global-off winning after workspace I/O holds the exact saved input; resume admits once", async (t) => {
	const f = await setup(t),
		row = await f.schedule(),
		gate = f.holdBoundary();
	f.clock.time++;
	const firing = f.service.signal({ type: "online", online: true });
	await gate.arrived;
	f.enable(false);
	gate.release();
	await firing;
	assert.equal(f.inputs().length, 0);
	assert.equal(f.f.sessions.pendingScheduled(), true);
	assert.equal(f.service.require(row.id).state, "fired"); // Placement, not proof of model execution.
	f.enable(true);
	await f.service.signal({ type: "online", online: true });
	await until(() => f.inputs().length === 1);
	await Promise.all(f.f.sessions["starting"].values());
	assert.equal(f.inputs()[0]!.requestId, `schedule:${row.id}`);
	assert.equal(f.f.sessions.pendingScheduled(), false);
	assert.equal("scheduleEntry" in f.inputs()[0]!, false, "host entry marker never reaches the kernel");
	await f.service.signal({ type: "online", online: true });
	assert.equal(f.inputs().length, 1);
});

test("expiry winning after the final persistence wait rejects input and keeps a missed receipt", async (t) => {
	const f = await setup(t),
		end = f.clock.time + 10,
		row = await f.schedule(end),
		gate = f.holdBoundary();
	f.clock.time++;
	const firing = f.service.signal({ type: "online", online: true });
	await gate.arrived;
	f.clock.time = end;
	gate.release();
	await firing;
	assert.equal(f.inputs().length, 0);
	assert.equal(f.f.sessions.pendingScheduled(), false);
	assert.equal(f.service.require(row.id).runs?.[0]?.outcome, "missed");
	await f.service.signal({ type: "online", online: true });
	assert.equal(f.inputs().length, 0);
});
test("resuming an on-time placement late records acknowledged input entry, not just placement", async (t) => {
	const f = await setup(t),
		row = await f.schedule(f.clock.time + 86400000),
		gate = f.holdBoundary();
	f.clock.time++;
	const firing = f.service.signal({ type: "online", online: true });
	await gate.arrived;
	f.enable(false);
	gate.release();
	await firing;
	const placement = f.service.require(row.id).runs![0]!;
	assert.equal(placement.admittedAt, undefined);
	assert.equal(placement.late, undefined);
	f.clock.time += 360000;
	f.enable(true);
	await f.service.signal({ type: "online", online: true });
	await until(() => f.service.require(row.id).runs?.[0]?.admittedAt !== undefined);
	const run = f.service.require(row.id).runs![0]!;
	assert.equal(run.at, placement.at);
	assert.equal(run.admittedAt, f.clock.time);
	assert.equal(run.late, true);
	assert.equal(f.inputs().length, 1);
});
test("a known unentered stale outbox body cannot borrow the current definition's input identity", async (t) => {
	const f = await setup(t),
		row = await f.schedule(),
		gate = f.holdBoundary();
	f.clock.time++;
	const firing = f.service.signal({ type: "online", online: true });
	await gate.arrived;
	f.enable(false);
	gate.release();
	await firing;
	const meta = f.f.sessions["metas"].get(f.chat.id)!,
		command = meta.pending?.[0];
	assert.ok(command?.type === "input");
	command.content = "Stale body, not the agreed work";
	await f.f.sessions["save"](meta, undefined, undefined, true);
	f.enable(true);
	await f.service.signal({ type: "online", online: true });
	await f.service.signal({ type: "online", online: true });
	await until(() => f.inputs().length === 1);
	assert.equal(f.inputs()[0]!.content, "Check the saved work");
	assert.equal(f.service.require(row.id).state, "fired");
});
test("global-off winning during the entry-marker write is a known hold, not an uncertain send", async (t) => {
	const f = await setup(t),
		row = await f.schedule();
	const save = f.f.sessions["save"].bind(f.f.sessions);
	let once = true;
	f.f.sessions["save"] = async (...args) => {
		await save(...args);
		if (once && args[0].pending?.some((c) => c.type === "input" && c.scheduleEntry)) {
			once = false;
			f.enable(false);
		}
	};
	f.clock.time++;
	await f.service.signal({ type: "online", online: true });
	assert.equal(f.inputs().length, 0);
	assert.equal(f.service.require(row.id).state, "fired");
	assert.equal((await f.f.stored(f.chat.id)).pending?.[0]?.scheduleEntry, undefined);
	f.enable(true);
	await f.service.signal({ type: "online", online: true });
	await until(() => f.inputs().length === 1);
});
test("Stop replacing the outbox during the entry-marker write prevents scheduled input", async (t) => {
	const f = await setup(t);
	await f.schedule();
	const save = f.f.sessions["save"].bind(f.f.sessions);
	let stopped: Promise<unknown> | undefined,
		once = true;
	f.f.sessions["save"] = async (...args) => {
		await save(...args);
		if (once && args[0].pending?.some((c) => c.type === "input" && c.scheduleEntry)) {
			once = false;
			stopped = f.f.sessions.stop(f.chat.id);
		}
	};
	f.clock.time++;
	await f.service.signal({ type: "online", online: true });
	await stopped;
	assert.equal(f.inputs().length, 0);
	assert.ok(f.worker.requests.some((c) => c.type === "abort"));
});

test("all five coalesced check-ins reach one input, never a four-plus-one burst", async (t) => {
	const f = await setup(t, true),
		rows = [];
	for (let i = 0; i < 5; i++)
		rows.push(
			await f.service.create({
				trigger: "at",
				at: f.clock.time + 1,
				target: { kind: "message", sessionId: f.chat.id, message: `Check-in ${i}` },
			}),
		);
	await f.service["tail"];
	f.clock.time++;
	await f.service.signal({ type: "online", online: true });
	assert.equal(f.inputs().length, 1);
	assert.equal(f.inputs()[0]!.type, "input");
	if (f.inputs()[0]!.type === "input")
		assert.deepEqual(f.inputs()[0]!.content.split("\n\n").sort(), [
			"Check-in 0",
			"Check-in 1",
			"Check-in 2",
			"Check-in 3",
			"Check-in 4",
		]);
	for (const row of rows) assert.equal(f.service.require(row.id).state, "fired");
});
test("oversized check-in groups stay visibly held instead of creating a burst", async (t) => {
	const f = await setup(t, true),
		rows = [];
	for (let i = 0; i < 5; i++)
		rows.push(
			await f.service.create({
				trigger: "at",
				at: f.clock.time + 1,
				target: { kind: "message", sessionId: f.chat.id, message: `${i}:` + "x".repeat(7998) },
			}),
		);
	await f.service["tail"];
	f.clock.time++;
	await f.service.signal({ type: "online", online: true });
	assert.equal(f.inputs().length, 0);
	for (const row of rows) {
		const kept = f.service.require(row.id);
		assert.equal(kept.state, "pending");
		assert.equal(kept.paused, true);
		assert.match(kept.error ?? "", /32 KiB/);
	}
	await f.service.signal({ type: "online", online: true });
	assert.equal(f.inputs().length, 0);
});

test("a coalesced companion expiring inside SessionManager cannot leak into the final input", async (t) => {
	const f = await setup(t, true),
		end = f.clock.time + 10;
	const first = await f.schedule(f.clock.time + 100),
		second = await f.schedule(end),
		gate = f.holdBoundary();
	f.clock.time++;
	const firing = f.service.signal({ type: "online", online: true });
	await gate.arrived;
	f.clock.time = end;
	gate.release();
	await firing;
	await f.service.signal({ type: "online", online: true });
	await until(() => f.inputs().length === 1);
	assert.equal(f.service.require(first.id).state, "fired");
	assert.equal(f.service.require(second.id).runs?.[0]?.outcome, "missed");
	assert.equal(f.inputs().length, 1);
});

test("a busy kernel rejects an overlapping recurring occurrence without moving its cadence", async (t) => {
	const f = await setup(t),
		row = await f.service.create({
			trigger: "recurring",
			expectedHome: f.deps.home,
			recurrence: { every: "day", time: "09:01", timeZone: "UTC" },
			target: { kind: "message", sessionId: f.chat.id, message: "Scheduled work" },
		});
	await f.service["tail"];
	const gate = f.holdBoundary(),
		request = f.worker.request.bind(f.worker);
	f.worker.request = async (command) => {
		if (command.type === "input" && command.onlyIfIdle && f.worker.state === "working")
			throw new CommandRejected("busy", "busy");
		await request(command);
	};
	f.clock.time = row.at!;
	const firing = f.service.signal({ type: "online", online: true });
	await Promise.race([
		gate.arrived,
		firing.then(() =>
			assert.fail(JSON.stringify({ row: f.service.require(row.id), target: f.f.sessions.get(f.chat.id) })),
		),
	]);
	f.worker.state = "working";
	f.worker["onPacket"]({ type: "working", working: true });
	gate.release();
	await firing;
	assert.equal(f.inputs().length, 0);
	const latest = f.service.require(row.id);
	assert.equal(latest.runs?.[0]?.outcome, "skipped_running");
	assert.equal(latest.at, row.at! + 86400000);
	assert.equal(latest.paused, undefined);
});

test("lost scheduled input ACK stays Unknown through policy events and restart, without re-entry", async (t) => {
	const f = await setup(t),
		row = await f.schedule(),
		request = f.worker.request.bind(f.worker);
	f.worker.request = async (command) => {
		await request(command);
		if (command.type === "input" && command.requestId.startsWith("schedule:")) throw new Error("lost kernel ACK");
	};
	f.clock.time++;
	await f.service.signal({ type: "online", online: true });
	assert.equal(f.inputs().length, 1);
	assert.equal(f.service.require(row.id).runs?.[0]?.outcome, "unknown");
	assert.equal((await f.f.stored(f.chat.id)).pending?.[0]?.scheduleEntry, true);
	assert.equal(f.f.sessions.pendingScheduled(), false, "uncertainty does not activate network probes");
	await f.service.signal({ type: "online", online: true });
	assert.equal(f.inputs().length, 1);
	await f.service.stop();
	const manager = await f.f.manager(); // Missing scheduling policy is a hold during metadata load.
	const store = new ScheduleStore(f.file),
		next = new ScheduleService(store, { ...f.deps, sessions: manager });
	await next.load();
	next.start();
	await next.signal({ type: "online", online: true });
	await next["tail"];
	assert.equal(f.inputs().length, 1);
	assert.match(manager.get(f.chat.id)?.error ?? "", /unknown/i);
	assert.equal(next.require(row.id).runs?.[0]?.outcome, "unknown");
	f.f.beforeRemove(async () => {
		await next.stop();
		await store.close();
	});
});
test("a persisted input ACK resolves an uncleared outbox after restart without another input", async (t) => {
	const f = await setup(t),
		row = await f.schedule(),
		save = f.f.sessions["save"].bind(f.f.sessions);
	f.f.sessions["save"] = async (...args) => {
		if (f.inputs().length && !args[0].pending?.some((c) => c.requestId.startsWith("schedule:")))
			throw new Error("crash before clearing acknowledged input");
		return save(...args);
	};
	f.clock.time++;
	await f.service.signal({ type: "online", online: true });
	assert.equal(f.inputs().length, 1);
	assert.equal(f.service.require(row.id).runs?.[0]?.admittedAt, f.clock.time);
	assert.equal((await f.f.stored(f.chat.id)).pending?.[0]?.scheduleEntry, true);
	f.f.sessions["save"] = save;
	await f.service.stop();
	const manager = await f.f.manager(),
		store = new ScheduleStore(f.file),
		next = new ScheduleService(store, { ...f.deps, sessions: manager });
	await next.load();
	next.start();
	await next.signal({ type: "online", online: true });
	await next["tail"];
	assert.equal(f.inputs().length, 1);
	assert.equal((await f.f.stored(f.chat.id)).pending?.length, 0);
	f.f.beforeRemove(async () => {
		await next.stop();
		await store.close();
	});
});
