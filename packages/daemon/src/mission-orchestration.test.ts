import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
	store.claimStartTasks(id, ["1"], "member");
	return { store, id };
}

test("unaccepted non-code delivery survives reopen and exact retries without completing work", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-delivery-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const path = join(home, "missions.sqlite");
	const { store, id } = setup(new MissionStore(path));
	const task = store.resolveTask(id, "1");
	store.writeBrief(id, "Research findings", 0);
	const delivery = {
		kind: "non-code" as const,
		references: [{ kind: "brief" as const, revision: 1 }],
		checks: "Read sources",
		limitations: "No independent review",
	};
	assert.deepEqual(store.saveNonCodeDelivery(id, task.id, "member", delivery), delivery);
	await store.durable();
	store.close();
	const reopened = new MissionStore(path);
	try {
		assert.deepEqual(reopened.nonCodeDelivery(id, task.id), delivery);
		assert.deepEqual(reopened.saveNonCodeDelivery(id, task.id, "member", delivery), delivery);
		assert.equal(reopened.completion(id, task.id), undefined);
		assert.equal(reopened.task(id, task.id).status, "in_progress");
		assert.equal(reopened.retiredMember("member"), false);
		assert.throws(() => reopened.completeTask(id, task.id, "lead", delivery), /commit/);
	} finally {
		reopened.close();
	}
});

test("coordinator closes tasks without commits durably, without worker delivery or retirement", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-coordinator-closure-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const path = join(home, "missions.sqlite");
	const { store, id } = setup(new MissionStore(path));
	const done = store.updateTask(id, "1", { status: "done" }, { sessionId: "lead" });
	const dropped = store.updateTask(id, "2", { status: "dropped" }, { sessionId: "lead" });
	assert.ok(done.completedAt);
	assert.equal(done.sessionId, "member");
	assert.equal(dropped.completedAt, undefined);
	for (const task of [done, dropped]) assert.equal(store.completion(id, task.id), undefined);
	assert.equal(store.retiredMember("member"), false);
	await store.durable();
	store.close();
	const reopened = new MissionStore(path);
	t.after(() => reopened.close());
	assert.deepEqual(reopened.task(id, done.id), done);
	assert.deepEqual(reopened.task(id, dropped.id), dropped);
	for (const task of [done, dropped]) assert.equal(reopened.completion(id, task.id), undefined);
});

test("commit-free closure authority follows the current coordinator", (t) => {
	const { store, id } = setup();
	t.after(() => store.close());
	store.update(id, { coordinatorSessionId: "member" });
	assert.throws(() => store.updateTask(id, "1", { status: "done" }, { sessionId: "lead" }), /[Cc]oordinator/);
	assert.equal(store.resolveTask(id, "1").status, "in_progress");
	assert.equal(store.updateTask(id, "1", { status: "done" }, { sessionId: "member" }).status, "done");
});

test("completion is immutable, bounded, referenced once and retires admission durably", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-completion-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const path = join(home, "missions.sqlite");
	const { store, id } = setup(new MissionStore(path));
	const task = store.resolveTask(id, "1");
	assert.throws(() => store.updateTask(id, task.id, { status: "done" }, { sessionId: "member" }), /[Cc]oordinator/);
	for (const invalid of [
		{ ...record, checks: "x".repeat(2001) },
		{ ...record, issues: "x".repeat(1001) },
		{ ...record, commit: "short" },
		{ ...record, extra: "unneeded" },
	]) {
		assert.throws(() => store.completeTask(id, task.id, "lead", invalid));
	}
	assert.equal(store.resolveTask(id, "1").status, "in_progress");
	const before = store.events(id).length;
	assert.deepEqual(store.completeTask(id, "1", "lead", record), record);
	assert.deepEqual(store.completeTask(id, task.id, "lead", record), record);
	assert.equal(store.events(id).length, before + 1);
	assert.equal(store.retiredMember("member"), true);
	assert.throws(() => store.completeTask(id, "1", "lead", { ...record, checks: "Changed" }), /already has/);
	assert.throws(() => store.claimTask(id, "2", "member"), /retired/);
	assert.throws(() => store.claimTasks(id, ["2"], "member"), /retired/);
	assert.throws(() => store.updateTask(id, "2", { sessionId: "member" }), /retired/);
	assert.throws(() => store.addTask(id, { title: "Another", sessionId: "member" }), /retired/);
	assert.equal(store.prepareNotice(id, "lead", Date.now()), undefined, "coordinator actions never notify themselves");
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
		store.updateTask(id, "1", { status: "blocked" });
		const blocked = store.prepareNotice(id, "lead", Date.now())!;
		assert.ok(blocked, "blocked work wakes immediately even with another busy member");
		store.acknowledgeNotice(blocked, Date.now());
		store.addComment(id, { text: "Need a decision", notification: "urgent" }, { sessionId: "member" });
		assert.ok(store.prepareNotice(id, "lead", Date.now()));
	} finally {
		store.close();
	}
});

test("workers cannot claim or release canonical assignments across reopen", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-factual-workers-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const path = join(home, "missions.sqlite");
	const { store, id } = setup(new MissionStore(path));
	const worker = { sessionId: "member" };
	for (const call of [
		() => store.claimTask(id, "2", "member", worker),
		() => store.claimTasks(id, ["2"], "member", worker),
		() => store.releaseTask(id, "1", worker),
		() => store.releaseTasks(id, ["1"], worker),
	])
		assert.throws(call, /[Cc]oordinator/);
	await store.durable();
	store.close();
	const restored = new MissionStore(path);
	try {
		assert.throws(() => restored.claimTask(id, "2", "member", worker), /[Cc]oordinator/);
		restored.updateTask(id, "2", { sessionId: "member" }, { sessionId: "lead" });
		assert.equal(restored.resolveTask(id, "2").sessionId, "member");
		assert.equal(restored.releaseTask(id, "1", { sessionId: "lead" }).status, "todo");
	} finally {
		restored.close();
	}
});

test("legacy assignments migrate without consuming follow-up allowance", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-claim-migration-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const path = join(home, "missions.sqlite");
	const { store, id } = setup(new MissionStore(path));
	store.claimTask(id, "2", "member", {});
	await store.durable();
	store.close();
	// Reproduce the pre-allowance schema using only disposable fixture data.
	const legacy = new DatabaseSync(path);
	legacy.exec("DROP TABLE member_task_claims; ALTER TABLE tasks DROP COLUMN created_by_session_id");
	legacy.close();
	const restored = new MissionStore(path);
	try {
		const tasks = Array.from({ length: 3 }, (_, i) => restored.addTask(id, { title: `Follow-up ${i}` }));
		const result = restored.claimTasks(
			id,
			tasks.map((task) => task.id),
			"member",
		);
		assert.equal(result.claimed.length, 3);
		assert.equal(result.skipped.length, 0);
		assert.equal(restored.resolveTask(id, "1").sessionId, "member");
	} finally {
		restored.close();
	}
});
