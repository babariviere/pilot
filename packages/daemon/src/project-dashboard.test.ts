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
		tasksDone: 0,
		tasksTotal: 0,
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function build(overrides: Partial<DashboardInput> = {}, limit = 5) {
	return buildProjectDashboard(
		{
			projectId: "p1",
			sessions: [],
			missions: [],
			progress: new Map(),
			isUnread: () => true,
			...overrides,
		},
		limit,
	);
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

test("stuck PRs survive reading, count once per chat and exclude every head from Ready to merge", () => {
	const attentionReason = { kind: "pr_stuck" as const, detail: "PR #2 · checks failing" };
	const chat = session({
		id: "stuck",
		missionId: "m",
		outcome: "done",
		outcomeAt: 1,
		attentionReason,
		// A healthy current head must not mask a stuck earlier PR in a stack.
		pullRequest: pr(1, { readiness: { state: "ready", reasons: [], checkedAt: 10 } }),
		pullRequests: [pr(2, { readiness: { state: "blocked", reasons: [{ code: "failing_checks" }], checkedAt: 10 } })],
	});
	const read = { isUnread: () => false, onChange: () => () => {} };
	const f = service([chat], { reviews: read });
	assert.deepEqual(f.service.counts().projects.p1, { working: 0, needsYou: 1, needsYouReasons: { pr_stuck: 1 } });
	const dashboard = build({ sessions: [chat], missions: [mission({ id: "m" })], isUnread: () => false });
	assert.equal(dashboard.needsYou.total, 1);
	assert.equal(dashboard.needsYou.items[0]?.kind, "pr_stuck");
	assert.deepEqual(dashboard.needsYou.items[0]?.attentionReason, attentionReason);
	assert.equal(dashboard.missions.items[0]?.needsYou, 1);
	assert.equal(f.service.inbox(undefined, 50).readyToMerge.total, 0);
	for (const outcome of ["failed", "question"] as const) {
		chat.outcome = outcome;
		const rows = f.service.inbox(undefined, 50).needsYou;
		assert.equal(rows.total, 1);
		assert.equal(rows.items[0]?.attentionReason.kind, outcome === "failed" ? "failed" : "asks");
	}
	chat.outcome = "done";
	delete chat.attentionReason;
	assert.equal(f.service.inbox(undefined, 50).needsYou.total, 0);
	assert.equal(f.service.inbox(undefined, 50).readyToMerge.total, 1);
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

test("readiness projects structured reasons, sorts ready first and counts ready across the row limit", () => {
	const sessions = Array.from({ length: 7 }, (_, i) =>
		session({
			pullRequest: pr(i + 1, {
				readiness: {
					state: i === 6 ? "blocked" : "ready",
					checkedAt: 42,
					reasons:
						i === 6
							? [
									{ code: "failing_checks", names: ["build"] },
									{ code: "unresolved_comments", count: 2 },
								]
							: [],
				},
			}),
		}),
	);
	const dashboard = build({ sessions });
	assert.equal(dashboard.summary.readyPullRequests, 6);
	assert.equal(dashboard.pullRequests.total, 7);
	assert.equal(dashboard.pullRequests.items.length, 5);
	assert.ok(dashboard.pullRequests.items.every((item) => item.readiness?.state === "ready"));
	const expanded = buildProjectDashboard(
		{ projectId: "p1", sessions, missions: [], progress: new Map(), isUnread: () => true },
		7,
	);
	assert.equal(expanded.pullRequests.items.length, 7);
	assert.equal(expanded.pullRequests.items.at(-1)?.readiness?.state, "blocked");
	const blocked = build({ sessions: [sessions[6]!] }).pullRequests.items[0]!;
	assert.deepEqual(blocked.readiness, {
		state: "blocked",
		reasons: ["Failing checks: build", "2 unresolved review threads"],
	});
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
		attentionReason: { kind: "mission", detail: "A question or blocked task is waiting on you" },
		at: 900,
	});
	assert.equal(dashboard.scheduled.total, 1);
	assert.equal(dashboard.scheduled.items[0]?.id, "x2");
});

test("reviewed results leave needs you and appear under recent instead, but failures stay until retried", () => {
	const seen = session({ outcome: "done", outcomeAt: 300 });
	const fresh = session({ outcome: "done", outcomeAt: 400 });
	const reviewedFailure = session({ outcome: "failed", outcomeAt: 200 });
	const dashboard = build({
		sessions: [seen, fresh, reviewedFailure],
		isUnread: (id, at) => !(id === seen.id && at <= 300) && !(id === reviewedFailure.id && at <= 200),
	});
	assert.deepEqual(
		dashboard.needsYou.items.map((item) => item.sessionId),
		[reviewedFailure.id, fresh.id],
	);
	assert.deepEqual(
		dashboard.recent.items.map((item) => item.sessionId),
		[seen.id],
	);
	assert.equal(dashboard.recent.total, 1);
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

test("an agent question needs you until it is answered, even after the chat was viewed", () => {
	const asking = session({
		outcome: "question",
		outcomeAt: 50,
		outcomeReason: "Where should retries live?",
		missionId: "m-q",
	});
	const done = session({ outcome: "done", outcomeAt: 60 });
	const dashboard = build({ sessions: [asking, done], isUnread: () => false });
	assert.deepEqual(dashboard.needsYou.items, [
		{
			kind: "question",
			id: `session:${asking.id}`,
			title: asking.title,
			sessionId: asking.id,
			missionId: "m-q",
			outcome: "question",
			reason: "Where should retries live?",
			attentionReason: { kind: "asks", detail: "Where should retries live?" },
			at: 50,
		},
	]);
	assert.deepEqual(
		dashboard.recent.items.map((item) => item.sessionId),
		[done.id],
	);
	// Answering starts a run; a working chat no longer waits on the user.
	assert.equal(build({ sessions: [{ ...asking, state: "working" }] }).needsYou.total, 0);
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
		progress: new Map([[busy.id, { done: 2, inReview: 1, inProgress: 1, blocked: 0, total: 5 }]]),
	});
	assert.deepEqual(
		dashboard.missions.items.map((item) => [
			item.title,
			item.tasksDone,
			item.tasksInReview,
			item.tasksInProgress,
			item.tasksBlocked,
			item.tasksTotal,
			item.working,
			item.needsYou,
		]),
		[
			["Asking", 0, 0, 0, 0, 0, 0, 2],
			["Busy", 2, 1, 1, 0, 5, 2, 1],
			["Quiet", 0, 0, 0, 0, 0, 0, 0],
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
			done: { total: 7, items: Array.from({ length: 7 }, (_, i) => ({ id: `D-${i}`, title: `Done ${i}` })) },
		},
		{ source: "slack", label: "Slack", status: "sign_in_required" as const, total: 0, items: [] },
	];
	const dashboard = build({ tracked });
	assert.equal(dashboard.tracked[0]?.items.length, 5);
	assert.equal(dashboard.tracked[0]?.total, 9);
	assert.equal(dashboard.tracked[0]?.done?.items.length, 5);
	assert.equal(dashboard.tracked[0]?.done?.total, 7);
	assert.equal(dashboard.tracked[1]?.done, undefined);
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
		projects: {
			p1: { working: 1, needsYou: 1, needsYouReasons: { not_reviewed: 1 } },
			p2: { working: 0, needsYou: 1, needsYouReasons: { failed: 1 } },
		},
	});
	assert.equal(f.queries(), 1);
	// The dashboard agrees with the counts.
	assert.equal(f.service.dashboard("p1").summary.needsYou, 1);
	assert.throws(() => f.service.dashboard("nope"));
});

