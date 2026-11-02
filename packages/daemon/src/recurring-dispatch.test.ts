import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { ScheduleRequest, SpawnRequest } from "@pilot/protocol";
import { Conflict, NotFound } from "./errors.ts";
import { ScheduleDetection } from "./schedule-detection.ts";
import { ScheduleStore } from "./schedule-store.ts";
import { ScheduleService, type ScheduleTriggerEvent } from "./schedules.ts";

const ms = Date.parse,
	DAY = 86400000;
async function fixture(t: TestContext, platform = "darwin") {
	const dir = await mkdtemp(join(tmpdir(), "recurring-dispatch-"));
	const store = new ScheduleStore(join(dir, "schedules.sqlite"));
	let now = ms("2026-11-02T08:00Z"),
		online = true,
		enabled = true,
		paused = false,
		project = true,
		fail = false,
		probes = 0,
		active = false;
	let admission: () => void = () => {};
	const home = { daemonId: "d", lineageId: "l" };
	const timers = new Set<{ at: number; callback: () => void }>();
	const clock = {
		now: () => now,
		setTimeout: (callback: () => void, delay: number) => {
			const timer = { at: now + delay, callback };
			timers.add(timer);
			return () => {
				timers.delete(timer);
			};
		},
	};
	const chats = new Map<string, { projectId: string; working?: boolean }>([["target", { projectId: "p" }]]);
	const calls: Array<{ request?: SpawnRequest; message?: string; key?: string }> = [];
	const service = new ScheduleService(store, {
		clock,
		platform,
		home,
		automationsEnabled: () => enabled,
		paused: () => paused,
		subscribeAdmission: (listener) => {
			admission = listener;
			return () => {};
		},
		projects: {
			require: (id: string) => {
				if (!project) throw new NotFound("Missing project");
				return { id, name: "P", path: dir, createdAt: 0 };
			},
		},
		sessions: {
			get: (id) => chats.get(id),
			spawn: async (request) => {
				calls.push({ request });
				if (fail) throw new Error("Spawn failed");
				const id = `new-${calls.length}`;
				chats.set(id, { projectId: "p" });
				return { id };
			},
			send: async (_id, message, _mode, key) => {
				calls.push({ message, key });
				if (fail) throw new Error("Send failed");
			},
		},
		triggers: {
			online: true,
			refreshOnline: async () => {
				probes++;
				return online;
			},
			subscribe: () => () => {},
			setActive: (value) => {
				active = value;
			},
		},
	});
	await service.load();
	t.after(async () => {
		await service.stop();
		await store.close();
		await rm(dir, { recursive: true, force: true });
	});
	const request: ScheduleRequest = {
		title: 'Daily "check"',
		trigger: "recurring",
		recurrence: { every: "day", time: "09:00", timeZone: "UTC" },
		expectedHome: home,
		target: { kind: "chat", spawn: { projectId: "p", message: "Original prompt" } },
	};
	const settle = (event: ScheduleTriggerEvent = { type: "online", online }) => service.signal(event);
	return {
		service,
		store,
		clock,
		timers,
		chats,
		calls,
		request,
		home,
		start: () => service.start(),
		settle,
		setNow: (value: number) => {
			now = value;
		},
		network: (value: boolean) => {
			online = value;
		},
		enable: (value: boolean) => {
			enabled = value;
			admission();
		},
		pause: (value: boolean) => {
			paused = value;
			admission();
		},
		removeProject: () => {
			project = false;
		},
		fail: () => {
			fail = true;
		},
		get probes() {
			return probes;
		},
		get active() {
			return active;
		},
	};
}

