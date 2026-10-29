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
		assert.throws(() => reopened.completeTask(id, task.id, "member", delivery), /commit/);
	} finally {
		reopened.close();
	}
});

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

test("feedback claims have a durable two-task lifetime allowance, excluding starting assignments", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-feedback-claims-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const path = join(home, "missions.sqlite");
	const { store, id } = setup(new MissionStore(path));
	store.completeTask(id, "1", "member", record);
	const first = store.addTask(id, { title: "User feedback" }, { sessionId: "member" });
	store.claimTask(id, first.id, "member");
	store.claimTask(id, first.id, "member"); // Idempotent, not a second claim.
	store.completeTask(id, first.id, "member", record);
	const second = store.addTask(id, { title: "More feedback" }, { sessionId: "member" });
	store.claimTask(id, second.id, "member");
	store.releaseTask(id, second.id, { sessionId: "member" });
	store.claimTask(id, second.id, "member"); // Reclaiming the same task is free.
	store.releaseTask(id, second.id);
	store.removeTask(id, first.id);
	store.removeTask(id, second.id);
	const third = store.addTask(id, { title: "Third feedback" }, { sessionId: "member" });
	const before = store.events(id).length;
	assert.throws(() => store.claimTask(id, third.id, "member"), /two additional tasks/);
	assert.equal(store.events(id).length, before);
	assert.equal(store.task(id, third.id).sessionId, undefined);
	const batch = store.claimTasks(id, [third.id, third.id], "member");
	assert.equal(batch.claimed.length, 0);
	assert.equal(batch.skipped.length, 1);
	assert.match(batch.skipped[0]!.reason, /fresh chat/);
	await store.durable();
	store.close();

	const restored = new MissionStore(path);
	try {
		assert.throws(() => restored.claimTask(id, third.id, "member"), /two additional tasks/);
		restored.continueSession("member", "continued");
		assert.throws(() => restored.claimTask(id, third.id, "continued"), /two additional tasks/);
		// Neither a user retirement override nor a mission move resets lifetime admission.
		restored.updateTask(id, "2", { sessionId: "continued", overrideRetirement: true });
		restored.releaseTask(id, "2");
		assert.throws(() => restored.claimTask(id, third.id, "continued"), /two additional tasks/);
		const other = restored.create({ projectId: "synthetic-project", title: "Another mission" });
		restored.join("continued", other.id);
		const task = restored.addTask(other.id, { title: "Feedback elsewhere" }, { sessionId: "continued" });
		assert.throws(() => restored.claimTask(other.id, task.id, "continued"), /two additional tasks/);
		restored.leave("continued");
		restored.continueSession("continued", "detached-continuation");
		restored.join("detached-continuation", other.id);
		assert.throws(() => restored.claimTask(other.id, task.id, "detached-continuation"), /two additional tasks/);
	} finally {
		restored.close();
	}
});

test("batch claims spend only available slots and leave coordinator assignments unrestricted", (t) => {
	const { store, id } = setup();
	t.after(() => store.close());
	const tasks = Array.from({ length: 4 }, (_, i) =>
		store.addTask(id, { title: `Follow-up ${i}` }, { sessionId: "member" }),
	);
	const batch = store.claimTasks(
		id,
		tasks.map((task) => task.id),
		"member",
	);
	assert.deepEqual(
		batch.claimed.map((task) => task.id),
		tasks.slice(0, 2).map((task) => task.id),
	);
	assert.equal(batch.skipped.length, 2);
	assert.ok(batch.skipped.every((item) => /two additional tasks/.test(item.reason)));
	const lead = store.claimTasks(
		id,
		tasks.slice(2).map((task) => task.id),
		"lead",
	);
	assert.equal(lead.claimed.length, 2);
	const fresh = store.addTask(id, { title: "Starting assignment" });
	store.join("fresh", id);
	store.claimStartTasks(id, [fresh.id, "2"], "fresh");
	const more = Array.from({ length: 3 }, (_, i) => store.addTask(id, { title: `Extra ${i}` }));
	const extras = store.claimTasks(
		id,
		more.map((task) => task.id),
		"fresh",
	);
	assert.equal(extras.claimed.length, 2);
	assert.equal(extras.skipped.length, 1);
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
		assert.equal(result.claimed.length, 2);
		assert.equal(result.skipped.length, 1);
		assert.match(result.skipped[0]!.reason, /two additional tasks/);
	} finally {
		restored.close();
	}
});