test("idle background work uses the daemon flag in counts, working rows, missions and Inbox", () => {
	const m = mission({ id: "m1" });
	const jobs = [{ id: "tests", name: "Tests", state: "running" as const, startedAt: 1, outputPath: "/tmp/tests.log" }];
	const chats = [
		session({ id: "jobs", working: true, runningJobs: jobs, outcome: "done", outcomeAt: 42, missionId: m.id }),
		session({ id: "follow-up", working: true, missionId: m.id }),
		session({ id: "legacy", runningJobs: jobs }),
	];
	const f = service(chats);
	assert.deepEqual(f.service.counts(), { projects: { p1: { working: 3, needsYou: 0 } } });
	const dashboard = f.service.dashboard("p1");
	assert.equal(dashboard.summary.working, 3);
	assert.equal(dashboard.working.total, 3);
	assert.ok(dashboard.working.items.every((item) => item.state === "working"));
	assert.equal(dashboard.needsYou.total, 0);
	assert.equal(dashboard.recent.total, 0);
	assert.equal(f.service.needsYou(undefined, 50).total, 0);
	assert.equal(build({ sessions: chats, missions: [m] }).missions.items[0]?.working, 2);
	// An explicit daemon value wins over local inference (for example, future attention overrides).
	const override = session({ working: false, runningJobs: jobs, outcome: "question", outcomeAt: 43 });
	assert.equal(build({ sessions: [override] }).summary.working, 0);
	assert.equal(build({ sessions: [override] }).needsYou.total, 1);
});

