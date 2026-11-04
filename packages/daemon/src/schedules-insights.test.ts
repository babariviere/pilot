import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { InsightsReviewDispatch, InsightsReviewRun, InsightsStatus, ScheduleRequest } from "@pilot/protocol";
import { ScheduleStore } from "./schedule-store.ts";
import { ScheduleService } from "./schedules.ts";

const ms = Date.parse;
async function fixture(t: TestContext) {
	const dir = await mkdtemp(join(tmpdir(), "schedule-insights-"));
	const file = join(dir, "schedules.sqlite");
	const id = randomUUID();
	const home = { daemonId: "d", lineageId: "l" };
	let now = ms("2026-11-02T08:00Z"),
		working = false,
		enabled = true,
		paused = false,
		online = true;
	let fail = false,
		statusFailure = false,
		missing = false;
	const status: InsightsStatus = {
		sessionId: id,
		enabled: true,
		revision: 1,
		projectId: "p",
		missionId: "m",
		setupPending: false,
		archived: false,
		available: true,
		disclosure: "insights-history-v1",
	};
	const calls: InsightsReviewDispatch[] = [],
		lookups: string[] = [];
	const runs = new Map<string, InsightsReviewRun>();
	const listeners = new Set<() => void>();
	let messages = 0;
	const deps = {
		home,
		clock: { now: () => now, setTimeout: () => () => {} },
		automationsEnabled: () => enabled,
		paused: () => paused,
		projects: { require: (projectId: string) => ({ id: projectId, name: "P", path: dir, createdAt: 0 }) },
		triggers: { online: true, refreshOnline: async () => online, subscribe: () => () => {} },
		sessions: {
			get: () => ({ projectId: "p", working }),
			spawn: async () => {
				throw new Error("No spawn");
			},
			send: async () => {
				messages++;
			},
			insightsStatus: (): InsightsStatus | undefined => status,
			onInsightsReviewChange: (listener: () => void) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
			dispatchInsightsReview: async (sessionId: string, request: InsightsReviewDispatch) => {
				assert.equal(sessionId, id);
				calls.push(structuredClone(request));
				assert.equal(store.require(rowId).state, "dispatching");
				assert.deepEqual(store.require(rowId).insightsReview, { sessionId: id, request });
				assert.equal(status.available, true);
				const run: InsightsReviewRun = { ...request, state: "sent", reportKey: null, detail: "Input placed only" };
				runs.set(request.runId, run);
				working = true;
				if (fail) throw new Error("Lost ACK");
				return run;
			},
			insightsReviewStatus: async (sessionId: string, runId: string) => {
				assert.equal(sessionId, id);
				lookups.push(runId);
				if (statusFailure || !status.available) throw new Error("Unavailable");
				return missing ? null : (runs.get(runId) ?? null);
			},
		},
	};
	let rowId = "";
	let store = new ScheduleStore(file),
		service = new ScheduleService(store, deps);
	await service.load();
	const request: ScheduleRequest = {
		title: "Weekly review",
		trigger: "recurring",
		expectedHome: home,
		recurrence: { every: "week", weekday: 1, time: "09:00", timeZone: "UTC" },
		target: { kind: "message", sessionId: id, message: "Review the week" },
	};
	const row = await service.create(request);
	rowId = row.id;
	service.start();
	const settle = () => service.signal({ type: "online", online });
	await settle();
	t.after(async () => {
		await service.stop();
		await store.close();
		await rm(dir, { recursive: true, force: true });
	});
	return {
		id,
		row,
		home,
		request,
		calls,
		lookups,
		status,
		runs,
		deps,
		get service() {
			return service;
		},
		get store() {
			return store;
		},
		get messages() {
			return messages;
		},
		settle,
		due: async (date = "2026-11-02T09:00Z") => {
			now = ms(date);
			await settle();
		},
		working: (value: boolean) => {
			working = value;
		},
		enable: (value: boolean) => {
			enabled = value;
		},
		pause: (value: boolean) => {
			paused = value;
		},
		online: (value: boolean) => {
			online = value;
		},
		fail: () => {
			fail = true;
		},
		statusFailure: () => {
			statusFailure = true;
		},
		missing: () => {
			missing = true;
		},
		change: async (state: InsightsReviewRun["state"]) => {
			const run = runs.get(calls.at(-1)!.runId)!;
			run.state = state;
			if (state === "partial") run.reportKey = run.runId;
			working = false;
			for (const listener of listeners) listener();
			await settle();
		},
		restart: async () => {
			await service.stop();
			await store.close();
			store = new ScheduleStore(file);
			service = new ScheduleService(store, deps);
			await service.load();
			service.start();
			await settle();
		},
	};
}

