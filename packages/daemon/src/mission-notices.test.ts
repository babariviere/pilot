import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { SessionSummary } from "@pilot/protocol";
import { MissionNotices } from "./mission-notices.ts";
import { MissionStore, NOTICE_MAX_DELAY_MS, NOTICE_WINDOW_MS } from "./missions.ts";
import type { SessionManager } from "./sessions.ts";

function setup(store = new MissionStore(":memory:")) {
	const mission = store.create({ projectId: "project", title: "Test", tasks: [{ title: "Pagination" }] });
	store.join("lead", mission.id);
	store.join("member", mission.id);
	store.update(mission.id, { coordinatorSessionId: "lead" });
	store.claimTask(mission.id, "1", "member");
	return { store, id: mission.id };
}

function completion(outcome: SessionSummary["outcome"], outcomeAt: number): SessionSummary {
	return {
		id: "member",
		title: "Chat",
		mode: "build",
		cwd: "/tmp",
		sessionPath: "/tmp",
		state: "idle",
		createdAt: 0,
		updatedAt: 0,
		outcome,
		outcomeAt,
		pullRequest: { number: 12, url: "https://github.com/o/r/pull/12", title: "PR", state: "open", checkedAt: 0 },
	};
}

const backgroundJob = {
	id: "tests",
	name: "Test suite",
	state: "running" as const,
	startedAt: 1_000,
	outputPath: "/tmp/tests.log",
};

function jobDelivery(store: MissionStore, id: string) {
	let member: SessionSummary = { ...completion(undefined, 0), pullRequest: undefined, missionId: id };
	const lead = { ...member, id: "lead" };
	let observe!: (summary: SessionSummary) => void;
	const sent: string[] = [];
	const sessions = {
		list: () => [lead, member],
		get: (id: string) => (id === "lead" ? lead : member),
		onChange: (listener: typeof observe) => {
			observe = listener;
			return () => {};
		},
		canSendNotice: () => lead.state === "idle",
		sendNotice: async (_id: string, content: string, requestId: string) => {
			assert.equal(delivery.allowed("lead", requestId), true);
			sent.push(content);
			return true;
		},
	} as unknown as SessionManager;
	const delivery = new MissionNotices(store, sessions);
	delivery.start();
	return {
		delivery,
		sent,
		lead,
		change: (patch: Partial<SessionSummary>) => {
			member = { ...member, ...patch };
			observe(member);
		},
	};
}

test("turn end with a job holds completion, then one final notice includes the follow-up PR", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
	const { store, id } = setup();
	const f = jobDelivery(store, id);
	try {
		f.change({ state: "working", working: true, runningJobs: [backgroundJob] });
		f.change({ state: "idle", outcome: "done", outcomeAt: Date.now() });
		assert.equal(store.events(id).filter((event) => event.kind === "update").length, 0);
		assert.deepEqual(store.noticeDeadlines(Date.now()), []);
		t.mock.timers.tick(60_000);
		await f.delivery.flush();
		assert.equal(f.sent.length, 0);
		// The registry empties before the extension's completion follow-up is admitted.
		f.change({ runningJobs: [] });
		assert.deepEqual(store.noticeDeadlines(Date.now()), []);
		t.mock.timers.tick(60_000);
		await f.delivery.flush();
		assert.equal(f.sent.length, 0);
		f.change({ state: "working", outcome: undefined });
		t.mock.timers.tick(60_000);
		await f.delivery.flush();
		assert.equal(f.sent.length, 0);
		f.change({
			state: "idle",
			working: false,
			outcome: "done",
			outcomeAt: Date.now(),
			pullRequest: completion("done", 0).pullRequest,
		});
		t.mock.timers.tick(29_999);
		await f.delivery.flush();
		assert.equal(f.sent.length, 0);
		t.mock.timers.tick(1);
		await f.delivery.flush();
		assert.equal(f.sent.length, 1);
		assert.match(f.sent[0]!, /#1 Pagination: chat finished, PR #12 open/);
		assert.doesNotMatch(f.sent[0]!, /waiting on background job/);
		await f.delivery.flush();
		assert.equal(f.sent.length, 1);
	} finally {
		await f.delivery.stop();
		store.close();
	}
});

