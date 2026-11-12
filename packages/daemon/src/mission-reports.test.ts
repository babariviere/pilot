import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { MissionReportWrite } from "@pilot/protocol";
import { MissionNotices } from "./mission-notices.ts";
import { MissionReports } from "./mission-reports.ts";
import { MissionStore } from "./missions.ts";
import type { SessionManager } from "./sessions.ts";

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

test("delivery facts stay scoped and exact retries after concurrent barriers create one notice", async (t) => {
	const f = fixture(t);
	f.store.join("lead", f.mission.id);
	f.store.update(f.mission.id, { coordinatorSessionId: "lead" });
	const write = {
		...f.write(),
		delivery: { commit: "a".repeat(40), checks: "  tests passed\n", issues: "One unverified case" },
	};
	const [first, retry] = await Promise.all([
		f.reports.write(f.mission.id, "worker", write),
		f.reports.write(f.mission.id, "worker", write),
	]);
	assert.deepEqual(first, retry);
	assert.deepEqual(first.write.delivery, write.delivery);
	assert.equal(f.store.task(f.mission.id, f.task.id).status, "todo");
	assert.equal(f.store.completion(f.mission.id, f.task.id), undefined);
	assert.equal(f.store.retiredMember("worker"), false);
	assert.equal((await f.reports.views(f.mission.id))[0]!.currentness, "current");
	const events = f.store.activity(f.mission.id, { taskId: f.task.id, kind: "update", limit: 100 });
	assert.equal(events.length, 1);
	assert.match(events[0]!.text, new RegExp(write.reportId));
	const notice = f.store.prepareNotice(f.mission.id, "lead", Date.now())!;
	assert.ok(notice);
	assert.match(JSON.stringify(notice), new RegExp(write.reportId));
	await f.reports.write(f.mission.id, "worker", write);
	assert.deepEqual(f.store.prepareNotice(f.mission.id, "lead", Date.now()), notice);
});

test("report and frozen delivery notice survive reopen and lost ACK without re-entry", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "pilot-report-notice-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const path = join(home, "missions.sqlite");
	const store = new MissionStore(path);
	let closed = false;
	t.after(() => {
		if (!closed) store.close();
	});
	const { id } = store.create({ projectId: "p", title: "Delivery" });
	store.join("lead", id);
	store.join("worker", id);
	store.update(id, { coordinatorSessionId: "lead" });
	const task = store.addTask(id, { title: "Scoped work", sessionId: "worker" });
	const reports = new MissionReports(store);
	const source = reports.source(id, "worker", task.id);
	const write: MissionReportWrite = {
		version: 1,
		taskId: task.id,
		reportId: randomUUID(),
		source: source.source,
		expectedPreviousId: null,
		movement: "not_moving",
		summary: "Shipped one slice; remaining scope blocked",
		nextStep: "Coordinator reconciles remaining scope",
		evidence: ["Focused checks"],
		delivery: { commit: "b".repeat(40), checks: "Passed", issues: "Remaining scope" },
	};
	const receipt = await reports.write(id, "worker", write);
	const notice = store.prepareNotice(id, "lead", Date.now())!;
	assert.ok(notice);
	await store.durable();
	store.close();
	closed = true;
	const reopened = new MissionStore(path);
	t.after(() => reopened.close());
	const recovered = new MissionReports(reopened);
	assert.deepEqual(await recovered.write(id, "worker", write), receipt);
	assert.deepEqual(reopened.prepareNotice(id, "lead", Date.now()), notice);
	reopened.acknowledgeNotice(notice, Date.now());
	assert.equal(reopened.prepareNotice(id, "lead", Date.now()), undefined);
	assert.deepEqual(await recovered.write(id, "worker", write), receipt);
	assert.equal(reopened.prepareNotice(id, "lead", Date.now()), undefined);
	assert.equal(reopened.task(id, task.id).status, "todo");
	assert.equal(reopened.completion(id, task.id), undefined);
});

