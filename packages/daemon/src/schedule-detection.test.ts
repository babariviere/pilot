import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	didWake,
	OFFLINE_BACKOFF_MS,
	parseWakeToken,
	probeReachability,
	sampleSystemWake,
	ScheduleDetection,
	WAKE_SAMPLE_MS,
	type WakeSample,
} from "./schedule-detection.ts";
import { ScheduleStore } from "./schedule-store.ts";
import { ScheduleService, type ScheduleClock, type ScheduleTriggerEvent } from "./schedules.ts";
import { SubprocessPool } from "./subprocess.ts";

class FakeClock implements ScheduleClock {
	time = 0;
	timers = new Set<{ at: number; callback: () => void }>();
	now = () => this.time;
	setTimeout(callback: () => void, ms: number): () => void {
		const timer = { at: this.time + ms, callback };
		this.timers.add(timer);
		return () => {
			this.timers.delete(timer);
		};
	}
	advance(ms: number): void {
		this.time += ms;
		for (const timer of [...this.timers])
			if (timer.at <= this.time) {
				this.timers.delete(timer);
				timer.callback();
			}
	}
}
const flush = async () => {
	for (let i = 0; i < 12; i++) await Promise.resolve();
};
function fixture() {
	const clock = new FakeClock();
	let token = "1:0",
		reachable = true,
		samples = 0,
		probes = 0;
	const events: ScheduleTriggerEvent[] = [];
	const detector = new ScheduleDetection({
		clock,
		sampleWake: async () => {
			samples++;
			return { wallMs: clock.time, monotonicMs: clock.time, wakeToken: token };
		},
		probe: async () => {
			probes++;
			return reachable;
		},
	});
	detector.subscribe((event) => events.push(event));
	return {
		clock,
		detector,
		events,
		get samples() {
			return samples;
		},
		get probes() {
			return probes;
		},
		wake: () => {
			token = `${Number(token.split(":")[0]) + 1}:0`;
		},
		reach: (online: boolean) => {
			reachable = online;
		},
	};
}

test("sleep drift excludes ordinary late ticks, jitter, backward time and clock reset", () => {
	const previous = { wallMs: 100_000, monotonicMs: 10_000 };
	assert.equal(didWake(previous, { wallMs: 140_000, monotonicMs: 50_000 }), false);
	assert.equal(didWake(previous, { wallMs: 134_999, monotonicMs: 40_000 }), false);
	assert.equal(didWake(previous, { wallMs: 135_000, monotonicMs: 40_000 }), true);
	assert.equal(didWake(previous, { wallMs: 1_000, monotonicMs: 40_000 }), false);
	assert.equal(didWake(previous, { wallMs: 140_000, monotonicMs: 1_000 }), false);
});

test("Darwin kernel token detects sleep with continuous hrtime and ignores wall-clock adjustments", () => {
	const previous = { wallMs: 100_000, monotonicMs: 10_000, wakeToken: "1:0" };
	assert.equal(didWake(previous, { wallMs: 140_000, monotonicMs: 50_000, wakeToken: "2:0" }), true);
	assert.equal(didWake(previous, { wallMs: 140_000, monotonicMs: 11_000, wakeToken: "1:0" }), false);
	assert.equal(didWake(previous, { wallMs: 140_000, monotonicMs: 11_000 }), false);
	assert.equal(parseWakeToken("kern.waketime: { sec = 1791873185, usec = 364509 } Tue Oct 13"), "1791873185:364509");
	assert.equal(parseWakeToken("{ sec = 0, usec = 0 }"), "0:0");
	assert.throws(() => parseWakeToken("error"), /Invalid/);
	assert.throws(() => parseWakeToken("{ sec = 1, usec = 1000000 }"), /Invalid/);
});

test("idle has zero work, activation is not an online edge, wake invalidates cached online and dedupes", async () => {
	const f = fixture();
	f.clock.advance(10 * WAKE_SAMPLE_MS);
	assert.equal(f.samples + f.probes, 0);
	f.detector.setActive(true);
	await flush();
	assert.deepEqual(f.events, [
		{ type: "online", online: false, initial: true },
		{ type: "online", online: true, initial: true },
	]);
	f.events.length = 0;
	f.wake();
	f.clock.advance(WAKE_SAMPLE_MS);
	await flush();
	assert.deepEqual(f.events, [
		{ type: "online", online: false, initial: true },
		{ type: "wake" },
		{ type: "online", online: true, initial: true },
	]);
	f.clock.advance(WAKE_SAMPLE_MS);
	await flush();
	assert.equal(f.events.filter((e) => e.type === "wake").length, 1);
	f.detector.setActive(false);
	assert.equal(f.clock.timers.size, 0);
	const work = f.probes + f.samples;
	f.clock.advance(1_000_000);
	await flush();
	assert.equal(f.probes + f.samples, work);
	f.detector.setActive(true);
	await flush();
	assert.equal(f.events.at(-1)?.type, "online");
	assert.equal((f.events.at(-1) as { initial: boolean }).initial, true);
	f.detector.setActive(false);
});