for (const olderJob of [false, true]) {
	test(`jobs never create a deadline or notice (${olderJob ? "old" : "new"} job)`, async (t) => {
		t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
		const { store, id } = setup();
		const f = jobDelivery(store, id);
		try {
			if (olderJob) t.mock.timers.tick(10 * 60_000);
			const job = { ...backgroundJob, startedAt: olderJob ? 1_000 : Date.now() };
			f.change({ state: "working", working: true, runningJobs: [job] });
			f.change({ state: "idle", outcome: "done", outcomeAt: Date.now() });
			for (const elapsed of [NOTICE_MAX_DELAY_MS, NOTICE_WINDOW_MS, 24 * NOTICE_WINDOW_MS]) {
				t.mock.timers.tick(elapsed);
				await f.delivery.flush();
				assert.equal(f.sent.length, 0);
				assert.deepEqual(store.noticeDeadlines(Date.now()), []);
			}
			assert.equal(store.events(id).filter((event) => event.kind === "update").length, 0);
		} finally {
			await f.delivery.stop();
			store.close();
		}
	});
}

test("pending updates stay unsettled between job exit and follow-up admission", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
	const { store, id } = setup();
	const f = jobDelivery(store, id);
	try {
		f.change({ state: "idle", working: true, runningJobs: [backgroundJob] });
		store.addComment(id, { text: "A real update" });
		t.mock.timers.tick(60_000);
		f.change({ runningJobs: [] });
		await f.delivery.flush();
		assert.equal(f.sent.length, 0, "the job-exit gap is still busy");
		f.change({ working: false });
		t.mock.timers.tick(29_999);
		await f.delivery.flush();
		assert.equal(f.sent.length, 0);
		t.mock.timers.tick(1);
		await f.delivery.flush();
		assert.equal(f.sent.length, 1);
		assert.match(f.sent[0]!, /A real update/);
		assert.doesNotMatch(f.sent[0]!, /waiting on background job|still has a running job/);
	} finally {
		await f.delivery.stop();
		store.close();
	}
});

test("the coordinator's own running jobs do not delay updates", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
	const { store, id } = setup();
	const f = jobDelivery(store, id);
	try {
		f.lead.working = true;
		f.lead.runningJobs = [backgroundJob];
		store.addComment(id, { text: "Update for the coordinator" });
		t.mock.timers.tick(30_000);
		await f.delivery.flush();
		assert.equal(f.sent.length, 1);
		assert.match(f.sent[0]!, /Update for the coordinator/);
		assert.doesNotMatch(f.sent[0]!, /running job/);
	} finally {
		await f.delivery.stop();
		store.close();
	}
});

