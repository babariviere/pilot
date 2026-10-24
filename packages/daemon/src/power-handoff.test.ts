import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSummary } from "@pilot/protocol";
import { MissionNotices } from "./mission-notices.ts";
import { MissionStore } from "./missions.ts";
import { NOTICE_DEBOUNCE_MS } from "./notice-dispatcher.ts";
import { POWER_IDLE_GRACE_MS, PowerService, type PowerSessions } from "./power.ts";
import type { PowerCommand } from "./power-helper.ts";
import type { SessionManager } from "./sessions.ts";

test("mission completion debounce and coordinator admission stay awake across the last child's finish", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
	const home = await mkdtemp(join(tmpdir(), "pilot-power-handoff-"));
	const store = new MissionStore(":memory:");
	const mission = store.create({ projectId: "project", title: "Handoff" });
	for (const id of ["lead", "child"]) store.join(id, mission.id);
	store.update(mission.id, { coordinatorSessionId: "lead" });
	const rows = new Map<string, SessionSummary>();
	for (const id of ["lead", "child"])
		rows.set(id, {
			id,
			title: id,
			state: id === "child" ? "working" : "idle",
			working: id === "child",
			missionId: mission.id,
			cwd: "/tmp",
			createdAt: 0,
			updatedAt: 0,
		});
	const listeners = new Set<(session: SessionSummary) => void>();
	function change(id: string, patch: Partial<SessionSummary>) {
		const value = { ...rows.get(id)!, ...patch };
		rows.set(id, value);
		for (const listener of listeners) listener(value);
	}
	let admit!: () => void;
	const admission = new Promise<void>((resolve) => {
		admit = resolve;
	});
	let received!: () => void;
	const receipt = new Promise<void>((resolve) => {
		received = resolve;
	});
	let started!: () => void;
	const startup = new Promise<void>((resolve) => {
		started = resolve;
	});
	let deliveries = 0;
	const sessions: PowerSessions = {
		powerPause: undefined,
		sleepPrepared: Promise.resolve(),
		list: () => [...rows.values()],
		onChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async pauseForSleep() {
			assert.fail("the handoff must not pause");
		},
		async resumeAfterSleep() {},
	};
	const notices = new MissionNotices(store, {
		...sessions,
		get: (id: string) => rows.get(id),
		canSendNotice: () => true,
		sendNotice: async (id: string, _content: string, requestId: string) => {
			assert.equal(id, "lead");
			assert.equal(notices.allowed(id, requestId), true);
			deliveries++;
			received();
			await admission;
			change(id, { state: "starting", working: true });
			started();
			return true;
		},
	} as unknown as SessionManager);
	const commands: PowerCommand[] = [];
	const power = new PowerService(home, sessions, async (sample) => {
		sample({
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
		});
		return {
			async request(command) {
				commands.push(command);
			},
			async close() {},
		};
	});
	try {
		await power.start();
		await power.settled();
		notices.start();
		change("child", { state: "idle", working: false, outcome: "done", outcomeAt: Date.now() });
		await power.settled();
		t.mock.timers.tick(NOTICE_DEBOUNCE_MS - 1);
		assert.equal(deliveries, 0);
		assert.equal(power.status().keepingAwake, true);
		t.mock.timers.tick(1);
		await receipt;
		assert.equal(power.status().keepingAwake, true, "notice delivery still has an awake Mac");
		t.mock.timers.tick(10_000);
		admit();
		await startup;
		await power.settled();
		t.mock.timers.tick(POWER_IDLE_GRACE_MS);
		await power.settled();
		assert.equal(deliveries, 1);
		assert.deepEqual(commands, [{ action: "activity", awake: true, closedLid: false }]);
		change("lead", { state: "idle", working: false });
		await power.settled();
		t.mock.timers.tick(POWER_IDLE_GRACE_MS);
		await power.settled();
		assert.deepEqual(commands.at(-1), { action: "activity", awake: false, closedLid: false });
	} finally {
		admit();
		await notices.stop();
		await power.stop();
		store.close();
		await rm(home, { recursive: true, force: true });
	}
});
