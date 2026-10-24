import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { SessionSummary } from "@pilot/protocol";
import { closedLidAllowed, laterWake, POWER_IDLE_GRACE_MS, PowerService, type PowerSessions } from "./power.ts";
import { type PowerCommand, type PowerSample, parsePowerSample } from "./power-helper.ts";

const sample: PowerSample = {
	available: true,
	authorized: true,
	connectedToPower: true,
	wifiConnected: true,
	online: true,
	lidClosed: false,
	sleeping: false,
	fullWake: true,
	wakeToken: "100:1",
	sleepGeneration: 1,
	closedLidActive: false,
};
const session = (id: string, state: SessionSummary["state"] = "working"): SessionSummary => ({
	id,
	state,
	title: id,
	cwd: "/tmp",
	createdAt: 0,
	updatedAt: 0,
});
class Sessions implements PowerSessions {
	powerPause: PowerSessions["powerPause"];
	listeners = new Set<(value: SessionSummary) => void>();
	resumes = 0;
	pauses = 0;
	pauseWait?: Promise<void>;
	sleepPrepared: Promise<void> = Promise.resolve();
	rows = new Map([session("working"), session("idle", "idle")].map((value) => [value.id, value]));
	list() {
		return [...this.rows.values()];
	}
	onChange(listener: (value: SessionSummary) => void) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	async pauseForSleep(wakeToken?: string) {
		this.pauses++;
		this.powerPause ??= { since: Date.now(), wakeToken };
		await this.pauseWait;
	}
	async resumeAfterSleep() {
		this.resumes++;
		this.powerPause = undefined;
	}
	change(value: SessionSummary) {
		this.rows.set(value.id, value);
		for (const listener of this.listeners) listener(value);
	}
}
async function fixture(t: TestContext, initiallyWorking = true) {
	const home = await mkdtemp(join(tmpdir(), "pilot-power-"));
	const sessions = new Sessions();
	if (!initiallyWorking) sessions.rows.delete("working");
	const commands: PowerCommand[] = [];
	let onSample!: (value: PowerSample) => void;
	let onFailure!: () => void;
	let rejectAuthorization = false;
	let closes = 0;
	const service = new PowerService(home, sessions, async (accept, fail) => {
		onSample = accept;
		onFailure = fail;
		accept({ ...sample });
		return {
			async request(command) {
				commands.push(command);
				if (command.action === "authorize" && rejectAuthorization) throw new Error("denied");
			},
			async close() {
				closes++;
			},
		};
	});
	t.after(async () => {
		await service.stop();
		await rm(home, { recursive: true, force: true });
	});
	await service.start();
	await service.settled();
	return {
		home,
		sessions,
		commands,
		service,
		get closes() {
			return closes;
		},
		async emit(value: Partial<PowerSample>) {
			onSample({ ...sample, ...value });
			await service.settled();
		},
		send(value: Partial<PowerSample>) {
			onSample({ ...sample, ...value });
		},
		fail() {
			onFailure();
		},
		deny() {
			rejectAuthorization = true;
		},
	};
}

test("closed-lid policy requires power AND Wi-Fi, and rejects unknown/dark state", () => {
	assert.equal(closedLidAllowed(sample), true);
	for (const patch of [
		{ connectedToPower: false },
		{ wifiConnected: false },
		{ available: false },
		{ sleeping: true },
		{ lidClosed: null },
	])
		assert.equal(closedLidAllowed({ ...sample, ...patch }), false);
	assert.equal(laterWake({ since: 1, wakeToken: "100:1" }, sample), false);
	assert.equal(laterWake({ since: 1, wakeToken: "99:1" }, sample), true);
	for (const patch of [
		{ online: false },
		{ fullWake: false },
		{ sleeping: true },
		{ lidClosed: true },
		{ available: false },
	])
		assert.equal(laterWake({ since: 1, wakeToken: "99:1" }, { ...sample, ...patch }), false);
	assert.equal(laterWake({ since: 1 }, sample), false);
});

test("working agents hold an idle-system assertion; only sustained idle releases it", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = await fixture(t);
	assert.deepEqual(f.commands, [{ action: "activity", awake: true, closedLid: false }]);
	f.sessions.change(session("working", "idle"));
	await f.service.settled();
	assert.equal(f.service.status().keepingAwake, true);
	t.mock.timers.tick(POWER_IDLE_GRACE_MS - 1);
	// Neither sensor reports, refresh nor unchanged idle/streaming updates extend the grace period.
	for (let index = 0; index < 10_000; index++) f.sessions.change(session("working", "idle"));
	f.service.refresh();
	await f.emit({ fullWake: false });
	assert.equal(f.commands.length, 1);
	t.mock.timers.tick(1);
	await f.service.settled();
	assert.deepEqual(f.commands.at(-1), { action: "activity", awake: false, closedLid: false });
	f.sessions.change({
		...session("jobs", "idle"),
		runningJobs: [{ id: "job", name: "build", state: "running", startedAt: 1, outputPath: "/tmp/build.log" }],
	});
	await f.service.settled();
	assert.equal(f.service.status().keepingAwake, true);
});

