import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionJob, SessionSummary } from "@pilot/protocol";
import { LONG_JOB_MS, LongJobTimers, longJobAttention } from "./long-jobs.ts";
import { MissionNotices } from "./mission-notices.ts";
import { MissionStore } from "./missions.ts";
import type { SessionManager } from "./sessions.ts";

const job: SessionJob = {
	id: "tests",
	name: "Tests",
	state: "running",
	startedAt: 1_000,
	outputPath: "/tmp/tests.log",
};

test("fixed one-hour boundary, bounded names and elapsed duration", () => {
	assert.equal(longJobAttention([job], job.startedAt + LONG_JOB_MS - 1), undefined);
	assert.deepEqual(longJobAttention([job], job.startedAt + LONG_JOB_MS), {
		attentionReason: { kind: "long_job", detail: "Tests has run for 1h" },
		attentionAt: 1_000 + LONG_JOB_MS,
	});
	assert.equal(
		longJobAttention([job], job.startedAt + LONG_JOB_MS * 2 + 17 * 60_000)?.attentionReason.detail,
		"Tests has run for 2h 17m",
	);
	assert.equal(
		longJobAttention([{ ...job, name: "\n  Tests\ntrace" }], LONG_JOB_MS + 1_000)?.attentionReason.detail,
		"Tests has run for 1h",
	);
	assert.ok(
		longJobAttention([{ ...job, name: "x".repeat(5_000) }], LONG_JOB_MS + 1_000)!.attentionReason.detail!.length <=
			200,
	);
	for (const startedAt of [NaN, Infinity, -1, LONG_JOB_MS * 10])
		assert.equal(longJobAttention([{ ...job, startedAt }], LONG_JOB_MS), undefined);
});

test("one-shot deadline survives duplicate changes, swaps oldest jobs, cancels and disposes", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
	const timers = new LongJobTimers();
	let changes = 0;
	const changed = () => changes++;
	const later = { ...job, id: "build", startedAt: 61_000 };
	timers.update("s", [later, job], changed);
	for (let i = 0; i < 10_000; i++) timers.update("s", [job, later], changed);
	// biome-ignore lint/complexity/useLiteralKeys: inspect private timer ownership in the regression test
	assert.equal(timers["pending"].size, 1);
	t.mock.timers.tick(LONG_JOB_MS - 1);
	assert.equal(changes, 0);
	t.mock.timers.tick(1);
	assert.equal(changes, 1);
	timers.update("s", [job, later], changed);
	// biome-ignore lint/complexity/useLiteralKeys: inspect private timer ownership in the regression test
	assert.equal(timers["pending"].size, 0, "overdue jobs do not leave polling timers");
	timers.update("s", [later], changed);
	// biome-ignore lint/complexity/useLiteralKeys: inspect private timer ownership in the regression test
	assert.equal(timers["pending"].size, 1);
	t.mock.timers.tick(60_000);
	assert.equal(changes, 2);
	timers.update("s", [{ ...later, startedAt: Date.now() }], changed);
	timers.update("s", [], changed);
	t.mock.timers.tick(LONG_JOB_MS);
	assert.equal(changes, 2, "ended/stopped jobs cancel their deadline");
	timers.update("s", [{ ...job, startedAt: Date.now() }], changed);
	timers.close();
	t.mock.timers.tick(LONG_JOB_MS);
	assert.equal(changes, 2);
});

test("a long-job attention event creates no mission event or coordinator input", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
	const store = new MissionStore(":memory:");
	const mission = store.create({ projectId: "p", title: "Release" });
	store.join("lead", mission.id);
	store.join("member", mission.id);
	store.update(mission.id, { coordinatorSessionId: "lead" });
	let member: SessionSummary = {
		id: "member",
		title: "Chat",
		cwd: "/tmp",
		state: "idle",
		working: true,
		createdAt: 0,
		updatedAt: 0,
		missionId: mission.id,
		runningJobs: [job],
	};
	const lead = { ...member, id: "lead", working: false, runningJobs: undefined };
	let observe!: (session: SessionSummary) => void;
	let sent = 0;
	const sessions = {
		list: () => [lead, member],
		get: (id: string) => (id === "lead" ? lead : member),
		onChange: (listener: typeof observe) => {
			observe = listener;
			return () => {};
		},
		canSendNotice: () => true,
		sendNotice: async () => {
			sent++;
			return true;
		},
	} as unknown as SessionManager;
	const notices = new MissionNotices(store, sessions);
	const timers = new LongJobTimers();
	try {
		notices.start();
		const events = store.events(mission.id);
		timers.update(member.id, [job], () => {
			member = { ...member, ...longJobAttention([job]) };
			observe(member);
		});
		t.mock.timers.tick(LONG_JOB_MS);
		await notices.flush();
		assert.equal(member.attentionReason?.kind, "long_job");
		assert.equal(member.working, true);
		assert.equal(member.outcome, undefined);
		assert.deepEqual(store.events(mission.id), events);
		assert.deepEqual(store.noticeDeadlines(Date.now()), []);
		assert.equal(sent, 0);
	} finally {
		timers.close();
		await notices.stop();
		store.close();
	}
});
