import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type TestContext, test } from "node:test";
import type { MissionReportWrite } from "@pilot/protocol";
import { MissionReports } from "./mission-reports.ts";
import { MissionStore } from "./missions.ts";

function fixture(t: TestContext) {
	const store = new MissionStore(":memory:");
	t.after(() => store.close());
	const mission = store.create({ projectId: "p", title: "Synthetic", planningVersion: 1 });
	store.join("worker", mission.id);
	const task = store.addTask(mission.id, { title: "Work", sessionId: "worker" });
	const reports = new MissionReports(store);
	const write = (): MissionReportWrite => {
		const source = reports.source(mission.id, "worker", task.id);
		return {
			version: 1,
			reportId: randomUUID(),
			taskId: task.id,
			source: source.source,
			expectedPreviousId: source.expectedPreviousId,
			movement: "moving",
			summary: "Agent assessment",
			nextStep: "Verify the change",
			evidence: ["test output"],
		};
	};
	return { store, mission, task, reports, write };
}

test("reports preserve exact bytes and identity, not task status or accepted progress", async (t) => {
	const f = fixture(t),
		write = f.write();
	write.summary = "  exact 🦉\nbytes  ";
	const report = await f.reports.write(f.mission.id, "worker", write);
	assert.deepEqual(report.write, write);
	assert.equal(f.store.task(f.mission.id, f.task.id).status, "todo");
	assert.equal((await f.reports.views(f.mission.id))[0]!.currentness, "current");
	assert.equal((await f.reports.views(f.mission.id))[0]!.provenance, "agent_report");
	assert.deepEqual(await f.reports.write(f.mission.id, "worker", write), report);
	await assert.rejects(f.reports.write(f.mission.id, "worker", { ...write, summary: "changed" }), /identity/);
	assert.equal((await f.reports.views(f.mission.id, report.validUntil))[0]!.currentness, "stale");
});

for (const kind of ["definition", "assignment", "owner", "coordinator", "context", "pause"] as const)
	test(`report source rejects stale ${kind}`, async (t) => {
		const f = fixture(t),
			write = f.write();
		await f.reports.write(f.mission.id, "worker", write);
		if (kind === "definition") f.store.updateTask(f.mission.id, f.task.id, { title: "Changed" });
		if (kind === "assignment")
			f.store.updateTask(f.mission.id, f.task.id, {
				assignment: {
					version: 1,
					expectedRevision: 0,
					intent: "New intent",
					scope: "New scope",
					criteria: ["Pass"],
				},
			});
		if (kind === "owner") {
			f.store.join("other", f.mission.id);
			f.store.updateTask(f.mission.id, f.task.id, { sessionId: "other" });
		}
		if (kind === "coordinator") {
			f.store.join("lead", f.mission.id);
			f.store.update(f.mission.id, { coordinatorSessionId: "lead" });
		}
		if (kind === "context") f.store.writeBrief(f.mission.id, "Changed", 0);
		if (kind === "pause") f.store.controls.stop(f.mission.id);
		assert.equal((await f.reports.views(f.mission.id))[0]!.currentness, "stale");
		await assert.rejects(
			f.reports.write(f.mission.id, "worker", { ...write, reportId: randomUUID() }),
			/changed|owner/,
		);
	});

test("source rechecks after durability and concurrent predecessors have one winner", async (t) => {
	const f = fixture(t),
		write = f.write();
	const original = f.store.durable.bind(f.store);
	let once = true;
	t.mock.method(f.store, "durable", async () => {
		await original();
		if (once) {
			once = false;
			f.store.updateTask(f.mission.id, f.task.id, { title: "Edited during I/O" });
		}
	});
	await assert.rejects(f.reports.write(f.mission.id, "worker", write), /changed/);
	const next = f.write();
	const result = await Promise.allSettled([
		f.reports.write(f.mission.id, "worker", next),
		f.reports.write(f.mission.id, "worker", { ...next, reportId: randomUUID() }),
	]);
	assert.equal(result.filter((item) => item.status === "fulfilled").length, 1);
	assert.equal(f.reports.latest(f.mission.id).length, 1);
});

test("unowned reports and unknown versions cannot create inferred progress", async (t) => {
	const f = fixture(t);
	await assert.rejects(f.reports.write(f.mission.id, "intruder", f.write()), /owner/);
	await assert.rejects(f.reports.write(f.mission.id, "worker", { ...f.write(), version: 2 }), /Invalid/);
	assert.deepEqual(await f.reports.views(f.mission.id), []);
	const before = f.write();
	f.store.log(f.mission.id, { text: "Activity is not progress" });
	await f.reports.write(f.mission.id, "worker", before);
	assert.equal((await f.reports.views(f.mission.id))[0]!.currentness, "current");
});

test("complete 400-report reads batch source fences, not per-report task projections", async (t) => {
	const f = fixture(t),
		tasks = [f.task];
	for (let i = 1; i < 400; i++)
		tasks.push(f.store.addTask(f.mission.id, { title: `Synthetic ${i}`, sessionId: "worker" }));
	for (const task of tasks) {
		const source = f.reports.source(f.mission.id, "worker", task.id);
		await f.reports.write(f.mission.id, "worker", {
			...f.write(),
			reportId: randomUUID(),
			taskId: task.id,
			source: source.source,
			expectedPreviousId: null,
		});
	}
	t.mock.method(f.store, "task", () => {
		throw new Error("per-row task projection");
	});
	t.mock.method(f.store, "activity", () => {
		throw new Error("per-row activity projection");
	});
	const started = performance.now(),
		views = await f.reports.views(f.mission.id);
	t.diagnostic(`400 reports: ${(performance.now() - started).toFixed(1)} ms`);
	assert.equal(views.length, 400);
	assert.equal(
		views.every((view) => view.currentness === "current"),
		true,
	);
});