test("counts add the Inbox's tracked items, and the Inbox lists needs-you rows across projects", () => {
	const f = service(
		[
			session({ id: "a", projectId: "p1", outcome: "done", outcomeAt: 5 }),
			session({ id: "b", projectId: "p2", outcome: "failed", outcomeAt: 1 }),
			session({ id: "c", projectId: "p2", outcome: "done", outcomeAt: 9 }),
		],
		{ providers: { inbox: (projectId) => (projectId === "p3" ? 4 : 0) } },
	);
	assert.deepEqual(f.service.counts(), {
		projects: {
			p1: { working: 0, needsYou: 1, needsYouReasons: { not_reviewed: 1 } },
			p2: { working: 0, needsYou: 2, needsYouReasons: { failed: 1, not_reviewed: 1 } },
			p3: { working: 0, needsYou: 0, tracked: 4 },
		},
	});
	const all = f.service.needsYou(undefined, 2);
	assert.equal(all.total, 3);
	assert.deepEqual(
		all.items.map((item) => [item.projectId, item.sessionId, item.kind]),
		[
			["p2", "b", "failed"],
			["p2", "c", "unread"],
		],
		"failures first, then newest, across projects",
	);
	assert.deepEqual(
		f.service.needsYou("p1", 50).items.map((item) => item.sessionId),
		["a"],
	);
	assert.throws(() => f.service.needsYou("missing", 50));
});

test("the Inbox lists ready PRs across projects, leaving out chats that work or need the user", () => {
	const ready = { state: "ready" as const, reasons: [], checkedAt: 1 };
	const f = service([
		session({ id: "a", projectId: "p1", pullRequest: pr(1, { readiness: ready, checkedAt: 10 }) }),
		session({ id: "b", projectId: "p2", pullRequest: pr(2, { readiness: ready, checkedAt: 30 }), missionId: "m" }),
		// Pending, blocked and draft PRs wait on the page, not in the Inbox.
		session({ projectId: "p1", pullRequest: pr(3, { readiness: { ...ready, state: "pending" } }) }),
		session({ projectId: "p1", pullRequest: pr(4, { state: "draft", readiness: ready }) }),
		// Each chat sits in one section: working first, then Needs you.
		session({ id: "busy", projectId: "p1", state: "working", pullRequest: pr(5, { readiness: ready }) }),
		session({
			id: "unread",
			projectId: "p1",
			outcome: "done",
			outcomeAt: 7,
			pullRequest: pr(6, { readiness: ready }),
		}),
	]);
	const inbox = f.service.inbox(undefined, 50);
	assert.deepEqual(
		inbox.readyToMerge.items.map((item) => [item.projectId, item.sessionId, item.number, item.missionId]),
		[
			["p2", "b", 2, "m"],
			["p1", "a", 1, undefined],
		],
		"newest check first",
	);
	assert.equal(inbox.readyToMerge.items[0]?.readiness?.state, "ready");
	assert.deepEqual(
		inbox.needsYou.items.map((item) => item.sessionId),
		["unread"],
	);
	assert.deepEqual(
		f.service.inbox("p1", 50).readyToMerge.items.map((item) => item.number),
		[1],
	);
	const capped = f.service.inbox(undefined, 1).readyToMerge;
	assert.equal(capped.total, 2);
	assert.equal(capped.items.length, 1);
	// Ready PRs never add to the badge counts.
	assert.equal(f.service.counts().projects.p2, undefined);
	assert.throws(() => f.service.inbox("missing", 50));
});

