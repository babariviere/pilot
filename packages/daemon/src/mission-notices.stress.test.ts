import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "@pilot/protocol";
import { MissionStore } from "./missions.ts";

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

test("10,000 failed outcomes retain one bounded summary, without loading raw events into JavaScript", (t) => {
	const { store, id } = setup();
	try {
		for (let index = 1; index <= 10_000; index++) store.recordMemberCompletion(completion("failed", index));
		const start = performance.now();
		const now = Date.now() + 30_000;
		const notice = store.prepareNotice(id, "lead", now)!;
		t.diagnostic(`Grouped 10,000 events in ${(performance.now() - start).toFixed(1)} ms`);
		assert.match(notice.content, /chat failed 10000 times/);
		assert.ok(notice.content.length < 1_000);
		store.acknowledgeNotice(notice, now);
		assert.deepEqual(store.noticeDeadlines(now), []);
	} finally {
		store.close();
	}
});

test("10,000 job-wait outcomes retain the run snapshot without creating events or pending work", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
	const { store, id } = setup();
	try {
		const job = { id: "tests", name: "Tests", state: "running" as const, startedAt: 1, outputPath: "/tmp/tests.log" };
		store.recordMemberRun(completion(undefined, 0));
		const before = store.events(id).length;
		const start = performance.now();
		for (let index = 1; index <= 10_000; index++)
			store.recordMemberCompletion({ ...completion("done", index), runningJobs: [job] });
		t.diagnostic(`Ignored 10,000 job outcomes in ${(performance.now() - start).toFixed(1)} ms`);
		assert.equal(store.events(id).length, before);
		assert.deepEqual(store.noticeDeadlines(Date.now() + 24 * 60 * 60_000), []);
		store.updateTask(id, "1", { status: "done" });
		// The completed task must still belong to this run when the follow-up finishes.
		store.recordMemberCompletion(completion("done", 10_001));
		const notice = store.prepareNotice(id, "lead", Date.now() + 30_000)!;
		assert.match(notice.content, /#1 Pagination: chat finished, PR #12 open/);
		assert.doesNotMatch(notice.content, /waiting|running job/);
		store.acknowledgeNotice(notice, Date.now() + 30_000);
		assert.deepEqual(store.noticeDeadlines(Date.now() + 24 * 60 * 60_000), []);
	} finally {
		store.close();
	}
});
