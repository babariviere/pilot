import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ScheduleRequest, SpawnRequest } from "@pilot/protocol";
import { Conflict, NotFound } from "./errors.ts";
import { ScheduleStore } from "./schedule-store.ts";
import { TrackedItemStore } from "./tracked-items.ts";
import { SystemEventsDetection } from "./wifi-detection.ts";
import type { WiFiStatus } from "@pilot/protocol";
import {
	ScheduleService,
	type ScheduleClock,
	type ScheduleTriggerEvent,
	type ScheduleTriggerSource,
} from "./schedules.ts";

class FakeClock implements ScheduleClock {
	time = 1000;
	timers = new Map<number, { at: number; callback: () => void }>();
	private serial = 0;
	now = () => this.time;
	setTimeout(callback: () => void, ms: number): () => void {
		const id = ++this.serial;
		this.timers.set(id, { at: this.time + ms, callback });
		return () => {
			this.timers.delete(id);
		};
	}
	advance(ms: number): void {
		this.time += ms;
		for (const [id, timer] of [...this.timers])
			if (timer.at <= this.time) {
				this.timers.delete(id);
				timer.callback();
			}
	}
}
class FakeTriggers implements ScheduleTriggerSource {
	online = false;
	active = false;
	listeners = new Set<(event: ScheduleTriggerEvent) => void>();
	setActive(active: boolean): void {
		this.active = active;
	}
	subscribe(listener: (event: ScheduleTriggerEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	emit(event: ScheduleTriggerEvent): void {
		if (event.type === "online") this.online = event.online;
		for (const listener of this.listeners) listener(event);
	}
}
async function fixture(t: TestContext, initialOnline = false) {
	const home = await mkdtemp(join(tmpdir(), "pilot-schedules-"));
	const file = join(home, "schedules.sqlite");
	const trackingFile = join(home, "tracked-items.sqlite");
	let trackedItems = new TrackedItemStore(trackingFile);
	await trackedItems.load(["p", "other"]);
	for (const projectId of ["p", "other"])
		for (const kind of ["linear", "slack"] as const)
			await trackedItems.commit(projectId, kind, [
				{
					externalId: "issue-1",
					title: "Fix crash",
					url: "https://example.com/issue/1",
					status: "Todo",
					metadata: {},
					updatedAt: 1,
				},
			]);
	const clock = new FakeClock();
	const triggers = new FakeTriggers();
	let reportWiFi!: (value: WiFiStatus) => void;
	const wifi = new SystemEventsDetection(async (onStatus) => {
		reportWiFi = onStatus;
		return { send() {}, close() {} };
	});
	triggers.online = initialOnline;
	const calls: Array<{
		kind: string;
		spawn?: SpawnRequest;
		id?: string;
		message?: string;
		requestId?: string;
		mode?: string;
	}> = [];
	const chats = new Map([["existing", { projectId: "p" }]]);
	let failure: Error | undefined;
	const sessions = {
		get: (id: string) => chats.get(id),
		spawn: async (spawn: SpawnRequest) => {
			calls.push({ kind: "chat", spawn });
			if (failure) throw failure;
			return { id: "created" };
		},
		send: async (id: string, message: string, mode: "followUp", requestId: string) => {
			calls.push({ kind: "message", id, message, mode, requestId });
			if (failure) throw failure;
		},
	};
	const deps = {
		wifi,
		trackedItems,
		clock,
		triggers,
		sessions,
		projects: {
			require: (id: string) => {
				if (id !== "p") throw new NotFound("Unknown project");
				return { id, path: home, name: "Project", createdAt: 0 };
			},
		},
	};
	let store = new ScheduleStore(file);
	let service = new ScheduleService(store, deps);
	await service.load();
	service.start();
	const settle = () => service.signal({ type: "online", online: triggers.online });
	await settle();
	t.after(async () => {
		wifi.stop();
		await service.stop();
		await store.close();
		await trackedItems.close();
		await rm(home, { recursive: true, force: true });
	});
	return {
		wifi,
		reportWiFi: (currentNetwork: string | null, authorization: WiFiStatus["authorization"] = "authorized") =>
			reportWiFi({ authorization, available: true, currentNetwork, knownNetworks: ["Office", "Home"] }),
		clock,
		triggers,
		calls,
		chats,
		file,
		deps,
		get trackedItems() {
			return trackedItems;
		},
		settle,
		get service() {
			return service;
		},
		get store() {
			return store;
		},
		fail: (error: Error | undefined) => {
			failure = error;
		},
		restart: async () => {
			await service.stop();
			await store.close();
			await trackedItems.close();
			trackedItems = new TrackedItemStore(trackingFile);
			await trackedItems.load(["p", "other"]);
			deps.trackedItems = trackedItems;
			store = new ScheduleStore(file);
			service = new ScheduleService(store, deps);
			await service.load();
			service.start();
			await settle();
		},
	};
}
const chat = (extra: Partial<ScheduleRequest> = {}): ScheduleRequest => ({
	target: {
		kind: "chat",
		spawn: {
			projectId: "p",
			message: "Do the work",
			mode: "ask",
			baseBranch: "release",
			model: "provider/model",
			thinking: "high",
			title: "Work",
		},
	},
	...extra,
});

test("Wi-Fi schedules fire once on next matching transition, without reachability or GUI", async (t) => {
	const f = await fixture(t);
	const join = await f.service.create(
		chat({ trigger: "on_join_network", networkNames: ["Office", "Home", "Office"] }),
	);
	const leave = await f.service.create(chat({ trigger: "on_leave_network", networkNames: ["Office"] }));
	await f.settle();
	assert.equal(f.triggers.active, false); // Wi-Fi-only work needs no wake sampling / HTTPS probes.
	f.reportWiFi("Office"); // Initial already-connected observation must not fire.
	await f.settle();
	assert.equal(f.calls.length, 0);
	f.reportWiFi("Office"); // roaming on the same name
	await f.settle();
	assert.equal(f.calls.length, 0);
	f.reportWiFi("Home"); // A→B fires leave A and join B.
	await f.settle();
	assert.equal(f.calls.length, 2);
	assert.equal(f.service.require(join.id).state, "fired");
	assert.equal(f.service.require(leave.id).state, "fired");
	f.reportWiFi("Office");
	await f.settle();
	assert.equal(f.calls.length, 2);
});

test("Wi-Fi edit, cancellation, authorization loss and restart preserve one-shot semantics", async (t) => {
	const f = await fixture(t, true);
	const leave = await f.service.create(chat({ trigger: "on_leave_network", networkNames: ["Office"] }));
	const cancelled = await f.service.create(chat({ trigger: "on_join_network", networkNames: ["Home"] }));
	await f.settle();
	f.reportWiFi("Office");
	await f.settle();
	await f.service.remove(cancelled.id);
	f.reportWiFi(null, "denied"); // Not a leave.
	f.reportWiFi("Home"); // Restored authorization is a baseline.
	await f.settle();
	assert.equal(f.calls.length, 0);
	const edited = await f.service.update(leave.id, { networkNames: ["Home"], expectedRevision: 1 });
	assert.deepEqual(edited.networkNames, ["Home"]);
	assert.deepEqual(f.store.dashboard("p").find((item) => item.id === leave.id)?.networkNames, ["Home"]);
	await f.restart();
	assert.deepEqual(f.service.require(leave.id).networkNames, ["Home"]);
	f.reportWiFi("Home"); // No synthetic restart edge.
	await f.settle();
	assert.equal(f.calls.length, 0);
	f.reportWiFi(null); // Wi-Fi disabled even if overall reachability stays online.
	await f.settle();
	assert.equal(f.calls.length, 1);
	assert.equal(f.service.require(cancelled.id).state, "cancelled");
});

test("Wi-Fi names validate UTF-8 length, remain exact and clear when switching triggers", async (t) => {
	const f = await fixture(t);
	for (const networkNames of [undefined, [], [""], ["a".repeat(33)], ["é".repeat(17)], Array(33).fill("Home"), [123]])
		await assert.rejects(
			f.service.create(chat({ trigger: "on_join_network", networkNames } as Partial<ScheduleRequest>)),
			/networkNames/,
		);
	await assert.rejects(f.service.create(chat({ networkNames: ["Home"] })), /only valid/);
	const saved = await f.service.create(
		chat({ trigger: "on_join_network", networkNames: [" Home ", "Home", "home", "Home"] }),
	);
	assert.deepEqual(saved.networkNames, [" Home ", "Home", "home"]);
	const edited = await f.service.update(saved.id, { trigger: "on_online" });
	assert.equal(edited.networkNames, undefined);
	await assert.rejects(f.service.update(saved.id, { trigger: "on_leave_network" }), /networkNames/);
});

test("scheduled tickets survive edits and restart, then bind on dispatch exactly once", async (t) => {
	const f = await fixture(t);
	for (const kind of ["linear", "slack"] as const) {
		const ticket = (await f.trackedItems.list({ projectId: "p", kind })).items[0]!;
		const target = { ...chat().target, trackedItemId: ticket.id };
		const item = await f.service.create(chat({ target }));
		assert.equal((await f.trackedItems.require(ticket.id)).sessionId, undefined);
		await f.service.update(item.id, { title: "Edited", trigger: "on_online" });
		await f.restart();
		assert.deepEqual(f.service.require(item.id).target, target);
		assert.equal((await f.trackedItems.require(ticket.id)).sessionId, undefined);
		await f.service.signal({ type: "online", online: false });
		await f.service.signal({ type: "online", online: true });
		const fired = f.service.require(item.id);
		assert.equal(fired.state, "fired");
		assert.equal(fired.sessionId, "created");
		assert.deepEqual((await f.trackedItems.require(ticket.id)).sessionIds, ["created"]);
		await f.service.signal({ type: "online", online: false });
		await f.service.signal({ type: "online", online: true });
	}
	assert.equal(f.calls.length, 2);
	await f.restart();
	assert.equal(f.calls.length, 2);
	for (const kind of ["linear", "slack"] as const)
		assert.equal((await f.trackedItems.list({ projectId: "p", kind })).items[0]!.sessionId, "created");
});

test("ticket binding is validated on create, replacement and dispatch", async (t) => {
	const f = await fixture(t);
	const ticket = (await f.trackedItems.list({ projectId: "p" })).items[0]!;
	const other = (await f.trackedItems.list({ projectId: "other" })).items[0]!;
	const target = { kind: "chat" as const, spawn: { projectId: "p", message: "Work" }, trackedItemId: ticket.id };
	for (const trackedItemId of [null, 1, "", " ", "x".repeat(201), "missing", other.id])
		await assert.rejects(f.service.create({ target: { ...target, trackedItemId } } as ScheduleRequest));
	await assert.rejects(
		f.service.create({ target: { ...target, spawn: { cwd: "/tmp", message: "Work" } } }),
		/project/,
	);
	await assert.rejects(
		f.service.create({
			target: {
				kind: "message",
				sessionId: "existing",
				message: "Work",
				trackedItemId: ticket.id,
			},
		} as ScheduleRequest),
		/only valid for a chat/,
	);
	const item = await f.service.create({ trigger: "on_wake", target });
	await assert.rejects(f.service.update(item.id, { target: { ...target, trackedItemId: other.id } }), /project/);
	assert.deepEqual(f.service.require(item.id).target, target);
	f.trackedItems.require = async () => {
		throw new NotFound("Ticket was removed");
	};
	await f.service.signal({ type: "sleep", at: f.clock.now() + 1 });
	await f.service.signal({ type: "wake", full: true });
	assert.equal(f.calls.length, 0);
	assert.equal(f.service.require(item.id).state, "failed");
	assert.match(f.service.require(item.id).error!, /Ticket was removed/);
});

test("complete target replacement can change or remove the scheduled ticket", async (t) => {
	const f = await fixture(t);
	const linear = (await f.trackedItems.list({ projectId: "p", kind: "linear" })).items[0]!;
	const slack = (await f.trackedItems.list({ projectId: "p", kind: "slack" })).items[0]!;
	const target = { kind: "chat" as const, spawn: { projectId: "p", message: "Work" }, trackedItemId: linear.id };
	const item = await f.service.create({ trigger: "on_wake", target });
	const replaced = await f.service.update(item.id, { target: { ...target, trackedItemId: slack.id } });
	assert.deepEqual(replaced.target, { ...target, trackedItemId: slack.id });
	const unbound = await f.service.update(item.id, { target: { kind: "chat", spawn: target.spawn } });
	assert.deepEqual(unbound.target, { kind: "chat", spawn: target.spawn });
	await f.restart();
	await f.service.signal({ type: "sleep", at: f.clock.now() + 1 });
	await f.service.signal({ type: "wake", full: true });
	assert.equal(f.service.require(item.id).state, "fired");
	assert.equal((await f.trackedItems.require(linear.id)).sessionId, undefined);
	assert.equal((await f.trackedItems.require(slack.id)).sessionId, undefined);
});

test("cancelled or failed admission never binds; binding failure retains the created chat without replay", async (t) => {
	const f = await fixture(t);
	const ticket = (await f.trackedItems.list({ projectId: "p" })).items[0]!;
	const request: ScheduleRequest = {
		trigger: "on_wake",
		target: {
			kind: "chat",
			spawn: { projectId: "p", message: "Work" },
			trackedItemId: ticket.id,
		},
	};
	const cancelled = await f.service.create(request);
	await f.service.remove(cancelled.id);
	await f.service.signal({ type: "sleep", at: f.clock.now() + 1 });
	await f.service.signal({ type: "wake", full: true });
	assert.equal(f.calls.length, 0);
	const rejected = await f.service.create(request);
	f.fail(new Error("Admission failed"));
	await f.service.signal({ type: "sleep", at: f.clock.now() + 1 });
	await f.service.signal({ type: "wake", full: true });
	assert.equal(f.service.require(rejected.id).state, "failed");
	assert.equal((await f.trackedItems.require(ticket.id)).sessionId, undefined);
	await f.restart();
	f.fail(undefined);
	f.trackedItems.patch = async () => {
		throw new Error("Binding failed");
	};
	const item = await f.service.create(request);
	await f.service.signal({ type: "sleep", at: f.clock.now() + 1 });
	await f.service.signal({ type: "wake", full: true });
	assert.equal(f.service.require(item.id).state, "failed");
	assert.equal(f.service.require(item.id).sessionId, "created");
	assert.match(f.service.require(item.id).error!, /Binding failed/);
	await f.service.signal({ type: "sleep", at: f.clock.now() + 1 });
	await f.service.signal({ type: "wake", full: true });
	await f.restart();
	assert.equal(f.calls.length, 2);
});

test("wake then online survives restart and fires once with the full spawn request", async (t) => {
	const f = await fixture(t);
	const item = await f.service.create(chat());
	assert.equal(item.trigger, "on_back");
	await f.service.signal({ type: "sleep", at: f.clock.now() + 1 });
	await f.service.signal({ type: "wake", full: true });
	assert.equal(f.calls.length, 0);
	assert.equal(f.service.require(item.id).wakeObserved, true);
	await f.restart();
	assert.equal(f.calls.length, 0);
	f.triggers.online = true;
	await f.service.signal({ type: "online", online: true });
	assert.deepEqual(f.calls, [{ kind: "chat", spawn: item.target.kind === "chat" ? item.target.spawn : undefined }]);
	assert.equal(f.service.require(item.id).state, "fired");
	assert.equal(f.service.require(item.id).sessionId, "created");
	await f.service.signal({ type: "sleep", at: f.clock.now() + 1 });
	await f.service.signal({ type: "wake", full: true });
	await f.service.signal({ type: "online", online: true });
	await f.restart();
	assert.equal(f.calls.length, 1);
});

test("on_online requires a new offline→online edge; wake-only is independent", async (t) => {
	const f = await fixture(t, true);
	const online = await f.service.create(chat({ trigger: "on_online" }));
	await f.settle();
	await f.service.signal({ type: "sleep", at: f.clock.now() + 1 });
	await f.service.signal({ type: "wake", full: true });
	assert.equal(f.calls.length, 0);
	const wake = await f.service.create(chat({ trigger: "on_wake" }));
	f.triggers.online = false;
	await f.service.signal({ type: "online", online: false });
	await f.service.signal({ type: "sleep", at: f.clock.now() + 1 });
	await f.service.signal({ type: "wake", full: true });
	assert.equal(f.service.require(wake.id).state, "fired");
	assert.equal(f.service.require(online.id).state, "pending");
	f.triggers.online = true;
	f.triggers.emit({ type: "online", online: true });
	await f.settle();
	assert.equal(f.service.require(online.id).state, "fired");
	assert.equal(f.calls.length, 2);
	assert.equal(f.triggers.active, false);
});

test("nearest at deadline uses a fake clock, defers offline, and cancels timers when idle", async (t) => {
	const f = await fixture(t, true);
	const first = await f.service.create(chat({ trigger: "at", at: 2000 }));
	const second = await f.service.create(chat({ trigger: "at", at: 3000 }));
	await f.settle();
	assert.equal(f.clock.timers.size, 1);
	f.clock.advance(999);
	await f.settle();
	assert.equal(f.calls.length, 0);
	f.clock.advance(1);
	await f.settle();
	assert.equal(f.service.require(first.id).state, "fired");
	assert.equal(f.clock.timers.size, 1);
	f.triggers.online = false;
	await f.service.signal({ type: "online", online: false });
	assert.equal(f.clock.timers.size, 0);
	f.clock.advance(5000);
	await f.service.signal({ type: "sleep", at: f.clock.now() + 1 });
	await f.service.signal({ type: "wake", full: true });
	assert.equal(f.service.require(second.id).state, "pending");
	await f.restart();
	f.triggers.online = true;
	await f.service.signal({ type: "online", online: true });
	assert.equal(f.service.require(second.id).state, "fired");
	await f.settle();
	assert.equal(f.clock.timers.size, 0);
	assert.equal(f.triggers.active, false);
});

test("follow-ups use the durable admission key and deleted targets become Needs you", async (t) => {
	const f = await fixture(t);
	const request: ScheduleRequest = {
		trigger: "on_wake",
		target: { kind: "message", sessionId: "existing", message: "Continue" },
	};
	const item = await f.service.create(request);
	await f.service.signal({ type: "sleep", at: f.clock.now() + 1 });
	await f.service.signal({ type: "wake", full: true });
	assert.deepEqual(f.calls, [
		{ kind: "message", id: "existing", message: "Continue", mode: "followUp", requestId: `schedule:${item.id}` },
	]);
	const deleted = await f.service.create(request);
	f.chats.delete("existing");
	await f.service.signal({ type: "sleep", at: f.clock.now() + 1 });
	await f.service.signal({ type: "wake", full: true });
	assert.equal(f.service.require(deleted.id).state, "failed");
	assert.match(f.service.require(deleted.id).error!, /deleted/);
	assert.equal(f.calls.length, 1);
	assert.equal(f.service.dashboard("p")[0].state, "failed");
	await assert.rejects(f.service.create(request), NotFound);
});

test("dispatch errors never replay and interrupted claims recover as uncertain failures", async (t) => {
	const f = await fixture(t);
	f.fail(new Error("No model access"));
	const failed = await f.service.create(chat({ trigger: "on_wake" }));
	await f.service.signal({ type: "sleep", at: f.clock.now() + 1 });
	await f.service.signal({ type: "wake", full: true });
	assert.equal(f.service.require(failed.id).error, "No model access");
	const interrupted = await f.service.create(chat());
	await f.store.replace(interrupted, { ...interrupted, state: "dispatching", claimedAt: f.clock.now() });
	await f.restart();
	assert.equal(f.service.require(interrupted.id).state, "failed");
	assert.match(f.service.require(interrupted.id).error!, /uncertain/);
	await f.service.signal({ type: "sleep", at: f.clock.now() + 1 });
	await f.service.signal({ type: "wake", full: true });
	assert.equal(f.calls.length, 1);
});

test("CRUD revision guards and atomic claim vs edit/cancel races have one winner", async (t) => {
	const f = await fixture(t);
	const item = await f.service.create(chat());
	const edited = await f.service.update(item.id, {
		title: "Changed",
		trigger: "at",
		at: 2000,
		expectedRevision: item.revision,
	});
	assert.equal(edited.revision, 2);
	assert.equal(edited.title, "Changed");
	assert.equal(edited.projectId, "p");
	await assert.rejects(f.service.update(item.id, { title: "Stale", expectedRevision: 1 }), Conflict);
	const results = await Promise.allSettled([
		f.store.replace(edited, { ...edited, state: "dispatching" }),
		f.store.replace(edited, { ...edited, state: "dispatching" }),
		f.service.update(item.id, { title: "Too late" }),
		f.service.remove(item.id),
	]);
	assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
	await assert.rejects(f.service.remove(item.id), Conflict);
	await assert.rejects(f.service.update(item.id, { title: "Too late" }), Conflict);
	const pending = await f.service.create(chat());
	await f.service.remove(pending.id);
	assert.equal(f.service.require(pending.id).state, "cancelled");
	await f.service.signal({ type: "sleep", at: f.clock.now() + 1 });
	await f.service.signal({ type: "wake", full: true });
	await f.service.remove(pending.id);
	assert.throws(() => f.service.require(pending.id), NotFound);
});

test("editing resets sleep/wake progress; events exclude later schedules", async (t) => {
	const f = await fixture(t);
	const item = await f.service.create(chat());
	await f.service.signal({ type: "sleep", at: f.clock.now() + 1 });
	await f.service.signal({ type: "wake", full: true });
	await f.service.update(item.id, { title: "Changed" });
	assert.equal(f.service.require(item.id).wakeObserved, undefined);
	assert.equal(f.service.require(item.id).sleepObserved, undefined);
	await f.service.update(item.id, { trigger: "on_wake" });
	await f.service.update(item.id, { trigger: "on_back" });
	assert.equal(f.service.require(item.id).wakeObserved, undefined);
	await f.service.signal({ type: "sleep", at: f.clock.now() + 1 });
	const before = f.service.signal({ type: "wake", full: true });
	const later = await f.service.create(chat());
	await before;
	f.triggers.online = true;
	await f.service.signal({ type: "online", online: true });
	assert.equal(f.service.require(item.id).state, "fired");
	assert.equal(f.service.require(later.id).state, "pending");
	await f.service.stop();
	assert.equal(f.triggers.listeners.size, 0);
	assert.equal(f.clock.timers.size, 0);
	assert.equal(f.triggers.active, false);
});

test("validates untrusted bodies and enforces a bounded store", async (t) => {
	const f = await fixture(t);
	for (const bad of [
		null,
		{},
		{ trigger: "at" },
		chat({ trigger: "at", at: NaN }),
		chat({ at: 1 }),
		chat({ title: "" }),
		{ target: { kind: "message", sessionId: "existing", message: " " } },
		{ target: { kind: "chat", spawn: { projectId: "p", message: "x".repeat(16_384) } } },
	]) {
		await assert.rejects(f.service.create(bad as ScheduleRequest));
	}
	const item = await f.service.create(chat());
	for (let i = 1; i < 1000; i++) await f.store.create({ ...item, id: `limit-${i}` });
	assert.equal(f.service.list().length, 1000);
	await assert.rejects(f.service.create(chat()), /limit reached/);
	await f.service.remove(item.id);
	await f.service.remove(item.id);
	await f.service.create(chat());
	assert.equal(f.service.list().length, 1000);
});
test("aggregate prompt budget bounds snapshots, including target edits", async (t) => {
	const f = await fixture(t);
	const seed = await f.service.create(chat());
	const target = { kind: "chat" as const, spawn: { projectId: "p", message: "x".repeat(15900) } };
	const budget = 4 * 1024 * 1024;
	const small = Buffer.byteLength(JSON.stringify(seed.target));
	const big = Buffer.byteLength(JSON.stringify(target));
	const count = Math.floor((budget - small) / big);
	for (let i = 0; i < count; i++) await f.store.create({ ...seed, id: `payload-${i}`, target });
	const remaining = budget - small - count * big;
	if (remaining >= big - small) await f.store.create({ ...seed, id: "payload-small" });
	await assert.rejects(f.service.create({ target }), /payload limit/);
	await assert.rejects(f.service.update(seed.id, { target }), /payload limit/);
	assert.deepEqual(f.service.require(seed.id).target, seed.target);
	const ws = JSON.parse(await f.service.snapshot(undefined, true));
	assert.equal(ws.type, "schedules");
	assert.equal(ws.schedules.length, f.service.list().length);
});
test("refreshing a suspended detector synchronizes reachability without inventing an online edge", async (t) => {
	const f = await fixture(t);
	const online = await f.service.create(chat({ trigger: "on_online" }));
	await f.service.signal({ type: "online", online: true, initial: true });
	assert.equal(f.service.require(online.id).state, "pending");
	await f.service.signal({ type: "online", online: false });
	await f.service.signal({ type: "online", online: true });
	assert.equal(f.service.require(online.id).state, "fired");
});

test("failed claim persistence produces no session effect; failed finalization never redispatches", async (t) => {
	const f = await fixture(t);
	const first = await f.service.create(chat({ trigger: "on_wake" }));
	const replace = f.store.replace.bind(f.store);
	f.store.replace = async (old, next) => {
		if (next.state === "dispatching") throw new Error("disk full before claim");
		return replace(old, next);
	};
	await f.service.signal({ type: "sleep", at: f.clock.now() + 1 });
	await assert.rejects(f.service.signal({ type: "wake", full: true }), /disk full before claim/);
	assert.equal(f.calls.length, 0);
	assert.equal(f.service.require(first.id).state, "pending");
	f.store.replace = async (old, next) => {
		if (next.state === "fired") throw new Error("disk full after admission");
		return replace(old, next);
	};
	await assert.rejects(f.service.signal({ type: "wake", full: true }), /disk full after admission/);
	assert.equal(f.calls.length, 1);
	assert.equal(f.service.require(first.id).state, "dispatching");
	await f.service.signal({ type: "sleep", at: f.clock.now() + 1 });
	await f.service.signal({ type: "wake", full: true });
	assert.equal(f.calls.length, 1);
	await f.restart();
	assert.equal(f.service.require(first.id).state, "failed");
	assert.match(f.service.require(first.id).error!, /uncertain/);
});

for (const trigger of ["on_wake", "on_back"] as const) {
	test(`${trigger}: save awake requires a new sleep, dark wakes never count, restart asleep retains the latch`, async (t) => {
		const f = await fixture(t);
		const item = await f.service.create(chat({ trigger }));
		await f.service.signal({ type: "wake", full: true });
		await f.service.signal({ type: "sleep", at: item.updatedAt - 1 });
		await f.service.signal({ type: "wake", full: true });
		assert.equal(f.service.require(item.id).sleepObserved, undefined);
		assert.equal(f.calls.length, 0);
		f.clock.advance(100);
		await f.service.signal({ type: "sleep", at: f.clock.now() });
		assert.equal(f.service.require(item.id).sleepObserved, true);
		await f.service.signal({ type: "wake", full: false });
		assert.equal(f.service.require(item.id).wakeObserved, undefined);
		assert.equal(f.calls.length, 0);
		await f.restart(); // Relaunch while asleep, before the full wake.
		assert.equal(f.service.require(item.id).sleepObserved, true);
		await f.service.signal({ type: "wake", full: false });
		assert.equal(f.calls.length, 0);
		await f.service.signal({ type: "wake", full: true });
		if (trigger === "on_back") {
			assert.equal(f.service.require(item.id).wakeObserved, true);
			assert.equal(f.calls.length, 0);
			f.triggers.online = true;
			await f.settle();
		}
		assert.equal(f.service.require(item.id).state, "fired");
		assert.equal(f.calls.length, 1);
	});
	test(`${trigger}: every edit clears progress, and queued sleep/full-wake events survive internal CAS writes`, async (t) => {
		const f = await fixture(t);
		const item = await f.service.create(chat({ trigger }));
		f.clock.advance(100);
		await f.service.signal({ type: "sleep", at: f.clock.now() });
		f.clock.advance(100);
		await f.service.update(item.id, { title: "Edited while awake" });
		await f.service.signal({ type: "sleep", at: f.clock.now() - 100 }); // A helper reconnect's old sample.
		await f.service.signal({ type: "wake", full: true });
		assert.equal(f.calls.length, 0);
		assert.equal(f.service.require(item.id).sleepObserved, undefined);
		f.clock.advance(100);
		f.triggers.emit({ type: "sleep", at: f.clock.now() });
		f.triggers.emit({ type: "wake", full: false });
		f.triggers.emit({ type: "wake", full: true });
		await f.settle();
		if (trigger === "on_back") {
			assert.equal(f.service.require(item.id).wakeObserved, true);
			f.triggers.online = true;
			await f.settle();
		}
		assert.equal(f.calls.length, 1);
	});
}
test("a legacy kernel-wake latch is not evidence of sleep or a full wake", async (t) => {
	const f = await fixture(t, true);
	const item = await f.service.create(chat());
	await f.store.replace(item, { ...item, wakeObserved: true });
	await f.restart();
	assert.equal(f.service.require(item.id).wakeObserved, undefined);
	assert.equal(f.calls.length, 0);
});