test("offline probes use capped coarse backoff and only an observed offline→online edge is emitted", async () => {
	const f = fixture();
	f.reach(false);
	f.detector.setActive(true);
	await flush();
	assert.equal(f.probes, 1);
	for (const delay of [...OFFLINE_BACKOFF_MS, 60_000, 60_000]) {
		const before: number = f.probes;
		f.clock.advance(delay - 1);
		await flush();
		assert.equal(f.probes, before);
		f.clock.advance(1);
		await flush();
		assert.equal(f.probes, before + 1);
	}
	f.reach(true);
	f.clock.advance(60_000);
	await flush();
	assert.deepEqual(f.events.at(-1), { type: "online", online: true, initial: false });
	f.clock.advance(WAKE_SAMPLE_MS);
	await flush();
	assert.equal(f.events.filter((e) => e.type === "online" && e.online && !e.initial).length, 1);
	f.detector.setActive(false);
});

test("cancelled and superseded probes cannot publish stale success or rearm timers", async () => {
	const clock = new FakeClock();
	const pending: Array<{ signal: AbortSignal; resolve: (online: boolean) => void }> = [];
	let token = "1:0";
	const detector = new ScheduleDetection({
		clock,
		sampleWake: async () => ({ wallMs: clock.time, monotonicMs: clock.time, wakeToken: token }),
		probe: (signal) => new Promise((resolve) => pending.push({ signal, resolve })),
	});
	const events: ScheduleTriggerEvent[] = [];
	detector.subscribe((event) => events.push(event));
	detector.setActive(true);
	await flush();
	const first = detector.refreshOnline();
	assert.equal(detector.refreshOnline(), first);
	assert.equal(pending.length, 1);
	token = "2:0";
	clock.advance(WAKE_SAMPLE_MS);
	await flush();
	assert.equal(pending[0].signal.aborted, true);
	assert.equal(pending.length, 2);
	pending[0].resolve(true);
	await flush();
	assert.equal(detector.online, false);
	assert.equal(
		events.some((e) => e.type === "online" && e.online),
		false,
	);
	detector.setActive(false);
	assert.equal(pending[1].signal.aborted, true);
	detector.setActive(true);
	await flush();
	pending[1].resolve(true);
	await flush();
	assert.equal(detector.online, false);
	pending[2].resolve(true);
	await flush();
	assert.equal(detector.online, true);
	detector.setActive(false);
	assert.equal(clock.timers.size, 0);
});

test("wake debounce consumes duplicate observations without swallowing a later wake", async () => {
	const clock = new FakeClock();
	let sample: WakeSample = { wallMs: 0, monotonicMs: 0, wakeToken: "1:0" };
	const detector = new ScheduleDetection({ clock, sampleWake: async () => sample, probe: async () => false });
	const events: ScheduleTriggerEvent[] = [];
	detector.subscribe((event) => events.push(event));
	detector.setActive(true);
	await flush();
	for (const [ms, token] of [
		[30_000, "2:0"],
		[30_001, "3:0"],
		[60_000, "4:0"],
	] as const) {
		sample = { wallMs: ms, monotonicMs: ms, wakeToken: token };
		clock.advance(WAKE_SAMPLE_MS);
		await flush();
	}
	assert.equal(events.filter((e) => e.type === "wake").length, 2);
	detector.setActive(false);
});

test("sampler failures are bounded, do not invent wakes and recover", async () => {
	const clock = new FakeClock();
	let broken = true;
	const warnings: string[] = [];
	const events: ScheduleTriggerEvent[] = [];
	const detector = new ScheduleDetection({
		clock,
		warn: (message) => warnings.push(message),
		probe: async () => false,
		sampleWake: async () => {
			if (broken) throw new Error("sample unavailable");
			return { wallMs: clock.time, monotonicMs: clock.time, wakeToken: "1:0" };
		},
	});
	detector.subscribe((event) => events.push(event));
	detector.setActive(true);
	await flush();
	clock.advance(WAKE_SAMPLE_MS);
	await flush();
	assert.equal(warnings.length, 1);
	broken = false;
	clock.advance(WAKE_SAMPLE_MS);
	await flush();
	assert.equal(
		events.some((e) => e.type === "wake"),
		false,
	);
	detector.setActive(false);
});

test("synchronous probe failures retry rather than retaining a resolved in-flight promise", async () => {
	const clock = new FakeClock();
	let broken = true;
	const detector = new ScheduleDetection({
		clock,
		sampleWake: async () => ({ wallMs: clock.time, monotonicMs: clock.time }),
		probe: () => {
			if (broken) throw new Error("failed probe");
			return Promise.resolve(true);
		},
	});
	detector.setActive(true);
	await flush();
	assert.equal(detector.online, false);
	broken = false;
	clock.advance(5000);
	await flush();
	assert.equal(detector.online, true);
	detector.setActive(false);
});

