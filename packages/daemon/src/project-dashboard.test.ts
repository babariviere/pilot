import assert from "node:assert/strict";
import { test } from "node:test";
import type { Mission, SessionPullRequest, SessionSummary } from "@pilot/protocol";
import { buildProjectDashboard, type DashboardInput, ProjectDashboardService } from "./project-dashboard.ts";

let counter = 0;
function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
	counter++;
	return {
		id: `s${counter}`,
		title: `Chat ${counter}`,
		cwd: "/work",
		projectId: "p1",
		createdAt: 1_000,
		updatedAt: 1_000,
		state: "idle",
		...overrides,
	};
}

function pr(number: number, overrides: Partial<SessionPullRequest> = {}): SessionPullRequest {
	return {
		number,
		url: `https://github.com/o/r/pull/${number}`,
		title: `PR ${number}`,
		state: "open",
		checkedAt: 1_000 + number,
		...overrides,
	};
}

function mission(overrides: Partial<Mission> = {}): Mission {
	counter++;
	return {
		id: `m${counter}`,
		projectId: "p1",
		title: `Mission ${counter}`,
		goal: "",
		status: "active",
		briefRevision: 0,
		needsYouCount: 0,
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function build(overrides: Partial<DashboardInput> = {}) {
	return buildProjectDashboard({
		projectId: "p1",
		sessions: [],
		missions: [],
		progress: new Map(),
		isUnread: () => true,
		...overrides,
	});
}

test("an empty project has empty bounded sections and no extension data", () => {
	const dashboard = build();
	assert.deepEqual(dashboard.summary, {
		chats: 0,
		working: 0,
		needsYou: 0,
		openPullRequests: 0,
		readyPullRequests: 0,
		activeMissions: 0,
	});
	for (const section of [
		dashboard.needsYou,
		dashboard.working,
		dashboard.pullRequests,
		dashboard.missions,
		dashboard.scheduled,
		dashboard.recent,
	])
		assert.deepEqual(section, { total: 0, items: [] });
	assert.deepEqual(dashboard.tracked, []);
});

test("dashboard supports a larger but explicitly bounded section limit", () => {
	const sessions = Array.from({ length: 8 }, (_, i) => session({ id: `work-${i}`, state: "working" }));
	const dashboard = buildProjectDashboard(
		{
			projectId: "p1",
			sessions,
			missions: [],
			progress: new Map(),
			isUnread: () => true,
		},
		7,
	);
	assert.equal(dashboard.working.total, 8);
	assert.equal(dashboard.working.items.length, 7);
	assert.equal(build({ sessions }).working.items.length, 5);
});

test("sections hold at most five rows and report the full total", () => {
	const sessions = Array.from({ length: 8 }, (_, i) =>
		session({ state: "working", lastUserMessageAt: 100 + i, mode: "ask" }),
	);
	const dashboard = build({ sessions });
	assert.equal(dashboard.working.total, 8);
	assert.equal(dashboard.working.items.length, 5);
	assert.equal(dashboard.summary.working, 8);
	// Most recently started first.
	assert.deepEqual(
		dashboard.working.items.map((item) => item.startedAt),
		[107, 106, 105, 104, 103],
	);
	assert.equal(dashboard.working.items[0]?.mode, "ask");
});

test("working rows carry mission, model, branch and PR, and fall back to the creation time", () => {
	const m = mission({ title: "API v2" });
	const chat = session({
		state: "starting",
		missionId: m.id,
		model: "test/model",
		branch: "feat/x",
		pullRequest: pr(7),
		createdAt: 55,
	});
	const [item] = build({ sessions: [chat], missions: [m] }).working.items;
	assert.deepEqual(item, {
		sessionId: chat.id,
		title: chat.title,
		state: "starting",
		mode: "build",
		missionId: m.id,
		missionTitle: "API v2",
		model: "test/model",
		branch: "feat/x",
		pullRequest: { number: 7, url: chat.pullRequest!.url, state: "open" },
		startedAt: 55,
	});
});

test("needs you lists failures, mission questions, failed schedules and unread results in urgency order", () => {
	const unread = session({ outcome: "done", outcomeAt: 500 });
	const stopped = session({ outcome: "stopped", outcomeAt: 600, outcomeReason: "Stopped by user\nmore" });
	const failure = session({ outcome: "failed", outcomeAt: 100, outcomeReason: "Out of credits" });
	const crashed = session({ state: "failed", error: "worker exited" });
	const asking = mission({ needsYouCount: 2, updatedAt: 900 });
	const dashboard = build({
		sessions: [unread, stopped, failure, crashed],
		missions: [asking, mission({ status: "done", needsYouCount: 3 })],
		scheduled: [
			{
				id: "x1",
				title: "Nightly",
				kind: "chat",
				trigger: "on_back",
				state: "failed",
				error: "Project is gone",
				at: 50,
			},
			{ id: "x2", title: "Later", kind: "chat", trigger: "on_online", state: "pending" },
		],
	});
	assert.deepEqual(
		dashboard.needsYou.items.map((item) => [item.kind, item.id]),
		[
			["failed", `session:${crashed.id}`],
			["failed", `session:${failure.id}`],
			["question", `mission:${asking.id}`],
			["scheduled_failed", "scheduled:x1"],
			["unread", `session:${stopped.id}`],
		],
	);
	// Only the first five rows are kept, newest first within a kind.
	assert.equal(dashboard.needsYou.total, 6);
	assert.equal(dashboard.summary.needsYou, 6);
	const stoppedRow = build({ sessions: [stopped] }).needsYou.items[0];
	assert.equal(stoppedRow?.reason, "Stopped by user");
	assert.equal(stoppedRow?.outcome, "stopped");
	const question = build({ missions: [asking] }).needsYou.items[0];
	assert.deepEqual(question, {
		kind: "question",
		id: `mission:${asking.id}`,
		title: asking.title,
		missionId: asking.id,
		count: 2,
		at: 900,
	});
	assert.equal(dashboard.scheduled.total, 1);
	assert.equal(dashboard.scheduled.items[0]?.id, "x2");
});

test("reviewed results leave needs you and appear under recent instead", () => {
	const seen = session({ outcome: "done", outcomeAt: 300 });
	const fresh = session({ outcome: "done", outcomeAt: 400 });
	const reviewedFailure = session({ outcome: "failed", outcomeAt: 200 });
	const dashboard = build({
		sessions: [seen, fresh, reviewedFailure],
		isUnread: (id, at) => !(id === seen.id && at <= 300) && !(id === reviewedFailure.id && at <= 200),
	});
	assert.deepEqual(
		dashboard.needsYou.items.map((item) => item.sessionId),
		[fresh.id],
	);
	assert.deepEqual(
		dashboard.recent.items.map((item) => item.sessionId),
		[seen.id, reviewedFailure.id],
	);
	assert.equal(dashboard.recent.total, 2);
	// A newer completion is unread again.
	assert.equal(build({ sessions: [{ ...seen, outcomeAt: 301 }], isUnread: (_id, at) => at > 300 }).needsYou.total, 1);
});

test("a chat whose PRs all settled no longer needs review, but an unpublished one still does", () => {
	const merged = session({ outcome: "done", outcomeAt: 1, pullRequest: pr(1, { state: "merged" }) });
	const mixed = session({
		outcome: "done",
		outcomeAt: 2,
		pullRequest: pr(2, { state: "merged" }),
		pullRequests: [pr(2, { state: "merged" }), pr(3)],
	});
	const unpublished = session({
		outcome: "done",
		outcomeAt: 3,
		pullRequest: pr(4, { state: "closed" }),
		unpublishedWork: true,
	});
	const dashboard = build({ sessions: [merged, mixed, unpublished] });
	assert.deepEqual(dashboard.needsYou.items.map((item) => item.sessionId).sort(), [mixed.id, unpublished.id].sort());
	assert.deepEqual(
		dashboard.recent.items.map((item) => item.sessionId),
		[merged.id],
	);
});

test("working chats never need review", () => {
	const running = session({ state: "working", outcome: "failed", outcomeAt: 5 });
	const dashboard = build({ sessions: [running] });
	assert.equal(dashboard.needsYou.total, 0);
	assert.equal(dashboard.recent.total, 0);
});

test("pull requests dedupe by URL, skip settled ones and list newest check first", () => {
	const a = session({ title: "A", pullRequest: pr(1), pullRequests: [pr(1), pr(2, { state: "merged" })] });
	const b = session({ title: "B", pullRequest: pr(1, { checkedAt: 9_000, title: "PR 1 fresh" }) });
	const c = session({ title: "C", pullRequest: pr(5, { state: "draft", branch: "feat/c" }), missionId: "m" });
	const dashboard = build({ sessions: [a, b, c] });
	assert.deepEqual(
		dashboard.pullRequests.items.map((item) => [item.number, item.state, item.sessionTitle, item.title]),
		[
			[1, "open", "B", "PR 1 fresh"],
			[5, "draft", "C", "PR 5"],
		],
	);
	assert.equal(dashboard.pullRequests.items[1]?.branch, "feat/c");
	assert.equal(dashboard.pullRequests.items[1]?.missionId, "m");
	assert.deepEqual(dashboard.summary.openPullRequests, 2);
	// No readiness is known yet.
	assert.equal(dashboard.summary.readyPullRequests, 0);
	assert.equal(dashboard.pullRequests.items[0]?.readiness, undefined);
});

test("missions show task progress, working and needs-you counts, most pressing first", () => {
	const quiet = mission({ title: "Quiet", updatedAt: 9 });
	const busy = mission({ title: "Busy", updatedAt: 5 });
	const asking = mission({ title: "Asking", needsYouCount: 1, updatedAt: 1, coordinatorSessionId: "coord" });
	const archived = mission({ title: "Old", status: "archived" });
	const sessions = [
		session({ state: "working", missionId: busy.id }),
		session({ state: "working", missionId: busy.id }),
		session({ outcome: "done", outcomeAt: 1, missionId: busy.id }),
		session({ outcome: "failed", outcomeAt: 1, missionId: asking.id }),
	];
	const dashboard = build({
		sessions,
		missions: [quiet, busy, asking, archived],
		progress: new Map([[busy.id, { done: 2, total: 5 }]]),
	});
	assert.deepEqual(
		dashboard.missions.items.map((item) => [
			item.title,
			item.tasksDone,
			item.tasksTotal,
			item.working,
			item.needsYou,
		]),
		[
			["Asking", 0, 0, 0, 2],
			["Busy", 2, 5, 2, 1],
			["Quiet", 0, 0, 0, 0],
		],
	);
	assert.equal(dashboard.missions.items[0]?.coordinatorSessionId, "coord");
	assert.equal(dashboard.summary.activeMissions, 3);
	assert.ok(!("updatedAt" in dashboard.missions.items[0]!));
});

test("tracked sources pass through bounded, and the dashboard is stable across identical inputs", () => {
	const tracked = [
		{
			source: "linear",
			label: "Linear",
			status: "ok" as const,
			total: 9,
			items: Array.from({ length: 9 }, (_, i) => ({ id: `L-${i}`, title: `Issue ${i}` })),
		},
		{ source: "slack", label: "Slack", status: "sign_in_required" as const, total: 0, items: [] },
	];
	const dashboard = build({ tracked });
	assert.equal(dashboard.tracked[0]?.items.length, 5);
	assert.equal(dashboard.tracked[0]?.total, 9);
	assert.equal(dashboard.tracked[1]?.status, "sign_in_required");
	assert.equal(JSON.stringify(dashboard), JSON.stringify(build({ tracked })));
});

function service(
	sessions: SessionSummary[],
	extra: Partial<ConstructorParameters<typeof ProjectDashboardService>[0]> = {},
) {
	const listeners = new Set<(session: SessionSummary) => void>();
	const projectList = [{ id: "p1" }, { id: "p2" }, { id: "p3" }];
	let queries = 0;
	const unread = new Set<string>();
	const reviewListeners = new Set<() => void>();
	return {
		sessions,
		unread,
		queries: () => queries,
		emit: (value: SessionSummary) => {
			for (const listener of listeners) listener(value);
		},
		reviewed: () => {
			for (const listener of reviewListeners) listener();
		},
		service: new ProjectDashboardService({
			sessions: {
				list: (query) => {
					queries++;
					return sessions.filter((value) => !query.projectId || value.projectId === query.projectId);
				},
				onChange: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			},
			projects: {
				list: () => projectList as never,
				require: (id) => {
					if (!projectList.some((project) => project.id === id)) throw new Error("unknown");
					return projectList[0] as never;
				},
				onChange: () => () => {},
			},
			reviews: {
				isUnread: () => true,
				onChange: (listener) => {
					reviewListeners.add(listener);
					return () => reviewListeners.delete(listener);
				},
			},
			...extra,
		}),
	};
}

test("counts cover every project with one pass over the chats and omit quiet ones", () => {
	const f = service([
		session({ projectId: "p1", state: "working" }),
		session({ projectId: "p1", outcome: "done", outcomeAt: 1 }),
		session({ projectId: "p2", outcome: "failed", outcomeAt: 1 }),
		session({ projectId: "p3" }),
		session({ projectId: undefined, state: "working" }),
	]);
	assert.deepEqual(f.service.counts(), {
		projects: { p1: { working: 1, needsYou: 1 }, p2: { working: 0, needsYou: 1 } },
	});
	assert.equal(f.queries(), 1);
	// The dashboard agrees with the counts.
	assert.equal(f.service.dashboard("p1").summary.needsYou, 1);
	assert.throws(() => f.service.dashboard("nope"));
});

test("providers feed scheduled and tracked sections and report changes", () => {
	const changeListeners = new Set<() => void>();
	const f = service([], {
		providers: {
			scheduled: (projectId) =>
				projectId === "p1" ? [{ id: "a", title: "Plan", kind: "chat", trigger: "on_back", state: "pending" }] : [],
			tracked: () => [{ source: "linear", label: "Linear", status: "syncing", total: 0, items: [] }],
			onChange: (listener) => {
				changeListeners.add(listener);
				return () => changeListeners.delete(listener);
			},
		},
	});
	assert.equal(f.service.dashboard("p1").scheduled.total, 1);
	assert.equal(f.service.dashboard("p2").scheduled.total, 0);
	assert.equal(f.service.dashboard("p1").tracked[0]?.status, "syncing");
	let changes = 0;
	const stop = f.service.onChange(() => changes++);
	f.emit(session());
	f.reviewed();
	for (const listener of changeListeners) listener();
	assert.equal(changes, 3);
	stop();
	f.emit(session());
	f.reviewed();
	assert.equal(changes, 3);
	assert.equal(changeListeners.size, 0);
});
