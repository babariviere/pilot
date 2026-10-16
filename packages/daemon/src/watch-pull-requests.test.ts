import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionPullRequest } from "@pilot/protocol";
import { WatchService } from "./watch-service.ts";
import { PullRequestWatchSource } from "./watch-pull-requests.ts";
import type { WatchNotice } from "./watch-delivery.ts";
const pr: SessionPullRequest = {
	url: "https://github.com/o/r/pull/1",
	number: 1,
	title: "Change",
	state: "open",
	checkedAt: 1,
};
test("standalone PR registration shares linked tracker targets and removes canceled subscriptions", async () => {
	const s = new WatchService(":memory:");
	const refresh: string[] = [];
	const source = new PullRequestWatchSource(s, "/tmp", (t) => refresh.push(t.url));
	try {
		await source.idle();
		const w = await s.add({
			event: "pr.merged",
			target: { kind: "pr", id: pr.url },
			mode: "persistent",
			note: "Continue",
		});
		await source.idle();
		assert.deepEqual(refresh, [pr.url]);
		assert.equal([...source.targets()].length, 1);
		await s.remove(w.id);
		await source.idle();
		assert.equal([...source.targets()].length, 0);
	} finally {
		await source.stop();
		await s.close();
	}
});
test("PR transitions baseline without firing, dedupe refreshes, distinguish close/merge and require positive readiness", async () => {
	const s = new WatchService(":memory:");
	const source = new PullRequestWatchSource(s, "/tmp", () => {});
	const notices: WatchNotice[] = [];
	try {
		for (const event of ["pr.ready", "pr.merged", "pr.closed"] as const)
			await s.add({ event, target: { kind: "pr", id: pr.url }, mode: "persistent", note: event });
		await s.add({ event: "pr.merged", target: { kind: "chat_prs", id: "creator" }, mode: "once", note: "Creator" });
		source.openedBy("creator", [pr]);
		s.bindSink({
			sessionId: "control",
			canSend: () => true,
			deliver: async (n) => {
				notices.push(n);
				return true;
			},
		});
		assert.equal(await source.observe(pr), 0);
		assert.equal(await source.observe({ ...pr, checkedAt: 2 }), 0);
		assert.equal(await source.observe({ ...pr, readiness: { state: "pending", reasons: [], checkedAt: 3 } }), 0);
		assert.equal(await source.observe({ ...pr, readiness: { state: "ready", reasons: [], checkedAt: 4 } }), 1);
		assert.equal(await source.observe({ ...pr, readiness: { state: "ready", reasons: [], checkedAt: 5 } }), 0);
		assert.equal(await source.observe({ ...pr, state: "closed" }), 1);
		assert.equal(await source.observe({ ...pr, state: "merged" }), 2);
		await s.flush(Date.now() + 60000);
		assert.equal(notices[0]!.items.length, 4);
		assert.equal(notices[0]!.items.filter((i) => i.event === "pr.merged").length, 2);
	} finally {
		await source.stop();
		await s.close();
	}
});