test("weekly fixed-chat dispatch reserves exact identity durably and never uses generic send", async (t) => {
	const f = await fixture(t);
	await f.due();
	assert.equal(f.calls.length, 1);
	const request = f.calls[0];
	assert.equal(request.windowStart, "2026-10-26T09:00:00.000Z");
	assert.equal(request.windowEnd, "2026-11-02T09:00:00.000Z");
	assert.deepEqual(request.bounds, { inventoryPages: 1, historyPages: 2, entriesPerPage: 4 });
	assert.equal(f.messages, 0);
	assert.deepEqual(f.service.require(f.row.id).runs?.[0].insightsReview, { runId: request.runId, state: "sent" });
	await f.change("partial");
	assert.equal(f.service.require(f.row.id).runs?.[0].insightsReview?.state, "partial");
	await f.restart();
	assert.equal(f.calls.length, 1);
	assert.equal(f.messages, 0);
});

for (const terminal of ["cancelled", "interrupted", "unknown"] as const) {
	test(`durable ${terminal} becomes a failure notice even while dispatch is disabled and paused`, async (t) => {
		const f = await fixture(t);
		await f.due();
		f.enable(false);
		f.pause(true);
		f.online(false);
		await f.change(terminal);
		const saved = f.service.require(f.row.id);
		assert.equal(saved.notice?.outcome, "failed");
		assert.equal(saved.notice?.insightsReview?.state, terminal);
		assert.match(saved.notice!.error!, /never replay/);
		await f.restart();
		assert.equal(f.calls.length, 1);
		assert.equal(f.messages, 0);
	});
}

test("reload consumes an interrupted occurrence using passive exact-run lookup, never resend", async (t) => {
	const f = await fixture(t);
	const replace = f.store.replace.bind(f.store);
	f.store.replace = async (old, next) => {
		if (next.state === "pending") throw new Error("Disk full");
		return replace(old, next);
	};
	await assert.rejects(f.due(), /Disk full/);
	const request = f.calls[0];
	assert.equal(f.store.require(f.row.id).insightsReview?.request.runId, request.runId);
	f.runs.get(request.runId)!.state = "interrupted"; // The durable review store's startup recovery.
	await f.restart();
	const saved = f.service.require(f.row.id);
	assert.equal(saved.state, "pending");
	assert.equal(saved.notice?.insightsReview?.runId, request.runId);
	assert.equal(saved.notice?.insightsReview?.state, "interrupted");
	assert.equal(saved.notice?.outcome, "failed");
	assert.ok(f.lookups.includes(request.runId));
	assert.equal(f.calls.length, 1);
});

test("restart resolves a lost schedule finalization to bounded persistence, not completed review", async (t) => {
	const f = await fixture(t);
	const replace = f.store.replace.bind(f.store);
	f.store.replace = async (old, next) => {
		if (next.state === "pending") throw new Error("Disk full");
		return replace(old, next);
	};
	await assert.rejects(f.due(), /Disk full/);
	f.runs.get(f.calls[0].runId)!.state = "partial";
	await f.restart();
	assert.equal(f.service.require(f.row.id).runs?.[0].insightsReview?.state, "partial");
	assert.equal(f.service.require(f.row.id).runs?.[0].outcome, "sent");
	assert.equal(f.calls.length, 1);
});

for (const lookup of ["sent", "absent", "unavailable"] as const) {
	test(`lost dispatch ACK with ${lookup} lookup never replays the occurrence`, async (t) => {
		const f = await fixture(t);
		f.fail();
		if (lookup === "absent") f.missing();
		if (lookup === "unavailable") f.statusFailure();
		await f.due();
		const run = f.service.require(f.row.id).runs![0];
		assert.equal(run.outcome, lookup === "sent" ? "sent" : "failed");
		assert.equal(run.insightsReview?.state, lookup === "sent" ? "sent" : "unresolved");
		await f.restart();
		await f.settle();
		assert.equal(f.calls.length, 1);
		assert.equal(f.messages, 0);
	});
}