test("real reachability probe rejects portal responses, redirects, failures and aborts", async (t) => {
	let status = 204;
	const server = createServer((req, res) => {
		assert.equal(req.method, "HEAD");
		res.writeHead(status, { Location: "/online" });
		res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const address = server.address() as { port: number };
	const url = `http://127.0.0.1:${address.port}`;
	const abort = new AbortController();
	assert.equal(await probeReachability(abort.signal, url), true);
	for (status of [200, 302, 500]) assert.equal(await probeReachability(abort.signal, url), false);
	abort.abort();
	assert.equal(await probeReachability(abort.signal, url), false);
});

test("macOS sampler reads the real kernel timestamp off-thread without the app", {
	skip: process.platform !== "darwin",
}, async (t) => {
	const pool = new SubprocessPool({ maxThreads: 1 });
	t.after(() => pool.close());
	const sample = await sampleSystemWake(new AbortController().signal, pool);
	assert.match(sample.wakeToken!, /^\d+:\d+$/);
	assert.ok(sample.monotonicMs > 0);
});

test("merged store/dispatch waits through wake while offline and fires once after recovery", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-wake-"));
	const f = fixture();
	const store = new ScheduleStore(join(home, "schedules.sqlite"));
	let calls = 0;
	const service = new ScheduleService(store, {
		clock: f.clock,
		triggers: f.detector,
		projects: {
			require: () => {
				throw new Error("unused");
			},
		},
		sessions: {
			get: () => undefined,
			spawn: async () => {
				calls++;
				return { id: "created" };
			},
			send: async () => {},
		},
	});
	await service.load();
	service.start();
	t.after(async () => {
		await service.stop();
		await store.close();
		await rm(home, { recursive: true, force: true });
	});
	const drain = async () => {
		await flush();
		await service.signal({ type: "online", online: f.detector.online, initial: true });
	};
	const item = await service.create({ target: { kind: "chat", spawn: { cwd: home, message: "Start after wake" } } });
	await drain();
	assert.equal(f.detector.online, true);
	f.reach(false);
	f.wake();
	f.clock.advance(WAKE_SAMPLE_MS);
	await drain();
	assert.equal(service.require(item.id).wakeObserved, true);
	assert.equal(calls, 0);
	f.clock.advance(5_000);
	await drain();
	assert.equal(calls, 0);
	f.reach(true);
	f.clock.advance(10_000);
	await drain();
	assert.equal(service.require(item.id).state, "fired");
	assert.equal(calls, 1);
	assert.equal(f.clock.timers.size, 0);
	f.clock.advance(1_000_000);
	await drain();
	assert.equal(calls, 1);
});

test("due at dispatch refreshes cached reachability, then catches up online without a wake", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-at-online-"));
	const f = fixture();
	const store = new ScheduleStore(join(home, "schedules.sqlite"));
	let calls = 0;
	const service = new ScheduleService(store, {
		clock: f.clock,
		triggers: f.detector,
		projects: {
			require: () => {
				throw new Error("unused");
			},
		},
		sessions: {
			get: () => undefined,
			spawn: async () => {
				calls++;
				return { id: "created" };
			},
			send: async () => {},
		},
	});
	await service.load();
	service.start();
	t.after(async () => {
		await service.stop();
		await store.close();
		await rm(home, { recursive: true, force: true });
	});
	const drain = async () => {
		await flush();
		await service.signal({ type: "online", online: f.detector.online, initial: true });
	};
	const item = await service.create({
		trigger: "at",
		at: 1000,
		target: { kind: "chat", spawn: { cwd: home, message: "At deadline" } },
	});
	await drain();
	assert.equal(f.detector.online, true);
	f.reach(false);
	f.clock.advance(1000);
	await drain();
	assert.equal(calls, 0);
	assert.equal(service.require(item.id).state, "pending");
	f.reach(true);
	f.clock.advance(5000);
	await drain();
	assert.equal(calls, 1);
	assert.equal(service.require(item.id).state, "fired");
	assert.equal(f.clock.timers.size, 0);
});

test("claiming the last item stops detection even while session admission is still running", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-admission-wake-"));
	const f = fixture();
	const store = new ScheduleStore(join(home, "schedules.sqlite"));
	let admit!: () => void, release!: () => void;
	const admitted = new Promise<void>((resolve) => {
		admit = resolve;
	});
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const service = new ScheduleService(store, {
		clock: f.clock,
		triggers: f.detector,
		projects: {
			require: () => {
				throw new Error("unused");
			},
		},
		sessions: {
			get: () => undefined,
			send: async () => {},
			spawn: async () => {
				admit();
				await held;
				return { id: "created" };
			},
		},
	});
	await service.load();
	service.start();
	t.after(async () => {
		release();
		await service.stop();
		await store.close();
		await rm(home, { recursive: true, force: true });
	});
	const item = await service.create({ target: { kind: "chat", spawn: { cwd: home, message: "Wake" } } });
	await flush();
	await service.signal({ type: "online", online: f.detector.online, initial: true });
	f.wake();
	f.clock.advance(WAKE_SAMPLE_MS);
	await admitted;
	assert.equal(service.require(item.id).state, "dispatching");
	assert.equal(f.clock.timers.size, 0);
	release();
	await service.signal({ type: "online", online: false, initial: true });
	assert.equal(service.require(item.id).state, "fired");
});