test("pending job holds recover across daemon restart; dead jobs cannot leave activity stuck", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
	const home = await mkdtemp(join(tmpdir(), "pilot-job-notice-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const file = join(home, "missions.sqlite");
	const original = setup(new MissionStore(file));
	const f = jobDelivery(original.store, original.id);
	f.change({ state: "working", working: true, runningJobs: [backgroundJob] });
	f.change({ state: "idle", outcome: "done", outcomeAt: Date.now() });
	await f.delivery.stop();
	original.store.close();
	t.mock.timers.tick(10_000);
	const store = new MissionStore(file);
	// Jobs belong to the old worker and die on shutdown. Its persisted outcome can be unchanged.
	const next = jobDelivery(store, original.id);
	try {
		next.change({ state: "parked", outcome: "done", outcomeAt: 1_000, runningJobs: undefined });
		assert.equal(store.noticeDeadlines(Date.now())[0]!.at, Date.now() + 30_000);
		t.mock.timers.tick(30_000);
		await next.delivery.flush();
		assert.equal(next.sent.length, 1);
		assert.match(next.sent[0]!, /chat finished/);
		assert.doesNotMatch(next.sent[0]!, /waiting on background job|still has a running job/);
		assert.deepEqual(store.noticeDeadlines(Date.now()), []);
	} finally {
		await next.delivery.stop();
		store.close();
	}
});

test("upgraded stores ignore persisted job deadlines", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
	const home = await mkdtemp(join(tmpdir(), "pilot-job-deadline-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const file = join(home, "missions.sqlite");
	const original = setup(new MissionStore(file));
	original.store.close();
	const db = new DatabaseSync(file);
	db.exec("ALTER TABLE notice_activity ADD COLUMN job_deadline INTEGER");
	db.prepare("INSERT INTO notice_activity (mission_id, busy, idle_at, job_deadline) VALUES (?, 1, 1000, 1000)").run(
		original.id,
	);
	db.close();
	const store = new MissionStore(file);
	const f = jobDelivery(store, original.id);
	try {
		f.change({ state: "idle", working: true, runningJobs: [backgroundJob] });
		store.addComment(original.id, { text: "A real update" });
		assert.equal(store.noticeDeadlines(Date.now())[0]!.at, Date.now() + NOTICE_MAX_DELAY_MS);
		t.mock.timers.tick(30_000);
		await f.delivery.flush();
		assert.equal(f.sent.length, 0, "an old job deadline cannot make the update due");
	} finally {
		await f.delivery.stop();
		store.close();
	}
});

test("an idle member with a pending job follow-up cannot record a stale outcome", () => {
	const { store, id } = setup();
	try {
		const before = store.events(id);
		store.recordMemberCompletion({ ...completion("done", 1), working: true });
		assert.deepEqual(store.events(id), before);
		assert.deepEqual(store.noticeDeadlines(Date.now()), []);
		store.recordMemberCompletion({ ...completion("done", 2), working: false });
		assert.equal(store.events(id)[0]!.text, "#1 Pagination: chat finished, PR #12 open");
	} finally {
		store.close();
	}
});

test("lead settlements never create activity or pending notices", () => {
	const { store, id } = setup();
	try {
		const before = store.events(id);
		store.recordMemberCompletion({ ...completion("done", 50), id: "lead" });
		store.recordMemberCompletion({ ...completion("failed", 51), id: "lead" });
		assert.deepEqual(store.events(id), before);
		assert.deepEqual(store.noticeDeadlines(Date.now()), []);
	} finally {
		store.close();
	}
});

test("PR transitions are recorded once, without repeating unchanged PR states", () => {
	const { store, id } = setup();
	try {
		const now = Date.now();
		const open = completion("done", now + 1);
		store.recordMemberPullRequests(open, [open.pullRequest!]);
		store.recordMemberCompletion(open);
		const merged = {
			...open,
			outcomeAt: now + 3,
			pullRequest: { ...open.pullRequest!, state: "merged" as const, mergedAt: now + 2 },
		};
		store.recordMemberPullRequests(merged, [merged.pullRequest]);
		store.recordMemberCompletion(merged);
		assert.match(store.events(id)[0]!.text, /PR #12 PR merged/);
		const before = store.events(id);
		store.recordMemberCompletion({ ...merged, outcomeAt: now + 4 });
		assert.deepEqual(store.events(id), before);
		store.recordMemberCompletion({ ...merged, outcomeAt: now + 5, outcomeReason: "New information" });
		assert.match(store.events(id)[0]!.text, /New information/);
		assert.doesNotMatch(store.events(id)[0]!.text, /PR #12/);
		assert.equal(store.events(id).filter((event) => event.text.includes("PR #12 PR merged")).length, 1);
	} finally {
		store.close();
	}
});

test("a run containing only already completed tasks carries no new activity", () => {
	const { store, id } = setup();
	try {
		store.updateTask(id, "1", { status: "done" });
		store.recordMemberRun({ ...completion("done", 1), state: "working" });
		const before = store.events(id);
		store.recordMemberCompletion(completion("done", Date.now() + 1));
		assert.deepEqual(store.events(id), before);
		assert.deepEqual(store.noticeDeadlines(Date.now()), []);
	} finally {
		store.close();
	}
});

test("settles omit old completed work without materializing other members' tasks", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
	const { store, id } = setup();
	try {
		store.updateTask(id, "1", { status: "done" });
		const next = store.addTask(id, { title: "Next" });
		store.claimTask(id, next.id, "member");
		const old = completion("done", 1).pullRequest!;
		store.addResource(id, { url: old.url, taskId: store.resolveTask(id, "1").id });
		const tasks = t.mock.method(store, "tasks", () => assert.fail("activity must not read every task body"));
		store.recordMemberRun({ ...completion("done", 1), state: "working" });
		tasks.mock.restore();
		store.updateTask(id, next.id, { status: "done" });
		// Duplicate working observations must not recapture a task completed during this run.
		t.mock.method(store, "tasks", () => assert.fail("activity must not read every task body"));
		store.recordMemberRun({ ...completion("done", 1), state: "working" });
		t.mock.timers.tick(1);
		const now = Date.now();
		store.recordMemberCompletion({
			...completion("done", now + 1),
			pullRequests: [
				old,
				{ ...old, number: 13, url: "https://github.com/o/r/pull/13", state: "merged", mergedAt: now },
			],
		});
		const event = store.events(id)[0]!;
		assert.match(event.text, /#2 Next: chat finished/);
		assert.doesNotMatch(event.text, /PR #13 merged/);
		assert.doesNotMatch(event.text, /Pagination|PR #12/);
	} finally {
		store.close();
	}
});

test("acknowledged states stay consumed across restart, even with newer snapshot versions", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-notice-dedupe-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const file = join(home, "missions.sqlite");
	const f = setup(new MissionStore(file));
	f.store.recordMemberCompletion(completion("done", 50));
	const now = Date.now() + 30_000;
	f.store.acknowledgeNotice(f.store.prepareNotice(f.id, "lead", now)!, now);
	f.store.close();
	const store = new MissionStore(file);
	try {
		store.recordMemberCompletion(completion("done", 50), true);
		store.recordMemberCompletion(completion("done", 51));
		assert.deepEqual(store.noticeDeadlines(now), []);
		store.recordMemberCompletion({ ...completion("done", 52), outcomeReason: "New question" });
		assert.match(store.prepareNotice(f.id, "lead", now + 30_000)!.content, /New question/);
	} finally {
		store.close();
	}
});

test("startup baselines outcomes predating membership instead of announcing old work", () => {
	const { store, id } = setup();
	try {
		store.recordMemberCompletion(completion("done", 1), true);
		assert.deepEqual(store.noticeDeadlines(Date.now()), []);
		store.recordMemberCompletion(completion("done", 2));
		assert.deepEqual(store.noticeDeadlines(Date.now()), []);
		store.recordMemberCompletion(completion("failed", 3));
		assert.match(store.prepareNotice(id, "lead", Date.now() + 30_000)!.content, /failed/);
	} finally {
		store.close();
	}
});

test("later outcomes do not re-report an old merged PR", () => {
	const { store, id } = setup();
	try {
		store.recordMemberCompletion(completion("done", 50));
		const now = Date.now() + 30_000;
		store.acknowledgeNotice(store.prepareNotice(id, "lead", now)!, now);
		store.recordMemberCompletion({
			...completion("failed", 60),
			pullRequest: { ...completion("done", 50).pullRequest!, state: "merged", mergedAt: 40 },
		});
		const notice = store.prepareNotice(id, "lead", now + 30_000)!;
		assert.match(notice.content, /failed/);
		assert.doesNotMatch(notice.content, /PR #12 merged/);
	} finally {
		store.close();
	}
});

test("only settlements, newly blocked tasks and relevant comments create durable pending events", () => {
	const { store, id } = setup();
	try {
		store.addComment(id, { text: "addressed to someone else", targetSessionId: "member" });
		store.addComment(id, { text: "own comment" }, { sessionId: "lead" });
		store.updateTask(id, "1", { status: "blocked" }, { sessionId: "lead" });
		store.recordMemberCompletion({ ...completion("done", 1), id: "lead" });
		store.recordMemberCompletion({ ...completion("done", 1), id: "outsider" });
		assert.deepEqual(store.noticeDeadlines(Date.now()), []);
		store.updateTask(id, "1", { status: "in_progress" });
		store.updateTask(id, "1", { status: "blocked", body: "Need API access" }, { sessionId: "member" });
		store.updateTask(id, "1", { body: "Still blocked" }, { sessionId: "member" });
		store.addComment(id, { text: "please review", targetSessionId: "lead" }, { sessionId: "member" });
		store.addComment(id, { text: "general question" });
		for (const [index, outcome] of ["done", "failed", "stopped"].entries()) {
			store.recordMemberCompletion(completion(outcome as SessionSummary["outcome"], index + 2));
			store.recordMemberCompletion(completion(outcome as SessionSummary["outcome"], index + 2));
		}
		store.recordMemberCompletion(completion("done", 1));
		const notice = store.prepareNotice(id, "lead", Date.now() + 30_000)!;
		assert.equal(notice.content.split("\n").filter((line) => line.startsWith("- ")).length, 3);
		assert.doesNotMatch(notice.content, /blocked: Need API access|chat finished|chat failed/);
		assert.match(notice.content, /chat stopped/);
		assert.match(notice.content, /Read the mission with get for details/);
		assert.doesNotMatch(notice.content, /own comment|someone else|Still blocked/);
	} finally {
		store.close();
	}
});

test("30-second settle merges bursts, with a single 30-minute safety cap", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
	const { store, id } = setup();
	try {
		store.addComment(id, { text: "first" });
		assert.equal(store.noticeDeadlines(1_000)[0]!.at, 31_000);
		assert.equal(store.prepareNotice(id, "lead", 30_999), undefined);
		for (let second = 20; second <= 100; second += 20) {
			t.mock.timers.tick(20_000);
			store.addComment(id, { text: `at ${second}` });
		}
		assert.equal(store.noticeDeadlines(101_000)[0]!.at, 131_000);
		assert.equal(store.prepareNotice(id, "lead", 130_999), undefined);
		store.setNoticeActivity(id, true, 101_000);
		assert.equal(store.noticeDeadlines(101_000)[0]!.at, 1_000 + NOTICE_MAX_DELAY_MS);
		assert.equal(store.prepareNotice(id, "lead", 1_000 + NOTICE_MAX_DELAY_MS - 1), undefined);
		const notice = store.prepareNotice(id, "lead", 1_000 + NOTICE_MAX_DELAY_MS)!;
		assert.ok(notice);
		assert.equal(notice.content.split("\n").filter((line) => line.startsWith("- ")).length, 1);
		store.acknowledgeNotice(notice, 121_000);
		assert.deepEqual(store.noticeDeadlines(121_000), []);
	} finally {
		store.close();
	}
});

test("frozen payload, stable request ID and completion high-water mark survive restart; later events are retained", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-notice-store-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const file = join(home, "missions.sqlite");
	const f = setup(new MissionStore(file));
	f.store.recordMemberCompletion(completion("done", 50));
	const now = Date.now() + 30_000;
	const notice = f.store.prepareNotice(f.id, "lead", now)!;
	assert.equal(notice.event.kind, "mission_member_finished");
	assert.match(notice.event.text, /finished/);
	assert.doesNotMatch(notice.event.text, /Read|instructions|propose/);
	f.store.close();
	const store = new MissionStore(file);
	try {
		store.recordMemberCompletion(completion("done", 50));
		store.addComment(f.id, { text: "arrived while sending" });
		assert.deepEqual(store.prepareNotice(f.id, "lead", now), notice);
		assert.equal(notice.requestId, `mission-notice:${notice.lastEventId}`);
		store.acknowledgeNotice(notice, now);
		const next = store.prepareNotice(f.id, "lead", now + 30_000)!;
		assert.match(next.content, /arrived while sending/);
		assert.doesNotMatch(next.content, /chat finished/);
		assert.notEqual(next.requestId, notice.requestId);
	} finally {
		store.close();
	}
});

test("active-role guards preserve events and revoke a frozen notice when the role moves", () => {
	const { store, id } = setup();
	try {
		store.addComment(id, { text: "pending" });
		const now = Date.now() + 30_000;
		store.update(id, { status: "done" });
		assert.equal(store.prepareNotice(id, "lead", now), undefined);
		store.update(id, { status: "active", coordinatorSessionId: null });
		assert.equal(store.prepareNotice(id, "lead", now), undefined);
		store.update(id, { coordinatorSessionId: "lead" });
		const notice = store.prepareNotice(id, "lead", now)!;
		assert.equal(store.noticeAllowed("lead", notice.requestId), true);
		store.update(id, { coordinatorSessionId: "member" });
		assert.equal(store.noticeAllowed("lead", notice.requestId), false);
		const moved = store.prepareNotice(id, "member", now)!;
		assert.equal(moved.requestId, notice.requestId);
		assert.equal(store.noticeAllowed("member", moved.requestId), true);
		store.leave("member");
		assert.equal(store.noticeAllowed("member", moved.requestId), false);
	} finally {
		store.close();
	}
});

test("rolling hourly cap allows 20 notices, holds excess, and resumes at the exact window boundary", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
	const { store, id } = setup();
	try {
		for (let index = 0; index < 20; index++) {
			store.addComment(id, { text: `notice ${index}` });
			t.mock.timers.tick(30_000);
			const notice = store.prepareNotice(id, "lead", Date.now())!;
			assert.ok(notice, `notice ${index} admitted`);
			store.acknowledgeNotice(notice, Date.now());
		}
		store.addComment(id, { text: "over cap" });
		t.mock.timers.tick(30_000);
		assert.equal(store.prepareNotice(id, "lead", Date.now()), undefined);
		assert.equal(store.noticeDeadlines(Date.now())[0]!.at, 31_000 + NOTICE_WINDOW_MS);
		assert.equal(store.prepareNotice(id, "lead", 31_000 + NOTICE_WINDOW_MS - 1), undefined);
		const resumed = store.prepareNotice(id, "lead", 31_000 + NOTICE_WINDOW_MS)!;
		assert.match(resumed.content, /over cap/);
	} finally {
		store.close();
	}
});

test("delivery waits for idle and archive/active/no-role guards, then retries a lost acknowledgement with the frozen ID", async () => {
	const { store, id } = setup();
	let busy = true;
	let archived = false;
	let fail = true;
	const attempts: { requestId: string; content: string }[] = [];
	const listeners = new Set<(session: SessionSummary) => void>();
	const sessions = {
		list: () => [],
		get: () => ({ archivedAt: archived ? 1 : undefined }),
		onChange: (listener: (session: SessionSummary) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		canSendNotice: () => !busy && !archived,
		sendNotice: async (_id: string, content: string, requestId: string) => {
			attempts.push({ requestId, content });
			if (fail) throw new Error("lost acknowledgement");
			return true;
		},
	} as unknown as SessionManager;
	const delivery = new MissionNotices(store, sessions);
	delivery.start();
	try {
		store.addComment(id, { text: "first" });
		const now = Date.now() + 120_000;
		await delivery.flush(now);
		assert.equal(attempts.length, 0);
		assert.equal(store.pendingNotice(id), undefined, "busy work does not freeze or enqueue a batch");
		busy = false;
		archived = true;
		await delivery.flush(now);
		archived = false;
		store.update(id, { status: "archived" });
		await delivery.flush(now);
		store.update(id, { status: "active", coordinatorSessionId: null });
		await delivery.flush(now);
		assert.equal(attempts.length, 0);
		store.update(id, { coordinatorSessionId: "lead" });
		await delivery.flush(now);
		assert.equal(attempts.length, 1);
		store.addComment(id, { text: "later" });
		fail = false;
		await delivery.flush(now);
		assert.deepEqual(attempts[1], attempts[0]);
		await delivery.flush(now);
		assert.equal(attempts.length, 3);
		assert.match(attempts[2]!.content, /later/);
		assert.equal(store.noticeDeadlines(now).length, 0);
	} finally {
		await delivery.stop();
		store.close();
	}
	assert.equal(listeners.size, 0);
});

test("deleting a mission removes its pending batch and completion dedupe state", () => {
	const { store, id } = setup();
	try {
		store.recordMemberCompletion(completion("done", 1));
		const notice = store.prepareNotice(id, "lead", Date.now() + 30_000)!;
		assert.ok(notice);
		store.remove(id);
		assert.equal(store.noticeAllowed("lead", notice.requestId), false);
		assert.deepEqual(store.noticeDeadlines(Date.now()), []);
		assert.equal(store.pendingNotice(id), undefined);
	} finally {
		store.close();
	}
});

test("large bursts collapse to one latest note without repeated delivery", () => {
	const { store, id } = setup();
	try {
		for (let index = 0; index < 250; index++) store.addComment(id, { text: `comment ${index}` });
		const now = Date.now() + 30_000;
		const notice = store.prepareNotice(id, "lead", now)!;
		assert.equal(notice.content.split("\n").filter((line) => line.startsWith("- ")).length, 1);
		assert.match(notice.content, /comment 249/);
		store.acknowledgeNotice(notice, now);
		assert.deepEqual(store.noticeDeadlines(now), []);
	} finally {
		store.close();
	}
});

test("streaming summary updates do not rescan SQLite or reschedule unchanged lifecycle state", async (t) => {
	const { store, id } = setup();
	let observe!: (session: SessionSummary) => void;
	const sessions = {
		list: () => [],
		get: () => ({ archivedAt: undefined }),
		onChange: (listener: typeof observe) => {
			observe = listener;
			return () => {};
		},
	} as unknown as SessionManager;
	const deadlines = t.mock.method(store, "noticeDeadlines");
	const delivery = new MissionNotices(store, sessions);
	delivery.start();
	try {
		const summary = { ...completion(undefined, 1), outcomeAt: undefined, missionId: id, state: "working" as const };
		observe(summary);
		const scans = deadlines.mock.callCount();
		for (let index = 0; index < 10_000; index++) observe({ ...summary, updatedAt: index });
		assert.equal(deadlines.mock.callCount(), scans);
		assert.equal(store.noticeDeadlines(Date.now()).length, 0);
	} finally {
		await delivery.stop();
		store.close();
	}
});

test("the timer delivers at debounce and shutdown drains admission before storage can close", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
	const { store, id } = setup();
	let release!: () => void;
	const waiting = new Promise<void>((resolve) => {
		release = resolve;
	});
	let admissions = 0;
	const sessions = {
		list: () => [],
		get: () => ({ state: "idle" }),
		onChange: () => () => {},
		canSendNotice: () => true,
		sendNotice: async () => {
			admissions++;
			await waiting;
			return true;
		},
	} as unknown as SessionManager;
	const delivery = new MissionNotices(store, sessions);
	delivery.start();
	try {
		store.addComment(id, { text: "first event" });
		await Promise.resolve();
		t.mock.timers.tick(29_999);
		assert.equal(admissions, 0);
		t.mock.timers.tick(1);
		assert.equal(admissions, 1);
		let stopped = false;
		const stopping = delivery.stop().then(() => {
			stopped = true;
		});
		await Promise.resolve();
		assert.equal(stopped, false, "shutdown waits for the in-flight acknowledgement");
		release();
		await stopping;
		assert.deepEqual(store.noticeDeadlines(Date.now()), []);
		t.mock.timers.tick(120_000);
		assert.equal(admissions, 1);
	} finally {
		release();
		await delivery.stop();
		store.close();
	}
});

test("one working or starting member holds all notices, and the last settlement starts a fresh settle delay", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
	const { store, id } = setup();
	store.join("second", id);
	store.join("parked", id);
	store.join("archived", id);
	store.addTask(id, { title: "Second" });
	store.claimTask(id, "2", "second");
	const chats = new Map<string, SessionSummary>([
		["lead", { ...completion(undefined, 0), id: "lead", missionId: id }],
		["member", { ...completion(undefined, 0), missionId: id, state: "working" }],
		["second", { ...completion(undefined, 0), id: "second", missionId: id, state: "starting" }],
		["outsider", { ...completion(undefined, 0), id: "outsider", state: "working" }],
		["parked", { ...completion(undefined, 0), id: "parked", missionId: id, state: "parked" }],
		["archived", { ...completion(undefined, 0), id: "archived", missionId: id, state: "starting", archivedAt: 1 }],
	]);
	let observe!: (session: SessionSummary) => void;
	const notices: string[] = [];
	const sessions = {
		list: () => [...chats.values()],
		get: (id: string) => chats.get(id),
		onChange: (listener: typeof observe) => {
			observe = listener;
			return () => {};
		},
		canSendNotice: () => chats.get("lead")!.state === "idle",
		sendNotice: async (_id: string, content: string) => {
			notices.push(content);
			return true;
		},
	} as unknown as SessionManager;
	const delivery = new MissionNotices(store, sessions);
	const change = (id: string, state: SessionSummary["state"], outcome?: SessionSummary["outcome"]) => {
		const chat = { ...chats.get(id)!, state, outcome, outcomeAt: Date.now() };
		chats.set(id, chat);
		observe(chat);
	};
	delivery.start();
	try {
		change("member", "idle", "done");
		t.mock.timers.tick(120_000);
		await delivery.flush();
		assert.equal(notices.length, 0);
		change("second", "failed", "failed");
		t.mock.timers.tick(29_000);
		await delivery.flush();
		assert.equal(notices.length, 0);
		change("second", "working");
		t.mock.timers.tick(2_000);
		await delivery.flush();
		assert.equal(notices.length, 0, "an immediate resume cancels settlement");
		change("second", "idle", "done");
		change("lead", "working");
		t.mock.timers.tick(30_000);
		await delivery.flush();
		assert.equal(notices.length, 0, "lead must also be idle, but does not reset member settlement");
		change("lead", "idle");
		await delivery.flush();
		assert.equal(notices.length, 1);
		assert.match(notices[0]!, /#1 Pagination: chat finished/);
		assert.match(notices[0]!, /#2 Second: chat finished/);
		assert.doesNotMatch(notices[0]!, /chat failed/);
		assert.equal(notices[0]!.split("\n").filter((line) => line.startsWith("- ")).length, 2);
		await delivery.flush();
		assert.equal(notices.length, 1);
	} finally {
		await delivery.stop();
		store.close();
	}
});

test("repeated failures collapse with a count, and a later finish supersedes them", () => {
	const { store, id } = setup();
	try {
		store.recordMemberCompletion(completion("failed", 1));
		store.recordMemberCompletion(completion("failed", 2));
		const now = Date.now() + 30_000;
		const failed = store.prepareNotice(id, "lead", now)!;
		assert.match(failed.content, /chat failed twice/);
		assert.equal(failed.content.split("\n").filter((line) => line.startsWith("- ")).length, 1);
		store.acknowledgeNotice(failed, now);
		store.recordMemberCompletion(completion("failed", 3));
		store.recordMemberCompletion(completion("done", 4));
		const done = store.prepareNotice(id, "lead", now + 30_000)!;
		assert.match(done.content, /chat finished/);
		assert.doesNotMatch(done.content, /failed/);
	} finally {
		store.close();
	}
});

test("the cap delivers during sustained member work but never during lead work", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
	const { store, id } = setup();
	const lead = { ...completion(undefined, 0), id: "lead", missionId: id };
	const member = { ...completion(undefined, 0), missionId: id, state: "working" as const };
	let sent = 0;
	const sessions = {
		list: () => [lead, member],
		get: (id: string) => (id === "lead" ? lead : member),
		onChange: () => () => {},
		canSendNotice: () => lead.state === "idle",
		sendNotice: async () => {
			sent++;
			return true;
		},
	} as unknown as SessionManager;
	const delivery = new MissionNotices(store, sessions);
	delivery.start();
	try {
		store.addComment(id, { text: "failure needs attention" });
		t.mock.timers.tick(NOTICE_MAX_DELAY_MS - 1);
		await delivery.flush();
		assert.equal(sent, 0);
		lead.state = "working";
		t.mock.timers.tick(1);
		await delivery.flush();
		assert.equal(sent, 0);
		lead.state = "idle";
		await delivery.flush();
		assert.equal(sent, 1);
	} finally {
		await delivery.stop();
		store.close();
	}
});

test("very large sets of distinct groups produce one bounded notice with an overflow summary", () => {
	const { store, id } = setup();
	try {
		for (let index = 0; index < 250; index++) store.addTask(id, { title: `Blocked ${index}`, status: "blocked" });
		const now = Date.now() + 30_000;
		const notice = store.prepareNotice(id, "lead", now)!;
		assert.equal(notice.content.split("\n").filter((line) => line.startsWith("- ")).length, 101);
		assert.match(notice.content, /150 additional groups/);
		assert.ok(notice.content.length < 51_000);
		store.acknowledgeNotice(notice, now);
		assert.deepEqual(store.noticeDeadlines(now), []);
	} finally {
		store.close();
	}
});

test("legacy queued events migrate into groups, and legacy consumed states do not repeat", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-notice-migration-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const file = join(home, "missions.sqlite");
	const f = setup(new MissionStore(file));
	f.store.recordMemberCompletion(completion("failed", 1));
	f.store.recordMemberCompletion(completion("done", 2));
	f.store.close();
	const legacy = new DatabaseSync(file);
	// Older writers included unchanged PRs in every activity entry.
	legacy.exec("UPDATE events SET text = text || ', PR #12 open' WHERE text LIKE '%chat finished'");
	legacy.exec("DROP TABLE pending_notice_summaries; ALTER TABLE member_completions DROP COLUMN signature");
	legacy.close();
	const store = new MissionStore(file);
	try {
		const now = Date.now() + 30_000;
		const notice = store.prepareNotice(f.id, "lead", now)!;
		assert.equal(notice.content.split("\n").filter((line) => line.startsWith("- ")).length, 1);
		assert.match(notice.content, /chat finished/);
		assert.doesNotMatch(notice.content, /failed/);
		store.acknowledgeNotice(notice, now);
		store.recordMemberCompletion(completion("done", 3));
		assert.deepEqual(store.noticeDeadlines(now), []);
	} finally {
		store.close();
	}
});
