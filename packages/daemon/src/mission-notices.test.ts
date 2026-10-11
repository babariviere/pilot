import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSummary } from "@pilot/protocol";
import { MissionNotices } from "./mission-notices.ts";
import { MissionStore, NOTICE_WINDOW_MS } from "./missions.ts";
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
		assert.equal(notice.content.split("\n").filter((line) => line.startsWith("- ")).length, 6);
		assert.match(notice.content, /#1 Pagination blocked: Need API access/);
		assert.match(notice.content, /chat finished, PR #12 open/);
		assert.match(notice.content, /chat failed/);
		assert.match(notice.content, /chat stopped/);
		assert.match(notice.content, /Read the mission with get for details/);
		assert.doesNotMatch(notice.content, /own comment|someone else|Still blocked/);
	} finally {
		store.close();
	}
});

test("30-second trailing debounce merges bursts and a continuous burst hits the two-minute cap", (t) => {
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
		assert.equal(store.noticeDeadlines(101_000)[0]!.at, 121_000);
		assert.equal(store.prepareNotice(id, "lead", 120_999), undefined);
		const notice = store.prepareNotice(id, "lead", 121_000)!;
		assert.ok(notice);
		assert.equal(notice.content.split("\n").filter((line) => line.startsWith("- ")).length, 6);
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

test("large bursts produce bounded batches without dropping the remainder", () => {
	const { store, id } = setup();
	try {
		for (let index = 0; index < 250; index++) store.addComment(id, { text: `comment ${index}` });
		const now = Date.now() + 30_000;
		for (const count of [100, 100, 50]) {
			const notice = store.prepareNotice(id, "lead", now)!;
			assert.equal(notice.content.split("\n").filter((line) => line.startsWith("- ")).length, count);
			assert.ok(notice.content.length < 51_000);
			store.acknowledgeNotice(notice, now);
		}
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
