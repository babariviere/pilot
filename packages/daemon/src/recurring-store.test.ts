import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { SchedulePatch, ScheduleRequest } from "@pilot/protocol";
import { ScheduleStore } from "./schedule-store.ts";
import { ScheduleService } from "./schedules.ts";

export async function fixture(t: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "recurring-"));
	const identity = { daemonId: "d", lineageId: "l" };
	let now = Date.parse("2026-11-02T08:00Z"),
		enabled = true;
	let store = new ScheduleStore(join(home, "schedules.sqlite"));
	const deps = {
		home: identity,
		automationsEnabled: () => enabled,
		clock: { now: () => now, setTimeout: () => () => {} },
		projects: {
			require: (id: string) => {
				if (id !== "p") throw new Error("Missing project");
				return { id, name: "P", path: home, createdAt: 0 };
			},
		},
		sessions: { get: () => ({ projectId: "p" }), spawn: async () => ({ id: "new" }), send: async () => {} },
	};
	let service = new ScheduleService(store, deps);
	await service.load();
	t.after(async () => {
		await service.stop();
		await store.close();
		await rm(home, { recursive: true, force: true });
	});
	const request: ScheduleRequest = {
		trigger: "recurring",
		recurrence: { every: "day", time: "09:00", timeZone: "UTC" },
		expectedHome: identity,
		target: { kind: "chat", spawn: { projectId: "p", message: "Check" } },
	};
	return {
		get service() {
			return service;
		},
		get store() {
			return store;
		},
		deps,
		identity,
		request,
		setNow: (n: number) => {
			now = n;
		},
		enable: (v: boolean) => {
			enabled = v;
		},
		restart: async () => {
			await service.stop();
			await store.close();
			store = new ScheduleStore(join(home, "schedules.sqlite"));
			service = new ScheduleService(store, deps);
			await service.load();
		},
	};
}
test("create/edit/resume cursors, daemon-owned fields, home and live setting checks", async (t) => {
	const f = await fixture(t);
	const created = await f.service.create(f.request);
	assert.equal(created.handledThrough, Date.parse("2026-11-02T08:00Z"));
	assert.equal(created.at, Date.parse("2026-11-02T09:00Z"));
	const patch = (p: SchedulePatch) =>
		f.service.update(created.id, {
			expectedRevision: f.service.require(created.id).revision,
			expectedHome: f.identity,
			...p,
		});
	const paused = await patch({ paused: true });
	assert.equal(paused.paused, true);
	assert.equal(f.store.pendingItems().length, 0);
	f.setNow(Date.parse("2026-11-05T10:00Z"));
	const resumed = await patch({ paused: false });
	assert.equal(resumed.handledThrough, Date.parse("2026-11-05T10:00Z"));
	assert.equal(resumed.at, Date.parse("2026-11-06T09:00Z"));
	f.setNow(Date.parse("2026-11-06T08:00Z"));
	assert.equal((await patch({ title: "Rename" })).handledThrough, resumed.handledThrough);
	assert.equal(
		(await patch({ recurrence: { every: "week", weekday: 1, time: "10:00", timeZone: "Europe/Paris" } }))
			.handledThrough,
		Date.parse("2026-11-06T08:00Z"),
	);
	for (const key of ["at", "handledThrough", "runs", "notice"])
		await assert.rejects(patch({ [key]: 123 } as SchedulePatch), /daemon-owned/);
	await assert.rejects(patch({ expectedHome: { ...f.identity, daemonId: "elsewhere" } }), /home changed/);
	await assert.rejects(f.service.create({ ...f.request, expectedHome: undefined }), /expectedHome/);
	f.enable(false);
	await assert.rejects(f.service.create(f.request), /disabled/);
	await assert.rejects(patch({ title: "No" }), /disabled/);
});
test("recurring targets are project-bound, without mission, cwd or tickets", async (t) => {
	const f = await fixture(t);
	for (const spawn of [
		{ cwd: "/tmp", message: "x" },
		{ projectId: "p", missionId: "m", message: "x" },
		{ projectId: "p", cwd: "/tmp", message: "x" },
	])
		await assert.rejects(f.service.create({ ...f.request, target: { kind: "chat", spawn } }));
	await assert.rejects(
		f.service.create({
			...f.request,
			target: { kind: "chat", spawn: { projectId: "p", message: "x" }, trackedItemId: "ticket" },
		}),
	);
});
test("interrupted recurring claims become failures without replay; next deadline is recomputed", async (t) => {
	const f = await fixture(t),
		row = await f.service.create(f.request);
	const due = row.at!;
	await f.store.replace(row, { ...row, state: "dispatching", handledThrough: due, at: 0 });
	f.setNow(due + 1000);
	await f.restart();
	const repaired = f.service.require(row.id);
	assert.equal(repaired.state, "pending");
	assert.equal(repaired.handledThrough, due);
	assert.equal(repaired.at, due + 86400000);
	assert.equal(repaired.notice?.outcome, "failed");
	assert.match(repaired.notice!.error!, /uncertain/);
	await f.restart();
	assert.equal(f.service.require(row.id).runs?.length, 1);
});
test("active recurring limit is enforced atomically, including resume", async (t) => {
	const f = await fixture(t);
	const results = await Promise.allSettled(Array.from({ length: 51 }, () => f.service.create(f.request)));
	assert.equal(results.filter((r) => r.status === "fulfilled").length, 50);
	const row = f.service.list()[0];
	await f.service.update(row.id, { paused: true, expectedHome: f.identity, expectedRevision: row.revision });
	await f.service.create(f.request);
	await assert.rejects(
		f.service.update(row.id, { paused: false, expectedHome: f.identity, expectedRevision: row.revision + 1 }),
		/limit/,
	);
});

