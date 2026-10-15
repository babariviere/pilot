import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { SessionPullRequest } from "@pilot/protocol";
import { MissionStore } from "./missions.ts";
import { type TrackedInput, TrackedItemStore } from "./tracked-items.ts";

function input(id = "thread", updatedAt = 10): TrackedInput {
	return {
		externalId: id,
		title: "Sample bug",
		url: "https://example.slack.com/archives/CFAKE/p1000000",
		status: "open",
		metadata: { channel: "CFAKE", threadTs: "1.000000", type: "bug" },
		updatedAt,
	};
}
function pr(
	number = 42,
	state: SessionPullRequest["state"] = "open",
	checkedAt = state === "open" ? 10 : 20,
): SessionPullRequest {
	return {
		number,
		url: `https://github.com/example/sample/pull/${number}`,
		title: "Fix bug",
		state,
		checkedAt,
		...(state === "merged" ? { mergedAt: checkedAt } : {}),
	};
}
async function linked(store: TrackedItemStore, id = "thread", projectId = "p", kind: "slack" | "linear" = "slack") {
	await store.commit(projectId, kind, [input(id)]);
	const item = (await store.list({ projectId, kind })).items.find((item) => item.externalId === id)!;
	await store.patch(item.id, { sessionId: "chat", start: true });
	return item.id;
}
function observe(store: TrackedItemStore, prs: SessionPullRequest[], pending = false) {
	return store.observeSlackPullRequests({ projectId: "p", sessionId: "chat", prs, pending });
}

test("a single observed merge marks linked Slack work Done locally and publishes the reason", async () => {
	const store = new TrackedItemStore(":memory:");
	try {
		await store.load(["p"]);
		const id = await linked(store);
		const foreign = await linked(store, "foreign", "other");
		const linear = await linked(store, "issue", "p", "linear");
		assert.equal(await store.reserveSlackStart(id), true);
		await store.slackStartResult(id, "reacted");
		const startOutcome = (await store.require(id)).metadata.slackStart;
		await observe(store, [pr()]);
		let changes = 0;
		store.onChange(() => changes++);
		await observe(store, [pr(42, "merged")]);
		const done = await store.require(id);
		assert.equal(done.slack?.status, "done");
		assert.equal(done.slack?.doneReason, "Done · PR #42 merged");
		assert.equal(done.updatedAt, 10, "PR sync is not message activity");
		assert.equal(done.dismissed, false);
		assert.deepEqual(done.metadata.slackStart, startOutcome, "completion preserves the existing eyes outcome");
		assert.equal(changes, 1);
		assert.equal((done.metadata.mergeDone as { pr: string }).pr, pr().url);
		assert.equal((await store.require(foreign)).slack?.status, "in_progress");
		assert.equal((await store.require(linear)).status, "open");
		assert.equal(
			(await store.inbox({ linear: [], slack: [{ projectId: "p", hidden: [] }], limit: 5 })).slack.total,
			0,
		);
		await observe(store, [pr(42, "merged", 30)]);
		assert.equal(changes, 1, "a fresh timestamp is not another merge");
	} finally {
		await store.close();
	}
});

test("all PRs must merge, including earlier heads, and a closed unmerged PR prevents Done", async () => {
	for (const finalState of ["merged", "closed"] as const) {
		const store = new TrackedItemStore(":memory:");
		try {
			const id = await linked(store);
			await observe(store, [pr(41), pr(42)]);
			await observe(store, [pr(41, "merged"), pr(42)]);
			assert.equal((await store.require(id)).slack?.status, "in_progress");
			await observe(store, [pr(41, "merged"), pr(42, finalState, 30)]);
			assert.equal((await store.require(id)).slack?.status, finalState === "merged" ? "done" : "in_progress");
			assert.equal(
				(await store.require(id)).slack?.doneReason,
				finalState === "merged" ? "Done · PR #42 merged" : undefined,
			);
		} finally {
			await store.close();
		}
	}
	const store = new TrackedItemStore(":memory:");
	try {
		const id = await linked(store);
		await observe(store, [pr()]);
		await observe(store, [pr(42, "merged")], true);
		assert.equal((await store.require(id)).slack?.status, "in_progress", "unknown bound PRs are not merged");
	} finally {
		await store.close();
	}
});

