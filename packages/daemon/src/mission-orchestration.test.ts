import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSummary } from "@pilot/protocol";
import { MissionNotices } from "./mission-notices.ts";
import { MissionStore, NOTICE_DEBOUNCE_MS } from "./missions.ts";
import { noticeDeadline } from "./notice-dispatcher.ts";
import type { SessionManager } from "./sessions.ts";

const record = { commit: "a".repeat(40), checks: "Unit tests passed, covers the changed parser.", issues: "" };

test("offline parked-coordinator replay reduces cold admissions and synthetic preparations from eight to one", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
	const { store, id } = setup();
	let legacyRelaunches = 0;
	let relaunches = 0;
	let preparations = 0;
	const sessions = {
		list: () => [],
		get: (sessionId: string) => ({ id: sessionId, state: "idle", missionId: id }) as SessionSummary,
		onChange: () => () => {},
		canSendNotice: () => true,
		sendNotice: async (_sessionId: string, content: string) => {
			// The synthetic sink models a coordinator parked again after each admission.
			relaunches++;
			preparations++;
			for (let i = 0; i < 8; i++) assert.match(content, new RegExp(`Request ${i}`));
			return true;
		},
	} as unknown as SessionManager;
	const delivery = new MissionNotices(store, sessions);
	delivery.start();
	try {
		for (let i = 0; i < 8; i++) {
			t.mock.timers.tick(1000);
			store.addComment(id, { text: `Request ${i}` }, { sessionId: "member" });
			if (
				noticeDeadline(
					{
						firstAt: Date.now(),
						lastAt: Date.now(),
						idleAt: Date.now(),
						busy: false,
						retry: false,
						immediateWhenIdle: true,
					},
					Date.now(),
				) <= Date.now()
			)
				legacyRelaunches++;
			await delivery.flush();
		}
		assert.equal(relaunches, 0);
		t.mock.timers.tick(NOTICE_DEBOUNCE_MS);
		await delivery.flush();
		assert.deepEqual(
			{ legacyRelaunches, relaunches, preparations },
			{ legacyRelaunches: 8, relaunches: 1, preparations: 1 },
		);
		await delivery.flush();
		assert.equal(relaunches, 1);
	} finally {
		await delivery.stop();
		store.close();
	}
});

function setup(store = new MissionStore(":memory:")) {
	const { id } = store.create({
		projectId: "synthetic-project",
		title: "Synthetic mission",
		tasks: [{ title: "One" }, { title: "Two" }],
	});
	store.join("lead", id);
	store.join("member", id);
	store.update(id, { coordinatorSessionId: "lead" });
	store.claimTask(id, "1", "member");
	return { store, id };
}

test("completion is immutable, bounded, referenced once and retires admission durably", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-completion-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const path = join(home, "missions.sqlite");
	const { store, id } = setup(new MissionStore(path));
	const task = store.resolveTask(id, "1");
	assert.throws(() => store.updateTask(id, task.id, { status: "done" }, { sessionId: "member" }), /Use complete/);
	for (const invalid of [
		{ ...record, checks: "x".repeat(2001) },
		{ ...record, issues: "x".repeat(1001) },
		{ ...record, commit: "short" },
		{ ...record, extra: "unneeded" },
	]) {
		assert.throws(() => store.completeTask(id, task.id, "member", invalid));
	}
	assert.equal(store.resolveTask(id, "1").status, "in_progress");
	const before = store.events(id).length;
	assert.deepEqual(store.completeTask(id, "1", "member", record), record);
	assert.deepEqual(store.completeTask(id, task.id, "member", record), record);
	assert.equal(store.events(id).length, before + 1);
	assert.equal(store.retiredMember("member"), true);
	assert.throws(() => store.completeTask(id, "1", "member", { ...record, checks: "Changed" }), /already has/);
	assert.throws(() => store.claimTask(id, "2", "member"), /retired/);
	assert.throws(() => store.claimTasks(id, ["2"], "member"), /retired/);
	assert.throws(() => store.updateTask(id, "2", { sessionId: "member" }), /retired/);
	assert.throws(() => store.addTask(id, { title: "Another", sessionId: "member" }), /retired/);
	const notice = store.prepareNotice(id, "lead", Date.now())!;
	assert.ok(notice);
	assert.equal(notice.event.kind, "mission_task_done");
	assert.match(notice.content, /Task #1 done/);
	assert.doesNotMatch(notice.content, /parser|aaaaaaa/);
	store.recordMemberCompletion({
		id: "member",
		state: "idle",
		outcome: "done",
		outcomeAt: Date.now() + 1,
		createdAt: 0,
	} as Parameters<MissionStore["recordMemberCompletion"]>[0]);
	assert.equal(store.events(id).length, before + 1, "settlement does not duplicate delivery");
	await store.durable();
	store.close();
	const restored = new MissionStore(path);
	try {
		assert.deepEqual(restored.completion(id, task.id), record);
		assert.equal(restored.retiredMember("member"), true);
		assert.throws(() => restored.claimTask(id, "2", "member"), /retired/);
		restored.join("fresh-member", id);
		restored.claimStartTasks(id, ["2"], "fresh-member");
		assert.equal(restored.resolveTask(id, "2").sessionId, "fresh-member");
		restored.releaseTask(id, "2");
		restored.updateTask(id, "2", { sessionId: "member", overrideRetirement: true });
		assert.equal(restored.retiredMember("member"), false);
	} finally {
		restored.close();
	}
});