test("lid closure continues only on AC/Wi-Fi; pause commits before restoring override and sleeping", async (t) => {
	const f = await fixture(t);
	await f.service.configure({ keepAwake: true, closedLid: true });
	await f.emit({ lidClosed: true, closedLidActive: true });
	assert.equal(f.sessions.pauses, 0);
	assert.deepEqual(f.commands.at(-1), { action: "activity", awake: true, closedLid: true });
	let release!: () => void;
	f.sessions.pauseWait = new Promise<void>((resolve) => {
		release = resolve;
	});
	f.send({ lidClosed: true, connectedToPower: false, closedLidActive: true });
	await Promise.resolve();
	assert.equal(f.sessions.pauses, 1);
	assert.equal(
		f.commands.some((command) => command.action === "sleep"),
		false,
	);
	assert.equal(
		f.commands.some((command) => command.action === "activity" && !command.awake),
		false,
	);
	release();
	await f.service.settled();
	assert.deepEqual(f.commands.slice(-2), [
		{ action: "activity", awake: false, closedLid: false },
		{ action: "sleep" },
	]);
	await f.emit({ lidClosed: true }); // Power/Wi-Fi restored with lid shut is NOT permission to resume.
	await f.emit({ lidClosed: false }); // Opening before an actual wake is not a wake either.
	await f.emit({ wakeToken: "101:1", fullWake: false });
	await f.emit({ wakeToken: "101:1", online: false });
	assert.equal(f.sessions.resumes, 0);
	await f.emit({ wakeToken: "101:1" });
	assert.equal(f.sessions.resumes, 1);
});

test("natural lid sleep and explicit sleep pause before acknowledging the native sleep window", async (t) => {
	const f = await fixture(t);
	await f.emit({ sleeping: true, wifiConnected: false, lidClosed: true, fullWake: false });
	assert.equal(f.sessions.pauses, 1);
	assert.deepEqual(f.commands.slice(-2), [
		{ action: "allowSleep", generation: 1 },
		{ action: "activity", awake: false, closedLid: false },
	]);
});

test("sleep acknowledgement waits for durable preparation, not kernel teardown or override restoration", async (t) => {
	const f = await fixture(t);
	let prepare!: () => void;
	let close!: () => void;
	f.sessions.sleepPrepared = new Promise<void>((resolve) => {
		prepare = resolve;
	});
	f.sessions.pauseWait = new Promise<void>((resolve) => {
		close = resolve;
	});
	try {
		f.send({ sleeping: true, fullWake: false, sleepGeneration: 7 });
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(f.sessions.pauses, 1);
		assert.equal(
			f.commands.some((command) => command.action === "allowSleep"),
			false,
		);
		prepare();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(f.commands.at(-1), { action: "allowSleep", generation: 7 });
		assert.equal(
			f.commands.some((command) => command.action === "activity" && !command.awake),
			false,
		);
		close();
		await f.service.settled();
		assert.deepEqual(f.commands.at(-1), { action: "activity", awake: false, closedLid: false });
	} finally {
		prepare();
		close();
	}
});

test("permission is requested only by explicit setup; denial preserves settings", async (t) => {
	const f = await fixture(t);
	await f.emit({ authorized: false });
	assert.equal(
		f.commands.some((command) => command.action === "authorize"),
		false,
	);
	f.deny();
	await assert.rejects(f.service.configure({ keepAwake: true, closedLid: true }), /denied/);
	assert.deepEqual(f.service.status().settings, { keepAwake: true, closedLid: false });
	await assert.rejects(f.service.configure({ keepAwake: "yes", closedLid: true }), /booleans/);
	await f.service.configure({ keepAwake: false, closedLid: false });
	assert.deepEqual(JSON.parse(await readFile(join(f.home, "power-settings.json"), "utf8")), {
		keepAwake: false,
		closedLid: false,
	});
	f.fail();
	await f.service.configure({ keepAwake: false, closedLid: true });
	assert.equal(
		f.service.status().settings.keepAwake,
		false,
		"disabling the master policy needs no unavailable helper",
	);
});

