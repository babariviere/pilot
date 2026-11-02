import assert from "node:assert/strict";
import { test } from "node:test";
import type { DashboardScheduledItem, ScheduleRun, SessionSummary } from "@pilot/protocol";
import { buildProjectDashboard, ProjectDashboardService } from "./project-dashboard.ts";
import { scheduleNotice } from "./schedule-notice.ts";

const due = Date.parse("2026-11-02T08:00Z"),
	at = Date.parse("2026-11-02T13:12Z");
function item(id: string, notice?: ScheduleRun): DashboardScheduledItem {
	return {
		id,
		title: "Weekly DB analysis",
		kind: "chat",
		trigger: "recurring",
		state: "pending",
		at: due + 604800000,
		recurrence: { every: "week", weekday: 1, time: "09:00", timeZone: "Europe/Paris" },
		...(notice ? { notice } : {}),
	};
}
const late = (): ScheduleRun => ({ due, at, outcome: "started", late: true, sessionId: "chat" });
const build = (scheduled: DashboardScheduledItem[], limit = 5) =>
	buildProjectDashboard(
		{ projectId: "p", sessions: [], missions: [], progress: new Map(), isUnread: () => false, scheduled },
		limit,
	);

test("all noteworthy run outcomes project once, with late successes informational", () => {
	const scheduled = [
		item("late", late()),
		item("skip", { due, at, outcome: "skipped_running", sessionId: "busy" }),
		item("miss", { due, at, outcome: "missed", count: 2 }),
		item("fail", { due, at, outcome: "failed", error: "Offline\nprivate detail" }),
	];
	const result = build(scheduled);
	assert.equal(result.needsYou.total, 4);
	assert.equal(result.summary.needsYou, 3);
	assert.equal(result.scheduled.total, 4);
	assert.equal(result.needsYou.items.at(-1)?.countsInBadge, false);
	const lateRow = result.needsYou.items.find((row) => row.scheduledId === "late")!;
	assert.match(lateRow.reason!, /due Mon 09:00, started 14:12/);
	assert.equal(lateRow.sessionId, "chat");
	assert.deepEqual(lateRow.scheduleRun, late());
	assert.equal(lateRow.scheduleTimeZone, "Europe/Paris");
	assert.match(result.needsYou.items.find((row) => row.scheduledId === "skip")!.reason!, /still working/);
	assert.match(result.needsYou.items.find((row) => row.scheduledId === "miss")!.reason!, /Missed 2 runs/);
	assert.equal(result.needsYou.items.find((row) => row.scheduledId === "fail")!.reason, "Failed to start: Offline");
	assert.equal(build([item("clean", { due, at: due, outcome: "sent" })]).needsYou.total, 0);
	assert.equal(build([item("dismissed")]).needsYou.total, 0);
	assert.equal(scheduleNotice({ ...scheduled[3]!, kind: "message" })?.reason, "Failed to send: Offline");
});

function service(scheduled: DashboardScheduledItem[], sessions: SessionSummary[] = []) {
	return new ProjectDashboardService({
		projects: {
			list: () => [
				{ id: "p", path: "/p", name: "P", createdAt: 0 },
				{ id: "other", path: "/other", name: "Other", createdAt: 0 },
			],
			require: (id) => ({ id, path: "/p", name: "P", createdAt: 0 }),
			onChange: () => () => {},
		},
		sessions: {
			list: (query) => (query.projectId && query.projectId !== "p" ? [] : sessions),
			onChange: () => () => {},
		},
		reviews: { isUnread: () => true, onChange: () => () => {} },
		providers: { scheduled: (id) => (id === "p" ? scheduled : []) },
	});
}

test("badges and reason counts exclude late rows beyond the visible slice", () => {
	const rows = Array.from({ length: 12 }, (_, n) => item(`late-${n}`, late()));
	const s = service(rows);
	assert.deepEqual(s.counts(), { projects: {} });
	assert.equal(s.dashboard("p").needsYou.total, 12);
	assert.equal(s.dashboard("p").needsYou.items.length, 5);
	assert.equal(s.inbox(undefined, 2).needsYou.total, 12);
	assert.equal(s.inbox("other", 10).needsYou.total, 0);
	rows.push(item("missed", { due, at, outcome: "missed", count: 3 }));
	assert.deepEqual(s.counts().projects.p, { working: 0, needsYou: 1, needsYouReasons: { schedule: 1 } });
	assert.equal(
		s.inbox(undefined, 1).needsYou.items[0].scheduledId,
		"missed",
		"actionable rows precede newer informational rows",
	);
});

test("schedule notices neither hide a ready PR nor replace their chat's own attention", () => {
	const pr = {
		number: 1,
		url: "https://example.com/pr/1",
		state: "open" as const,
		title: "Fix",
		checkedAt: 1,
		readiness: { state: "ready" as const, reasons: [], checkedAt: 1 },
	};
	const chat: SessionSummary = {
		id: "chat",
		projectId: "p",
		title: "Chat",
		cwd: "/p",
		createdAt: 1,
		updatedAt: 1,
		state: "idle",
		pullRequest: pr,
	};
	const s = service([item("late", late())], [chat]);
	assert.equal(s.inbox(undefined, 50).readyToMerge.total, 1);
	chat.outcome = "question";
	assert.equal(s.inbox(undefined, 50).needsYou.total, 2);
	assert.equal(s.counts().projects.p.needsYou, 1);
});

test("one-shot failures retain their existing projection and run error text stays bounded", () => {
	const failure: DashboardScheduledItem = {
		id: "once",
		title: "One time",
		kind: "message",
		trigger: "at",
		state: "failed",
		error: "Deleted target",
		at,
		sessionId: "target",
	};
	const result = build([failure, item("long", { due, at, outcome: "failed", error: "x".repeat(1000) })]);
	assert.equal(result.summary.needsYou, 2);
	assert.equal(result.needsYou.items.find((row) => row.scheduledId === "once")?.kind, "scheduled_failed");
	assert.equal(result.needsYou.items.find((row) => row.scheduledId === "long")?.reason?.length, 200);
});

test("global Inbox retains notices for removed projects, without making their dashboards readable", () => {
	const orphan = item("removed", { due, at, outcome: "failed", error: "Project was removed" });
	const s = new ProjectDashboardService({
		projects: {
			list: () => [],
			require: () => {
				throw new Error("Unknown project");
			},
			onChange: () => () => {},
		},
		sessions: { list: () => [], onChange: () => () => {} },
		reviews: { isUnread: () => false, onChange: () => () => {} },
		providers: {
			scheduled: (id) => (id === "gone" ? [orphan] : []),
			scheduledProjects: () => ["gone", "gone"],
			inbox: () => {
				throw new Error("Orphan has no tracking configuration");
			},
			tracked: () => {
				throw new Error("Orphan has no source configuration");
			},
			memory: () => {
				throw new Error("Orphan has no memory configuration");
			},
		},
	});
	assert.equal(s.inbox(undefined, 50).needsYou.total, 1);
	assert.equal(s.inbox(undefined, 50).needsYou.items[0].projectId, "gone");
	assert.equal(s.counts().projects.gone.needsYou, 1);
	assert.throws(() => s.dashboard("gone"), /Unknown project/);
	assert.throws(() => s.inbox("gone", 50), /Unknown project/);
});