test("unavailable Insights destination fails closed and cannot downgrade to ordinary message authority", async (t) => {
	const f = await fixture(t);
	f.status.available = false;
	f.status.enabled = false;
	await f.due();
	assert.equal(f.service.require(f.row.id).notice?.outcome, "failed");
	assert.equal(f.calls.length, 0);
	assert.equal(f.messages, 0);
	await f.restart();
	assert.equal(f.calls.length, 0);
});

for (const change of ["role", "mission", "project"] as const) {
	test(`recorded Insights ${change} binding cannot silently downgrade or retarget after restart`, async (t) => {
		const f = await fixture(t);
		if (change === "role") t.mock.method(f.deps.sessions, "insightsStatus", () => undefined);
		else if (change === "mission") f.status.missionId = "other";
		else f.status.projectId = "other";
		await f.service.update(f.row.id, {
			title: "Renamed",
			expectedHome: f.home,
			expectedRevision: f.service.require(f.row.id).revision,
		});
		await f.restart();
		await f.due();
		assert.equal(f.service.require(f.row.id).notice?.outcome, "failed");
		assert.equal(f.calls.length, 0);
		assert.equal(f.messages, 0);
	});
}

test("disable during claim consumes its identity without review admission or message fallback", async (t) => {
	const f = await fixture(t);
	const replace = f.store.replace.bind(f.store);
	f.store.replace = async (old, next) => {
		const saved = await replace(old, next);
		if (next.state === "dispatching") f.enable(false);
		return saved;
	};
	await f.due();
	const run = f.service.require(f.row.id).runs![0];
	assert.equal(run.outcome, "failed");
	assert.ok(run.insightsReview?.runId);
	f.enable(true);
	await f.restart();
	assert.equal(f.calls.length, 0);
	assert.equal(f.messages, 0);
});

test("idle without a report is unresolved, not completed, and later bounded persistence can resolve it", async (t) => {
	const f = await fixture(t);
	await f.due();
	f.working(false);
	await f.settle();
	assert.equal(f.service.require(f.row.id).notice?.outcome, "failed");
	assert.match(f.service.require(f.row.id).notice!.error!, /no bounded report persisted/);
	await f.change("partial");
	assert.equal(f.service.require(f.row.id).notice, undefined);
	assert.equal(f.service.require(f.row.id).runs![0].insightsReview?.state, "partial");
});

test("coalesced weeks produce one bounded review with count and late visibility, not coverage claims", async (t) => {
	const f = await fixture(t);
	await f.due("2026-11-16T14:00Z");
	assert.equal(f.calls.length, 1);
	assert.equal(f.service.require(f.row.id).notice?.count, 3);
	assert.equal(f.service.require(f.row.id).notice?.late, true);
	assert.equal(f.calls[0].windowStart, "2026-11-09T09:00:00.000Z");
});

test("busy review skips; pause/resume skips paused time; late and missed occurrences remain visible", async (t) => {
	const f = await fixture(t);
	f.working(true);
	await f.due();
	assert.equal(f.service.require(f.row.id).notice?.outcome, "skipped_running");
	assert.equal(f.calls.length, 0);
	f.working(false);
	await f.service.update(f.row.id, {
		paused: true,
		expectedHome: f.home,
		expectedRevision: f.service.require(f.row.id).revision,
	});
	await f.due("2026-11-09T09:00Z");
	assert.equal(f.calls.length, 0);
	await f.service.update(f.row.id, {
		paused: false,
		expectedHome: f.home,
		expectedRevision: f.service.require(f.row.id).revision,
	});
	await f.settle();
	assert.equal(f.calls.length, 0);
	await f.due("2026-11-16T14:00Z");
	assert.equal(f.service.require(f.row.id).notice?.late, true);
	assert.equal(f.calls.length, 1);
	await f.change("partial");
	await f.due("2026-11-30T08:00Z"); // Prior weekly period ended, next occurrence is not yet due.
	assert.equal(f.service.require(f.row.id).notice?.outcome, "missed");
	assert.equal(f.calls.length, 1);
});

test("caller-supplied review identity is rejected and dismissed failures do not resurrect", async (t) => {
	const f = await fixture(t);
	await assert.rejects(f.service.create({ ...f.request, insightsReview: {} } as ScheduleRequest), /daemon-owned/);
	await f.due();
	await f.change("cancelled");
	await f.service.update(f.row.id, {
		dismissNotice: true,
		expectedHome: f.home,
		expectedRevision: f.service.require(f.row.id).revision,
	});
	await f.restart();
	assert.equal(f.service.require(f.row.id).notice, undefined);
});
