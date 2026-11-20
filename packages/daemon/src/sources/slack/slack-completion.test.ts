import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { SessionPullRequest } from "@pilot/protocol";
import { type TrackedInput, TrackedItemStore } from "../tracking/tracked-items.ts";

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
		for (const itemId of [id, done, dismissed]) {
			assert.equal((await store.require(itemId)).slack?.status, "open");
			assert.equal((await store.require(itemId)).slack?.doneReason, undefined);
		}
	} finally {
		await store.close();
		await rm(home, { recursive: true, force: true });
	}
});

test("migration keeps legacy and historical links", async () => {
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
		await store.close();
		store = new TrackedItemStore(path);
		for (const id of ["legacy", "history"]) assert.equal((await store.require(id)).slack?.status, "in_progress");
		assert.deepEqual((await store.require("history")).sessionIds, ["chat", "newer"]);
		assert.deepEqual((await store.slackLinkedSessions("p", ["chat", "newer"])).sort(), ["chat", "newer"]);
		await store.patch("history", { slack: { status: "open" }, sessionId: null });
		assert.equal((await store.require("history")).sessionIds, undefined, "unlink removes the indexed association");
		assert.equal((await store.require("history")).slack?.status, "open");
	} finally {
		await store.close();
		await rm(home, { recursive: true, force: true });
	}
});

test("only the user marks a report tackled", async () => {
	const store = new TrackedItemStore(":memory:");
	try {
		const id = await linked(store);
		await assert.rejects(store.agentSlackStatus("chat", "done"), /Only the user/);
		await store.patch(id, { slack: { status: "done" } });
		assert.equal((await store.require(id)).slack?.status, "done");
	} finally {
		await store.close();
	}
});

test("legacy completion and label closure evidence remains readable without migration or replay", async () => {
	const home = await mkdtemp(join(tmpdir(), "slack-legacy-evidence-"));
	const path = join(home, "items.sqlite");
	let store = new TrackedItemStore(path);
	try {
		const id = await linked(store);
		const labelId = await linked(store, "legacy-label");
		await store.close();
		const db = new DatabaseSync(path);
		const done = { attemptedAt: 10, outcome: "reacted", eyesRemoval: { outcome: "removed" } };
		const completion = { reason: "Done · PR #42 merged", mergeDone: { pr: pr().url, at: 20 } };
		db.prepare("UPDATE tracked_items SET slack_status='done', slack_done=?, slack_completion=? WHERE id=?").run(
			JSON.stringify(done),
			JSON.stringify(completion),
			id,
		);
		db.prepare(
			"UPDATE tracked_items SET slack_status='dismissed', dismissed=1, closed_by_label='Product' WHERE id=?",
		).run(labelId);
		db.close();
		store = new TrackedItemStore(path);
		const saved = await store.require(id);
		assert.equal(saved.slack?.status, "done");
		assert.equal(saved.slack?.doneReason, completion.reason);
		assert.deepEqual(saved.metadata.slackDone, done);
		assert.equal(saved.metadata.slackEyesRemoval, undefined, "old eyes removal records load but are ignored");
		assert.deepEqual(saved.metadata.mergeDone, completion.mergeDone);
		const labelSaved = await store.require(labelId);
		assert.equal(labelSaved.slack?.closedByLabel, "Product");
		await store.slackLabelEffects([{ projectId: "p", close: ["Product"] }]);
		assert.deepEqual(await store.require(id), saved);
		assert.deepEqual(await store.require(labelId), labelSaved);
	} finally {
		await store.close();
		await rm(home, { recursive: true, force: true });
	}
});