test("monitor loss during closed-lid work fails closed, and never resumes a durable pause on startup", async (t) => {
	const f = await fixture(t);
	await f.emit({ lidClosed: true, closedLidActive: true });
	f.fail();
	await Promise.resolve();
	assert.equal(f.sessions.pauses, 1);
	assert.equal(f.service.status().available, false);
	assert.equal(f.service.status().paused, true);
	await f.emit({ wakeToken: "100:1" });
	assert.equal(f.sessions.resumes, 0);
});

test("network path changes are reported once per edge, and a lost helper reports unknown", async (t) => {
	const f = await fixture(t);
	const paths: Array<boolean | undefined> = [];
	f.service.onNetworkPath((path) => paths.push(path));
	await f.emit({ online: false });
	await f.emit({ online: false, wifiConnected: false });
	await f.emit({ online: true });
	f.fail();
	assert.deepEqual(paths, [false, true, undefined]);
});

test("10,000 unchanged streaming/activity updates do not enqueue native writes", async (t) => {
	const f = await fixture(t);
	const before = f.commands.length;
	for (let index = 0; index < 10_000; index++) f.sessions.change(session("working"));
	await f.service.settled();
	assert.equal(f.commands.length, before);
});

test("display sleep and lock do not pause work; finishing closed-lid work restores sleep", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = await fixture(t);
	await f.emit({ fullWake: false }); // Graphics off, but no actual system-sleep notification.
	assert.equal(f.sessions.pauses, 0);
	assert.equal(f.service.status().keepingAwake, true);
	await f.service.configure({ keepAwake: true, closedLid: true });
	await f.emit({ lidClosed: true, closedLidActive: true });
	f.sessions.change(session("working", "idle"));
	await f.service.settled();
	t.mock.timers.tick(POWER_IDLE_GRACE_MS - 1);
	await f.service.settled();
	assert.equal(f.service.status().keepingAwake, true);
	assert.equal(
		f.commands.some((command) => command.action === "sleep"),
		false,
	);
	t.mock.timers.tick(1);
	await f.service.settled();
	assert.deepEqual(f.commands.slice(-2), [
		{ action: "activity", awake: false, closedLid: false },
		{ action: "sleep" },
	]);
});

test("a later docked full wake can resume only if closed-lid work is enabled and AC/Wi-Fi hold", () => {
	const pause = { since: 1, wakeToken: "99:1" };
	const docked = { ...sample, lidClosed: true };
	assert.equal(laterWake(pause, docked), false);
	assert.equal(laterWake(pause, docked, true), true);
	assert.equal(laterWake(pause, { ...docked, connectedToPower: false }, true), false);
	assert.equal(laterWake(pause, { ...docked, wifiConnected: false }, true), false);
	assert.equal(laterWake(pause, { ...docked, wakeToken: "99:1" }, true), false);
});

test("native frames are bounded typed state, not SSIDs or location authorization", () => {
	assert.ok(parsePowerSample({ type: "state", ...sample }));
	for (const patch of [
		{ lidClosed: "closed" },
		{ available: 1 },
		{ wifiConnected: null },
		{ wakeToken: "bad" },
		{ sleeping: undefined },
		{ sleepGeneration: -1 },
		{ sleepGeneration: 1.5 },
		{ sleepGeneration: undefined },
	])
		assert.equal(parsePowerSample({ type: "state", ...sample, ...patch }), undefined);
});

test("live idle workers with busy children stay awake, but stale child history on parked chats does not", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = await fixture(t);
	const subagents = [{ name: "child", state: "working" as const, task: "Work", createdAt: 1, cwd: "/tmp" }];
	f.sessions.change({ ...session("working", "idle"), working: false, subagents });
	await f.service.settled();
	assert.equal(f.service.status().keepingAwake, true);
	f.sessions.change({ ...session("working", "parked"), working: false, subagents });
	await f.service.settled();
	t.mock.timers.tick(POWER_IDLE_GRACE_MS);
	await f.service.settled();
	assert.equal(f.service.status().keepingAwake, false);
});

test("daemon-derived working keeps job result follow-ups awake and never overrides a sleep pause", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = await fixture(t);
	f.sessions.change({ ...session("working", "idle"), working: true });
	await f.service.settled();
	assert.equal(f.service.status().keepingAwake, true);
	f.sessions.change({ ...session("working"), working: false });
	await f.service.settled();
	t.mock.timers.tick(POWER_IDLE_GRACE_MS);
	await f.service.settled();
	assert.equal(f.service.status().keepingAwake, false);
	f.sessions.change({ ...session("working", "idle"), working: true, sleepPaused: true });
	await f.service.settled();
	assert.equal(f.service.status().keepingAwake, false);
});