test("later progress cannot hide scoped delivery notifications or erase their receipts", async (t) => {
	const f = fixture(t);
	f.store.join("lead", f.mission.id);
	f.store.update(f.mission.id, { coordinatorSessionId: "lead" });
	const first = { ...f.write(), delivery: { commit: "a".repeat(40), checks: "First slice", issues: "More scope" } };
	await f.reports.write(f.mission.id, "worker", first);
	const second = { ...f.write(), delivery: { commit: "b".repeat(40), checks: "Second slice", issues: "More scope" } };
	await f.reports.write(f.mission.id, "worker", second);
	await f.reports.write(f.mission.id, "worker", f.write());
	const notice = f.store.prepareNotice(f.mission.id, "lead", Date.now())!;
	assert.ok(notice);
	assert.match(notice.content, new RegExp(first.reportId));
	assert.match(notice.content, new RegExp(second.reportId));
	assert.deepEqual(f.store.controls.report(first.reportId)?.write, first);
	assert.deepEqual(f.store.controls.report(second.reportId)?.write, second);
});

for (const kind of [
	"definition",
	"assignment",
	"owner",
	"owner-aba",
	"assignment-aba",
	"closed",
	"coordinator",
	"context",
	"pause",
] as const)
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
		if (kind === "owner-aba") {
			f.store.join("other", f.mission.id);
			f.store.updateTask(f.mission.id, f.task.id, { sessionId: "other" });
			f.store.updateTask(f.mission.id, f.task.id, { sessionId: "worker" });
		}
		if (kind === "assignment-aba") {
			const assignment = { version: 1 as const, intent: "Same intent", scope: "Same scope", criteria: ["Pass"] };
			f.store.updateTask(f.mission.id, f.task.id, { assignment: { ...assignment, expectedRevision: 0 } });
			f.store.updateTask(f.mission.id, f.task.id, { assignment: { ...assignment, expectedRevision: 1 } });
		}
		if (kind === "closed") f.store.updateTask(f.mission.id, f.task.id, { status: "done" });
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
		// Exact historical retries are lookup-only even if their source is no longer current.
		const events = f.store.events(f.mission.id).length;
		assert.deepEqual((await f.reports.write(f.mission.id, "worker", write)).write, write);
		assert.equal(f.store.events(f.mission.id).length, events);
	});

test("delivery validation cannot smuggle task status or acceptance into facts", async (t) => {
	const f = fixture(t);
	for (const delivery of [
		null,
		{},
		{ commit: "bad", checks: "Pass", issues: "" },
		{ commit: "a".repeat(40), checks: "Pass", issues: "", status: "done" },
		{ commit: "a".repeat(40), checks: "", issues: "" },
	])
		await assert.rejects(f.reports.write(f.mission.id, "worker", { ...f.write(), delivery }), /delivery/);
	assert.equal(f.store.task(f.mission.id, f.task.id).status, "todo");
	assert.deepEqual(f.reports.latest(f.mission.id), []);
});

test("legacy reports saved after task closure remain historical, never current", async (t) => {
	const f = fixture(t);
	f.store.updateTask(f.mission.id, f.task.id, { status: "done" });
	// The older reporter permitted a source on a closed task. Seed that retained format without changing its fence.
	const task = f.store.task.bind(f.store);
	const mock = t.mock.method(f.store, "task", (...args: Parameters<typeof task>) => ({
		...task(...args),
		status: "todo" as const,
	}));
	await f.reports.write(f.mission.id, "worker", f.write());
	mock.mock.restore();
	assert.equal(f.reports.viewTaskNow(f.mission.id, f.task.id)?.currentness, "stale");
	assert.equal((await f.reports.views(f.mission.id))[0]!.currentness, "stale");
});