+test("reading results updates counts, reasons and the Inbox together; failures and questions stay", () => {
	const ready = { state: "ready" as const, reasons: [], checkedAt: 1 };
	const read = new Set<string>();
	const f = service(
		[
			session({ id: "done", projectId: "p1", outcome: "done", outcomeAt: 5 }),
			session({
				id: "ready",
				projectId: "p1",
				outcome: "done",
				outcomeAt: 6,
				pullRequest: pr(1, { readiness: ready }),
			}),
			session({ id: "failed", projectId: "p1", outcome: "failed", outcomeAt: 7 }),
			session({ id: "question", projectId: "p1", outcome: "question", outcomeAt: 8 }),
		],
		{ reviews: { isUnread: (id) => !read.has(id), onChange: () => () => {} } },
	);
	const kinds = () => f.service.inbox(undefined, 50).needsYou.items.map((item) => item.sessionId);
	assert.deepEqual(f.service.counts().projects.p1, {
		working: 0,
		needsYou: 4,
		needsYouReasons: { failed: 1, asks: 1, not_reviewed: 2 },
	});
	assert.deepEqual(kinds(), ["failed", "question", "ready", "done"]);
	assert.deepEqual(f.service.inbox(undefined, 50).readyToMerge.total, 0);
	for (const id of ["done", "ready", "failed", "question"]) read.add(id);
	assert.deepEqual(f.service.counts().projects.p1, {
		working: 0,
		needsYou: 2,
		needsYouReasons: { failed: 1, asks: 1 },
	});
	assert.deepEqual(kinds(), ["failed", "question"]);
	assert.deepEqual(
		f.service.inbox(undefined, 50).readyToMerge.items.map((item) => item.sessionId),
		["ready"],
	);
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

test("every attention row has a reason, including missing diagnostics and schedules", () => {
	const dashboard = build(
		{
			sessions: [
				session({ outcome: "failed", outcomeAt: 1 }),
				session({ outcome: "question", outcomeReason: "Deploy now?\nOptions" }),
				session({ outcome: "done", outcomeAt: 1 }),
			],
			missions: [mission({ needsYouCount: 1, needsYouReason: "Blocked: Release" })],
			scheduled: [{ id: "schedule", title: "Later", kind: "chat", trigger: "on_back", state: "failed" }],
		},
		50,
	);
	assert.deepEqual(
		dashboard.needsYou.items.map((item) => item.attentionReason),
		[
			{ kind: "failed", detail: "The chat failed" },
			{ kind: "asks", detail: "Deploy now?" },
			{ kind: "mission", detail: "Blocked: Release" },
			{ kind: "couldnt_start", detail: "The scheduled chat could not start" },
			{ kind: "not_reviewed" },
		],
	);
});

test("reason totals include rows beyond the dashboard and Inbox caps", () => {
	const f = service(
		Array.from({ length: 80 }, (_, i) =>
			session({ id: `s${i}`, projectId: "p1", outcome: i < 10 ? "question" : "done", outcomeAt: i + 1 }),
		),
	);
	assert.equal(f.service.dashboard("p1").needsYou.items.length, 5);
	assert.equal(f.service.needsYou(undefined, 50).items.length, 50);
	assert.deepEqual(f.service.counts().projects.p1?.needsYouReasons, { asks: 10, not_reviewed: 70 });
});

test("long jobs move from Working to Needs you, count inside missions, and cannot be reviewed away", () => {
	const m = mission();
	const long = session({
		id: "long",
		missionId: m.id,
		working: true,
		attentionReason: { kind: "long_job", detail: "Tests has run for 1h" },
		attentionAt: 3_600_000,
	});
	const normal = session({ id: "short", missionId: m.id, working: true });
	const dashboard = build({ sessions: [long, normal], missions: [m], isUnread: () => false });
	assert.equal(dashboard.needsYou.total, 1);
	assert.deepEqual(dashboard.needsYou.items[0], {
		kind: "long_job",
		id: "session:long",
		title: long.title,
		sessionId: "long",
		missionId: m.id,
		reason: "Tests has run for 1h",
		attentionReason: long.attentionReason,
		at: 3_600_000,
	});
	assert.deepEqual(
		dashboard.working.items.map((item) => item.sessionId),
		["short"],
	);
	assert.equal(dashboard.missions.items[0]!.needsYou, 1);
	assert.equal(dashboard.missions.items[0]!.working, 2, "member activity remains real work");
	const cleared = build({
		sessions: [{ ...long, attentionReason: undefined, attentionAt: undefined }],
		missions: [m],
	});
	assert.equal(cleared.needsYou.total, 0);
	assert.equal(cleared.working.total, 1);
	assert.equal(cleared.missions.items[0]!.needsYou, 0);
});

test("live long-job changes refresh uncapped Inbox counts without a review or mission write", () => {
	const chats = Array.from({ length: 60 }, (_, i) =>
		session({
			id: `long-${i}`,
			working: true,
			attentionAt: 3_600_000,
			attentionReason: { kind: "long_job", detail: "Tests has run for 1h" },
		}),
	);
	const f = service(chats);
	let changes = 0;
	const dispose = f.service.onChange(() => changes++);
	f.emit(chats[0]!);
	assert.equal(changes, 1);
	assert.equal(f.service.dashboard("p1").needsYou.items.length, 5);
	assert.equal(f.service.needsYou(undefined, 50).items.length, 50);
	assert.deepEqual(f.service.counts().projects.p1, { working: 0, needsYou: 60, needsYouReasons: { long_job: 60 } });
	delete chats[0]!.attentionReason;
	delete chats[0]!.attentionAt;
	f.emit(chats[0]!);
	assert.equal(changes, 2);
	assert.deepEqual(f.service.counts().projects.p1, { working: 1, needsYou: 59, needsYouReasons: { long_job: 59 } });
	dispose();
});
