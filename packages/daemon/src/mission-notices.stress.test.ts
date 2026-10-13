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