test("Done and Dismissed items are untouched; reopen survives source refresh, timestamp refresh and restart", async () => {
	const home = await mkdtemp(join(tmpdir(), "slack-completion-"));
	const path = join(home, "items.sqlite");
	let store = new TrackedItemStore(path);
	try {
		const id = await linked(store);
		const done = await linked(store, "done"),
			dismissed = await linked(store, "dismissed");
		await store.patch(done, { slack: { status: "done" } });
		await store.patch(dismissed, { dismissed: true });
		const before = [await store.require(done), await store.require(dismissed)];
		await observe(store, [pr()]);
		await observe(store, [pr(42, "merged")]);
		assert.deepEqual([await store.require(done), await store.require(dismissed)], before);
		const metadata = (await store.require(id)).metadata.mergeDone;
		await store.patch(id, { slack: { status: "open" } });
		await store.patch(done, { slack: { status: "open" } });
		await store.patch(dismissed, { dismissed: false });
		await store.commit("p", "slack", [input("thread", 50)]);
		assert.deepEqual(
			(await store.require(id)).metadata.mergeDone,
			metadata,
			"source metadata cannot erase local provenance",
		);
		await store.close();
		store = new TrackedItemStore(path);
		await observe(store, [pr(42, "merged", 60)]);
		for (const itemId of [id, done, dismissed]) {
			assert.equal((await store.require(itemId)).slack?.status, "open");
			assert.equal((await store.require(itemId)).slack?.doneReason, undefined);
		}
	} finally {
		await store.close();
		await rm(home, { recursive: true, force: true });
	}
});

test("a first terminal observation is a silent baseline, even without a merge timestamp", async () => {
	const store = new TrackedItemStore(":memory:");
	try {
		const id = await linked(store);
		const merged = { ...pr(42, "merged"), mergedAt: undefined };
		await observe(store, [merged]);
		await observe(store, [pr(42, "merged", 30)]);
		assert.equal((await store.require(id)).slack?.status, "in_progress");
		await observe(store, [pr(42, "open", 40)]);
		await observe(store, [pr(42, "merged", 50)]);
		assert.equal((await store.require(id)).slack?.status, "in_progress", "replayed stale open cannot invent a merge");
	} finally {
		await store.close();
	}
});

test("migration indexes both legacy and historical links; persisted open observations recover a saved merge", async () => {
	const home = await mkdtemp(join(tmpdir(), "slack-completion-migration-"));
	const path = join(home, "items.sqlite");
	const legacy = new DatabaseSync(path);
	legacy.exec(`CREATE TABLE tracked_items (
		id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, external_id TEXT NOT NULL,
		title TEXT NOT NULL, url TEXT NOT NULL, status TEXT NOT NULL, metadata TEXT NOT NULL,
		dismissed INTEGER NOT NULL DEFAULT 0, session_id TEXT, mission_id TEXT,
		created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, links TEXT,
		UNIQUE(project_id,kind,external_id));
		INSERT INTO tracked_items VALUES ('legacy','p','slack','a','Bug','https://example.com','open','{}',0,'chat',NULL,1,10,NULL);
		INSERT INTO tracked_items VALUES ('history','p','slack','b','Bug','https://example.com','open','{}',0,'newer',NULL,1,10,
		'{"sessions":["chat","newer"],"missions":[]}');`);
	legacy.close();
	let store = new TrackedItemStore(path);
	try {
		await observe(store, [pr()]);
		await store.close();
		store = new TrackedItemStore(path);
		await observe(store, [pr(42, "merged")]);
		for (const id of ["legacy", "history"]) assert.equal((await store.require(id)).slack?.status, "done");
		await store.patch("history", { slack: { status: "open" }, sessionId: null });
		await observe(store, [pr(43)]);
		await observe(store, [pr(43, "merged")]);
		assert.equal((await store.require("history")).slack?.status, "open", "unlink removes the indexed association");
	} finally {
		await store.close();
		await rm(home, { recursive: true, force: true });
	}
});

test("the committed mission completion event closes historical links once, not member PRs or unrelated updates", async () => {
	const missions = new MissionStore(":memory:");
	const store = new TrackedItemStore(":memory:");
	const writes: Promise<void>[] = [];
	const off = missions.onCompleted((project, id, at) => {
		writes.push(store.completeSlackMission(project, id, at));
	});
	try {
		const mission = missions.create({ projectId: "p", title: "Repair", goal: "Fix the sample" });
		const id = await linked(store);
		await store.patch(id, { sessionId: null });
		await store.patch(id, { missionId: mission.id, start: true });
		await store.patch(id, { missionId: "newer-link" });
		await observe(store, [pr()]);
		await observe(store, [pr(42, "merged")]);
		assert.equal((await store.require(id)).slack?.status, "in_progress");
		missions.update(mission.id, { title: "Rename" });
		assert.equal(writes.length, 0);
		missions.update(mission.id, { status: "done" });
		await Promise.all(writes);
		assert.equal((await store.require(id)).slack?.doneReason, "Done · Mission completed");
		await store.patch(id, { slack: { status: "open" } });
		missions.update(mission.id, { title: "Rename again", status: "done" });
		assert.equal(writes.length, 1);
		await store.completeSlackMission("p", mission.id, missions.require(mission.id).completedAt!);
		assert.equal((await store.require(id)).slack?.status, "open", "startup completion replay respects reopening");
	} finally {
		off();
		await store.close();
		missions.close();
	}
});
