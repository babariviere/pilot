import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { nativePlanningFixture } from "./native-mission-planning.fixture.ts";
import { OperationJournal } from "./operation-journal.ts";
import { ScheduleControls, validateScheduleIntent } from "./schedule-controls.ts";
import { ScheduleStore } from "./schedule-store.ts";
import { ScheduleService } from "./schedules.ts";

test("native schedule create, pause, resume and cancel retain history with stale and lost ACK fences", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	const store = new ScheduleStore(join(f.home, "schedules.sqlite"));
	const service = new ScheduleService(store, {
		sessions: f.sessions,
		projects: f.projects,
		home: f.journal.destination,
		automationsEnabled: () => true,
	});
	await service.load();
	t.after(async () => {
		await service.stop();
		await store.close();
	});
	const owner = f.sessions.get(f.owner)!;
	const controls = new ScheduleControls(
		service,
		{ list: () => [owner], automationHistory: () => ({ items: [], more: false }) },
		f.projects,
		f.journal.destination,
	);
	const make = (action: string, value: unknown, binding = controls.read().binding) =>
		f.operation(
			"global-schedules",
			{ purpose: "schedule-controls", draftId: randomUUID(), page: 0, binding, action, value },
			binding,
		);
	assert.equal(controls.read().schedules.length, 0);
	const op = make("create", {
		trigger: "at",
		at: Date.now() + 60000,
		expiresAt: Date.now() + 120000,
		target: { kind: "message", sessionId: f.owner, message: "Check the agreed work" },
	});
	const receipt = await f.journal.execute(op, (op, e) => controls.admit(op, e.firstEntry));
	assert.equal(receipt.state, "accepted");
	const row = controls.read().schedules[0]!;
	assert.equal(row.target.kind, "message");
	assert.equal(
		(
			await f.journal.execute({ ...op, operationId: randomUUID(), producerId: randomUUID() }, (op, e) =>
				controls.admit(op, e.firstEntry),
			)
		).state,
		"rejected",
	);
	const reopened = new OperationJournal(join(f.home, "operations"), f.journal.destination);
	assert.deepEqual(await reopened.lookup(op), receipt);
	await assert.rejects(controls.admit(op, false), /lookup only/);
	assert.equal(controls.read().schedules.length, 1);
	for (const paused of [true, false]) {
		const current = service.require(row.id);
		const intent = make("update", { id: row.id, expectedRevision: current.revision, paused });
		assert.equal((await f.journal.execute(intent, (op, e) => controls.admit(op, e.firstEntry))).state, "accepted");
		assert.equal(!!service.require(row.id).paused, paused);
	}
	const cancel = make("cancel", { id: row.id, expectedRevision: service.require(row.id).revision });
	assert.equal((await f.journal.execute(cancel, (op, e) => controls.admit(op, e.firstEntry))).state, "accepted");
	assert.equal(service.require(row.id).state, "cancelled");
	assert.deepEqual(service.require(row.id).target, row.target);
	assert.throws(() =>
		validateScheduleIntent(
			make("create", { trigger: "at", at: 1, target: { kind: "chat", spawn: { cwd: "/" } } }),
			f.journal.destination,
		),
	);
});
test("an off-page editor and its newly selected target stay pinned across choice pages", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	const store = new ScheduleStore(join(f.home, "schedule-pages.sqlite"));
	const service = new ScheduleService(store, {
		sessions: f.sessions,
		projects: f.projects,
		home: f.journal.destination,
		automationsEnabled: () => false,
	});
	await service.load();
	t.after(async () => {
		await service.stop();
		await store.close();
	});
	const owner = f.sessions.get(f.owner)!,
		targets = Array.from({ length: 205 }, (_, i) => ({ ...owner, id: `agent-${i}`, title: `Agent ${i}` }));
	const get = f.sessions.get.bind(f.sessions);
	t.mock.method(f.sessions, "get", (id: string) => targets.find((t) => t.id === id) ?? get(id));
	const controls = new ScheduleControls(
		service,
		{ list: () => targets, automationHistory: () => ({ items: [], more: false }) },
		f.projects,
		f.journal.destination,
	);
	const row = await service.create({
		trigger: "at",
		at: Date.now() + 86400000,
		target: { kind: "message", sessionId: targets[0]!.id, message: "Check work" },
	});
	const second = controls.read(1, { editId: row.id, targetId: targets[0]!.id, projectId: row.projectId });
	assert.equal(
		second.schedules.some((r) => r.id === row.id),
		true,
	);
	assert.equal(
		second.targets.some((r) => r.id === targets[150]!.id),
		true,
	);
	const first = controls.read(0, { editId: row.id, targetId: targets[150]!.id, projectId: row.projectId });
	assert.equal(
		first.targets.some((r) => r.id === targets[150]!.id),
		true,
	);
	const value = {
		id: row.id,
		expectedRevision: row.revision,
		target: { kind: "message", sessionId: targets[150]!.id, message: "Updated check-in" },
	};
	const op = f.operation(
		"global-schedules",
		{
			purpose: "schedule-controls",
			draftId: randomUUID(),
			page: 1,
			binding: second.binding,
			action: "update",
			value,
		},
		second.binding,
	);
	const receipt = await f.journal.execute(op, (op, e) => controls.admit(op, e.firstEntry));
	assert.equal(receipt.state, "accepted", JSON.stringify(receipt));
	assert.equal(service.require(row.id).target.kind, "message");
	assert.deepEqual(service.require(row.id).target, value.target);
});
