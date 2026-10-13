import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ReviewStore } from "./reviews.ts";

async function home(t: { after(fn: () => Promise<void>): void }) {
	const dir = await mkdtemp(join(tmpdir(), "pilot-reviews-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

test("results are unread until marked, and marks only move forward", async (t) => {
	const store = new ReviewStore(await home(t));
	let changes = 0;
	store.onChange(() => changes++);
	assert.equal(store.isUnread("s", 10), true);
	assert.equal(store.mark([{ sessionId: "s", outcomeAt: 10 }]), true);
	assert.equal(store.isUnread("s", 10), false);
	assert.equal(store.isUnread("s", 11), true);
	// Older or equal marks change nothing and notify nobody.
	assert.equal(store.mark([{ sessionId: "s", outcomeAt: 5 }]), false);
	assert.equal(store.mark([{ sessionId: "s", outcomeAt: 10 }]), false);
	assert.equal(store.isUnread("s", 10), false);
	assert.equal(changes, 1);
	assert.equal(store.mark([{ sessionId: "s", outcomeAt: 20 }]), true);
	assert.equal(store.isUnread("s", 20), false);
	assert.equal(changes, 2);
	await store.flush();
});

test("marks persist across restarts and a damaged file is ignored", async (t) => {
	const dir = await home(t);
	const store = new ReviewStore(dir);
	store.mark([
		{ sessionId: "a", outcomeAt: 1 },
		{ sessionId: "b", outcomeAt: 2 },
	]);
	await store.flush();
	assert.deepEqual(JSON.parse(await readFile(join(dir, "reviews.json"), "utf8")), { a: 1, b: 2 });
	const reopened = new ReviewStore(dir);
	assert.equal(reopened.isUnread("a", 1), false);
	assert.equal(reopened.isUnread("b", 3), true);
	await writeFile(join(dir, "reviews.json"), "{not json");
	const warn = t.mock.method(console, "warn", () => {});
	assert.equal(new ReviewStore(dir).isUnread("a", 1), true);
	assert.equal(warn.mock.callCount(), 1);
});