test("notice dismissal preserves cursor, runs and next deadline, including missing projects", async (t) => {
	const f = await fixture(t);
	const created = await f.service.create(f.request);
	const run = { due: created.at!, at: created.at! + 600000, outcome: "failed" as const, error: "Project removed" };
	const old = await f.store.replace(created, { ...created, runs: [run], notice: run, paused: true });
	for (const dismissNotice of [false, null, "true"]) {
		await assert.rejects(
			f.service.update(old.id, {
				dismissNotice,
				expectedHome: f.identity,
				expectedRevision: old.revision,
			} as unknown as SchedulePatch),
		);
	}
	f.deps.projects.require = () => {
		throw new Error("Project removed");
	};
	const dismissed = await f.service.update(old.id, {
		dismissNotice: true,
		expectedHome: f.identity,
		expectedRevision: old.revision,
	});
	assert.equal(dismissed.notice, undefined);
	assert.deepEqual(dismissed.runs, [run]);
	assert.equal(dismissed.handledThrough, old.handledThrough);
	assert.equal(dismissed.at, old.at);
	assert.equal(dismissed.paused, true);
	await assert.rejects(
		f.service.update(old.id, { dismissNotice: true, expectedHome: f.identity, expectedRevision: old.revision }),
		/changed/,
	);
	await f.restart();
	assert.equal(f.service.require(old.id).notice, undefined);
	assert.deepEqual(f.service.require(old.id).runs, [run]);
});

test("dashboard projections detach notices and never expose prompts; recurring replies do not hide chat attention", async (t) => {
	const f = await fixture(t);
	const row = await f.service.create({
		...f.request,
		title: "Check project",
		target: { kind: "message", sessionId: "target", message: "Private prompt" },
	});
	assert.equal(f.service.scheduledMessageSessions().size, 0);
	const run = {
		due: row.at!,
		at: row.at! + 600000,
		outcome: "sent" as const,
		late: true as const,
		sessionId: "target",
	};
	const noted = await f.store.replace(row, { ...row, notice: run, runs: [run] });
	const projection = f.service.dashboard("p")[0];
	assert.equal(JSON.stringify(projection).includes("Private prompt"), false);
	projection.notice!.sessionId = "mutated";
	projection.recurrence!.time = "01:00";
	assert.equal(f.service.require(row.id).notice?.sessionId, "target");
	assert.equal(f.service.require(row.id).recurrence?.time, "09:00");
	await f.store.replace(noted, { ...noted, state: "dispatching" });
	assert.equal(f.service.dashboard("p")[0].notice?.outcome, "sent", "old notice stays visible during the next claim");
});