test("idle comment replay batches N wakes into one and retains all N across restart and park", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
	const home = await mkdtemp(join(tmpdir(), "pilot-comment-batch-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const path = join(home, "missions.sqlite");
	const { store, id } = setup(new MissionStore(path));
	store.setNoticeActivity(id, false, Date.now());
	for (let i = 0; i < 8; i++) {
		t.mock.timers.tick(1000);
		store.addComment(id, { text: `Question ${i}` }, { sessionId: "member" });
		assert.equal(store.prepareNotice(id, "lead", Date.now()), undefined);
	}
	store.addComment(id, { text: "ACK" }, { sessionId: "member" });
	store.addComment(id, { text: "Evidence retained", notification: "informational" }, { sessionId: "member" });
	store.addComment(id, { text: "Own write" }, { sessionId: "lead" });
	await store.durable();
	store.close();
	const restored = new MissionStore(path);
	try {
		t.mock.timers.tick(NOTICE_DEBOUNCE_MS);
		const notice = restored.prepareNotice(id, "lead", Date.now())!;
		for (let i = 0; i < 8; i++) assert.match(notice.content, new RegExp(`Question ${i}`));
		assert.doesNotMatch(notice.content, /ACK|Evidence retained|Own write/);
		restored.setNoticeActivity(id, true, Date.now());
		assert.equal(restored.prepareNotice(id, "lead", Date.now()), undefined);
		restored.setNoticeActivity(id, false, Date.now());
		t.mock.timers.tick(NOTICE_DEBOUNCE_MS);
		assert.deepEqual(restored.prepareNotice(id, "lead", Date.now()), notice, "frozen batch survives wake and park");
		restored.addComment(id, { text: "After cutoff" }, { sessionId: "member" });
		restored.acknowledgeNotice(notice, Date.now());
		t.mock.timers.tick(NOTICE_DEBOUNCE_MS);
		const next = restored.prepareNotice(id, "lead", Date.now())!;
		assert.match(next.content, /After cutoff/);
		assert.doesNotMatch(next.content, /Question 0/);
		restored.acknowledgeNotice(next, Date.now());
		assert.deepEqual(restored.noticeDeadlines(Date.now()), []);
		t.diagnostic(
			"Eight-comment synthetic replay: legacy idle policy 8 wake/context-preparation opportunities; batched policy 1. Not real provider calls or measured cost.",
		);
	} finally {
		restored.close();
	}
});

test("ACK-only writes do not wake; blockers and needs-you bypass routine settlement", () => {
	const { store, id } = setup();
	try {
		store.setNoticeActivity(id, true, Date.now());
		store.addComment(id, { text: "Thanks!" }, { sessionId: "member" });
		store.addComment(id, { text: "Receipt", notification: "ack" }, { sessionId: "member" });
		assert.deepEqual(store.noticeDeadlines(Date.now()), []);
		store.updateTask(id, "1", { status: "blocked" }, { sessionId: "member" });
		const blocked = store.prepareNotice(id, "lead", Date.now())!;
		assert.ok(blocked, "blocked work wakes immediately even with another busy member");
		store.acknowledgeNotice(blocked, Date.now());
		store.addComment(id, { text: "Need a decision", notification: "urgent" }, { sessionId: "member" });
		assert.ok(store.prepareNotice(id, "lead", Date.now()));
	} finally {
		store.close();
	}
});