test("coalesces older occurrences into one late chat with original prompt retained", async (t) => {
	const f = await fixture(t),
		row = await f.service.create(f.request);
	f.setNow(ms("2026-11-05T14:12Z"));
	f.start();
	await f.settle();
	assert.equal(f.calls.length, 1);
	const saved = f.service.require(row.id),
		run = saved.runs![0];
	assert.equal(run.count, 4);
	assert.equal(run.outcome, "started");
	assert.equal(run.late, true);
	assert.equal(saved.state, "pending");
	assert.equal(saved.at, ms("2026-11-06T09:00Z"));
	assert.equal(f.calls[0].request?.title, 'Daily "check" · 2026-11-05');
	assert.match(
		f.calls[0].request!.message,
		/^<schedule rule="Daily &quot;check&quot;" due="2026-11-05T09:00\+00:00" started="2026-11-05T14:12\+00:00">/,
	);
	assert.equal(saved.target.kind === "chat" && saved.target.spawn.message, "Original prompt");
	await f.settle();
	assert.equal(f.calls.length, 1);
	assert.equal(f.active, false);
});
test("expired daily, weekly and monthly periods are missed even while offline", async (t) => {
	const f = await fixture(t);
	const daily = await f.service.create({ ...f.request, recurrence: { every: "day", time: "23:50", timeZone: "UTC" } });
	const weekly = await f.service.create({
		...f.request,
		recurrence: { every: "week", weekday: 5, time: "09:00", timeZone: "UTC" },
	});
	const monthly = await f.service.create({
		...f.request,
		recurrence: { every: "month", dayOfMonth: 31, time: "09:00", timeZone: "UTC" },
	});
	f.network(false);
	f.setNow(ms("2026-12-01T00:10Z"));
	f.start();
	await f.settle();
	for (const row of [daily, weekly, monthly]) assert.equal(f.service.require(row.id).notice?.outcome, "missed");
	assert.equal(f.service.require(daily.id).notice?.count, 29);
	assert.equal(f.calls.length, 0);
	assert.equal(f.probes, 0);
	assert.equal(f.active, false);
});
test("only due work probes, waits offline, and expires at its period boundary", async (t) => {
	const f = await fixture(t),
		row = await f.service.create({ ...f.request, recurrence: { every: "day", time: "23:50", timeZone: "UTC" } });
	f.start();
	await f.settle();
	assert.equal(f.probes, 0);
	assert.equal(f.active, false);
	f.setNow(ms("2026-11-02T23:51Z"));
	f.network(false);
	await f.settle();
	assert.equal(f.probes, 1);
	assert.equal(f.active, true);
	assert.equal(f.calls.length, 0);
	assert.equal([...f.timers][0].at, ms("2026-11-03T00:00Z"));
	f.setNow(ms("2026-11-03T00:00Z"));
	await f.settle();
	assert.equal(f.service.require(row.id).notice?.outcome, "missed");
	assert.equal(f.probes, 1);
	assert.equal(f.active, false);
});
test("network return and wake catch up, while sleep and setting disable prevent admission", async (t) => {
	const f = await fixture(t),
		row = await f.service.create(f.request);
	f.start();
	f.network(false);
	f.setNow(ms("2026-11-02T10:00Z"));
	await f.settle();
	assert.equal(f.calls.length, 0);
	f.network(true);
	f.pause(true);
	await f.settle();
	assert.equal(f.calls.length, 0);
	f.pause(false);
	await f.settle({ type: "wake", full: true });
	assert.equal(f.calls.length, 1);
	f.enable(false);
	f.setNow(ms("2026-11-03T10:00Z"));
	await f.settle();
	assert.equal(f.calls.length, 1);
	assert.equal(f.timers.size, 0);
	f.enable(true);
	await f.settle();
	assert.equal(f.calls.length, 2);
	assert.equal(f.service.require(row.id).runs?.length, 2);
});
test("overlap skips previous chat and fixed target using working, then on-time success clears notice", async (t) => {
	const f = await fixture(t),
		row = await f.service.create(f.request);
	f.start();
	f.setNow(ms("2026-11-02T09:05:00Z"));
	await f.settle();
	assert.equal(f.service.require(row.id).notice, undefined); // exactly five minutes is not late
	f.chats.get("new-1")!.working = true;
	f.setNow(ms("2026-11-03T09:00Z"));
	await f.settle();
	assert.equal(f.service.require(row.id).notice?.outcome, "skipped_running");
	assert.equal(f.calls.length, 1);
	f.chats.get("new-1")!.working = false;
	f.setNow(ms("2026-11-04T09:00Z"));
	await f.settle();
	assert.equal(f.service.require(row.id).notice, undefined);
	const fixed = await f.service.create({
		...f.request,
		target: { kind: "message", sessionId: "target", message: "Follow up" },
	});
	f.chats.get("target")!.working = true;
	f.setNow(ms("2026-11-05T09:00Z"));
	await f.settle();
	assert.equal(f.service.require(fixed.id).notice?.outcome, "skipped_running");
	f.chats.get("target")!.working = false;
	f.setNow(ms("2026-11-06T09:00Z"));
	await f.settle();
	assert.equal(f.calls.at(-1)?.key, `schedule:${fixed.id}:${ms("2026-11-06T09:00Z")}`);
});
test("deleted targets and removed projects pause; transient delivery failure stays active", async (t) => {
	const f = await fixture(t);
	const deleted = await f.service.create({
		...f.request,
		target: { kind: "message", sessionId: "target", message: "Hi" },
	});
	f.chats.delete("target");
	f.start();
	f.setNow(ms("2026-11-02T10:00Z"));
	await f.settle();
	assert.equal(f.service.require(deleted.id).paused, true);
	const transient = await f.service.create(f.request);
	f.fail();
	f.setNow(ms("2026-11-03T10:00Z"));
	await f.settle();
	assert.equal(f.service.require(transient.id).notice?.outcome, "failed");
	assert.equal(f.service.require(transient.id).paused, undefined);
	f.removeProject();
	f.setNow(ms("2026-11-04T10:00Z"));
	await f.settle();
	assert.equal(f.service.require(transient.id).paused, true);
});
test("failed CAS has no effect and finalization failure leaves a non-replayable claim", async (t) => {
	const f = await fixture(t),
		row = await f.service.create(f.request),
		replace = f.store.replace.bind(f.store);
	f.store.replace = async () => {
		throw new Conflict("Lost claim");
	};
	f.start();
	f.setNow(ms("2026-11-02T10:00Z"));
	await f.settle();
	assert.equal(f.calls.length, 0);
	f.store.replace = async (old, next) => {
		if (next.state === "pending") throw new Error("Disk full");
		return replace(old, next);
	};
	await assert.rejects(f.settle(), /Disk full/);
	assert.equal(f.calls.length, 1);
	assert.equal(f.service.require(row.id).state, "dispatching");
	await f.settle();
	assert.equal(f.calls.length, 1);
});
test("runs retain ten records and Linux deadline delay is capped at fifteen minutes", async (t) => {
	const f = await fixture(t, "linux"),
		row = await f.service.create(f.request);
	f.start();
	await f.settle();
	assert.equal([...f.timers][0].at - f.clock.now(), 900000);
	for (let day = 0; day < 12; day++) {
		f.setNow(ms("2026-11-02T09:00Z") + day * DAY);
		await f.settle();
	}
	assert.equal(f.service.require(row.id).runs?.length, 10);
	assert.equal(f.calls.length, 12);
});
test("calendar detector listens to helper wake without probes or wake subprocess sampling", async () => {
	let samples = 0,
		probes = 0,
		powerActive = false;
	let callback: ((state: { available: boolean; fullWake: boolean; sleepAt?: number }) => void) | undefined;
	const events: ScheduleTriggerEvent[] = [];
	const d = new ScheduleDetection({
		sampleWake: async () => {
			samples++;
			throw new Error("No wake sampling");
		},
		probe: async () => {
			probes++;
			return true;
		},
		power: {
			subscribePower: (listener) => {
				callback = listener;
				return () => {
					callback = undefined;
				};
			},
			setPowerActive: (active) => {
				powerActive = active;
			},
		},
	});
	d.subscribe((e) => events.push(e));
	d.setCalendarActive(true);
	assert.equal(powerActive, true);
	assert.equal(samples, 0);
	assert.equal(probes, 0);
	callback?.({ available: true, fullWake: true, sleepAt: 123 });
	assert.equal(
		events.some((e) => e.type === "wake"),
		true,
	);
	assert.equal(probes, 0);
	assert.equal(await d.refreshOnline(), true);
	assert.equal(probes, 1);
	d.setCalendarActive(false);
	assert.equal(powerActive, false);
});

test("a setting change during durable claim consumes it without admitting work", async (t) => {
	const f = await fixture(t);
	const row = await f.service.create(f.request);
	const replace = f.store.replace.bind(f.store);
	f.store.replace = async (old, next) => {
		const saved = await replace(old, next);
		if (next.state === "dispatching") f.enable(false);
		return saved;
	};
	f.start();
	f.setNow(ms("2026-11-02T10:00Z"));
	await f.settle();
	assert.equal(f.calls.length, 0);
	assert.equal(f.service.require(row.id).notice?.outcome, "failed");
	f.enable(true);
	await f.settle();
	assert.equal(f.calls.length, 0, "the consumed occurrence is never retried");
});