test("already-idle startup and repeated idle updates never create a grace period", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = await fixture(t, false);
	f.sessions.change(session("idle", "idle"));
	f.service.refresh();
	await f.emit({ fullWake: false });
	t.mock.timers.tick(POWER_IDLE_GRACE_MS);
	await f.service.settled();
	assert.deepEqual(f.commands, [{ action: "activity", awake: false, closedLid: false }]);
});

test("new work cancels the old release, and only the last worker finishing starts a fresh countdown", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = await fixture(t);
	f.sessions.change(session("working", "idle"));
	await f.service.settled();
	t.mock.timers.tick(POWER_IDLE_GRACE_MS - 1);
	f.sessions.change(session("coordinator"));
	f.sessions.change(session("second"));
	await f.service.settled();
	t.mock.timers.tick(POWER_IDLE_GRACE_MS * 2);
	await f.service.settled();
	assert.equal(f.commands.length, 1, "no transient assertion release during handoff or resumed work");
	f.sessions.change(session("coordinator", "idle"));
	await f.service.settled();
	t.mock.timers.tick(POWER_IDLE_GRACE_MS);
	await f.service.settled();
	assert.equal(f.commands.length, 1, "another worker is still busy");
	f.sessions.change(session("second", "idle"));
	await f.service.settled();
	t.mock.timers.tick(POWER_IDLE_GRACE_MS - 1);
	await f.service.settled();
	assert.equal(f.service.status().keepingAwake, true);
	t.mock.timers.tick(1);
	await f.service.settled();
	assert.deepEqual(f.commands.at(-1), { action: "activity", awake: false, closedLid: false });
});

test("sleep and unsafe closed-lid conditions bypass and cancel the idle grace", async (t) => {
	for (const state of [
		{ sleeping: true, fullWake: false },
		{ lidClosed: true, connectedToPower: false },
		{ lidClosed: true, wifiConnected: false },
	]) {
		await t.test(JSON.stringify(state), async (t) => {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			const f = await fixture(t);
			await f.service.configure({ keepAwake: true, closedLid: true });
			f.sessions.change(session("working", "idle"));
			await f.service.settled();
			assert.equal(f.service.status().keepingAwake, true);
			await f.emit(state);
			assert.equal(f.sessions.pauses, 1);
			assert.equal(f.service.status().keepingAwake, false);
			// A subsequent eligible wake must not restore the canceled grace with no active work.
			await f.emit({ wakeToken: "101:1" });
			assert.equal(f.service.status().keepingAwake, false);
			t.mock.timers.tick(POWER_IDLE_GRACE_MS);
			await f.service.settled();
			assert.equal(f.service.status().keepingAwake, false);
		});
	}
});

test("disabling keep-awake cancels grace immediately and re-enabling does not revive it", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = await fixture(t);
	f.sessions.change(session("working", "idle"));
	await f.service.settled();
	await f.service.configure({ keepAwake: false, closedLid: false });
	assert.equal(f.service.status().keepingAwake, false);
	await f.service.configure({ keepAwake: true, closedLid: false });
	assert.equal(f.service.status().keepingAwake, false);
	const writes = f.commands.length;
	t.mock.timers.tick(POWER_IDLE_GRACE_MS);
	await f.service.settled();
	assert.equal(f.commands.length, writes);
});

test("shutdown during grace closes the helper without waiting or issuing delayed writes", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = await fixture(t);
	f.sessions.change(session("working", "idle"));
	await f.service.settled();
	await f.service.stop();
	assert.equal(f.closes, 1);
	const writes = f.commands.length;
	t.mock.timers.tick(POWER_IDLE_GRACE_MS * 2);
	await f.service.settled();
	assert.equal(f.commands.length, writes);
});

test("helper loss cancels grace so reconnecting while idle cannot rearm sleep prevention", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = await fixture(t);
	f.sessions.change(session("working", "idle"));
	await f.service.settled();
	f.fail();
	assert.equal(f.service.status().keepingAwake, false);
	t.mock.timers.tick(1_000);
	await Promise.resolve(); // The injected helper factory reconnects asynchronously.
	await f.service.settled();
	assert.equal(f.service.status().available, true);
	assert.deepEqual(f.commands.at(-1), { action: "activity", awake: false, closedLid: false });
	const writes = f.commands.length;
	t.mock.timers.tick(POWER_IDLE_GRACE_MS);
	await f.service.settled();
	assert.equal(f.commands.length, writes);
});