test("post-commit durability failure recovers one report and notification", async (t) => {
	const f = fixture(t);
	f.store.join("lead", f.mission.id);
	f.store.update(f.mission.id, { coordinatorSessionId: "lead" });
	const write = f.write();
	const durable = f.store.durable.bind(f.store);
	let barriers = 0;
	t.mock.method(f.store, "durable", async () => {
		if (++barriers === 2) throw new Error("Simulated lost durable ACK");
		await durable();
	});
	await assert.rejects(f.reports.write(f.mission.id, "worker", write), /lost durable ACK/);
	assert.equal(f.store.activity(f.mission.id, { kind: "update", taskId: f.task.id, limit: 100 }).length, 1);
	const recovered = await f.reports.write(f.mission.id, "worker", write);
	assert.deepEqual(recovered.write, write);
	assert.equal(f.store.activity(f.mission.id, { kind: "update", taskId: f.task.id, limit: 100 }).length, 1);
});

test("failed notice insertion rolls back the report in the same transaction", async (t) => {
	const f = fixture(t);
	const write = f.write();
	// biome-ignore lint/complexity/useLiteralKeys: Inject a SQLite failure in the private event transaction.
	const db = f.store["db"];
	db.exec(
		"CREATE TRIGGER fail_report_notice BEFORE INSERT ON events WHEN NEW.kind='update' BEGIN SELECT RAISE(ABORT,'notice insert failed'); END",
	);
	await assert.rejects(f.reports.write(f.mission.id, "worker", write), /notice insert failed/);
	assert.equal(f.store.controls.report(write.reportId), undefined);
	assert.equal(f.store.activity(f.mission.id, { taskId: f.task.id, kind: "update", limit: 100 }).length, 0);
	db.exec("DROP TRIGGER fail_report_notice");
	assert.deepEqual((await f.reports.write(f.mission.id, "worker", write)).write, write);
});

test("report notices use the existing dispatcher and exact input identity after lost placement ACK", async (t) => {
	const f = fixture(t);
	f.store.join("lead", f.mission.id);
	f.store.update(f.mission.id, { coordinatorSessionId: "lead" });
	const placed = new Map<string, string>();
	const attempts: string[] = [];
	let acknowledge = false;
	const sessions = {
		list: () => [],
		get: (id: string) => ({ id, state: id === "worker" ? "working" : "idle", missionId: f.mission.id }),
		onChange: () => () => {},
		canSendNotice: () => true,
		sendNotice: async (_id: string, content: string, requestId: string) => {
			attempts.push(requestId);
			if (placed.has(requestId)) assert.equal(placed.get(requestId), content);
			placed.set(requestId, content);
			return acknowledge;
		},
	} as unknown as SessionManager;
	const notices = new MissionNotices(f.store, sessions);
	t.after(() => notices.stop());
	notices.start();
	const write = { ...f.write(), delivery: { commit: "d".repeat(40), checks: "Passed", issues: "" } };
	await f.reports.write(f.mission.id, "worker", write);
	await notices.flush();
	assert.equal(placed.size, 1, "delivery wakes coordinator even while another worker is busy");
	assert.match([...placed.values()][0]!, new RegExp(write.reportId));
	acknowledge = true;
	await notices.flush();
	assert.equal(attempts.length, 2);
	assert.equal(new Set(attempts).size, 1);
	await f.reports.write(f.mission.id, "worker", write);
	await notices.flush();
	assert.equal(attempts.length, 2);
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

test("host access is rechecked after durability and before historical receipt reads", async (t) => {
	const f = fixture(t),
		write = f.write();
	let allowed = true;
	const authorize = () => {
		if (!allowed) throw new Error("Project access changed");
	};
	const original = f.store.durable.bind(f.store);
	t.mock.method(f.store, "durable", async () => {
		await original();
		allowed = false;
	});
	await assert.rejects(f.reports.write(f.mission.id, "worker", write, authorize), /access changed/);
	assert.equal(f.reports.latest(f.mission.id).length, 0);
	allowed = true;
	t.mock.method(f.store, "durable", original);
	await f.reports.write(f.mission.id, "worker", write, authorize);
	t.mock.method(f.store, "durable", async () => {
		await original();
		allowed = false;
	});
	await assert.rejects(f.reports.write(f.mission.id, "worker", write, authorize), /access changed/);
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
