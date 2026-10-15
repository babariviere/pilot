import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { TrackedItemDisk } from "./tracked-items-disk.ts";
import type { TrackedItemStore } from "./tracked-items.ts";
import { TriageGuideDisk } from "./triage-guide-disk.ts";
import { GUIDE_SCHEMA, parseGuide, TriageGroomer } from "./triage-grooming.ts";

test("generic correction store migrates legacy history once and keeps 500 per project across sources", () => {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE slack_corrections(seq INTEGER PRIMARY KEY,project_id TEXT,value TEXT)");
	const value = { itemId: "invented", summary: "Export unavailable", correctedAt: 1, values: { type: "bug" } };
	db.prepare("INSERT INTO slack_corrections VALUES(1,'p',?)").run(JSON.stringify(value));
	let store = new TriageGuideDisk(db);
	assert.deepEqual(store.corrections("p", "slack"), [value]);
	store = new TriageGuideDisk(db);
	assert.equal(store.corrections("p", "slack").length, 1);
	for (let i = 0; i < 505; i++)
		store.append("p", "linear", { ...value, itemId: String(i), values: { size: "quick_fix" } });
	assert.equal(store.corrections("p", "slack").length, 0);
	assert.equal(store.corrections("p", "linear").length, 500);
	assert.deepEqual(store.corrections("other", "linear"), []);
	const input = store.input("p", "linear");
	store.save("p", "linear", "Small export repairs are quick fixes.", input.throughSeq, 0, 100);
	store.save("p", "linear", "stale", input.throughSeq, 0, 200);
	assert.equal(store.guide("p", "linear").updatedAt, 100);
	assert.equal(store.input("p", "linear").corrections.length, 0);
	db.close();
});

test("guide output is strict bounded plain text", () => {
	assert.equal(parseGuide('{"rules":["Export failures are bugs."]}'), "Export failures are bugs.");
	for (const value of [
		"{}",
		'{"rules":[],"extra":1}',
		"```json\n{}\n```",
		JSON.stringify({ rules: Array(41).fill("x") }),
		JSON.stringify({ rules: ["x\ny"] }),
	])
		assert.throws(() => parseGuide(value));
});

test("debounced grooming uses only corrections, folds guide and leaves new corrections pending", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100_000 });
	const disk = new TrackedItemDisk(":memory:");
	t.after(() => disk.close());
	const correction = {
		itemId: "invented",
		summary: "Export unavailable",
		correctedAt: 100_000,
		values: { type: "bug" },
	};
	for (let i = 0; i < 3; i++) disk.triage.append("p", "slack", correction);
	const items = {
		onChange: () => () => {},
		triageInput: async (id: string, kind: "slack" | "linear") => disk.triage.input(id, kind),
		saveGuide: async (...args: Parameters<TriageGuideDisk["save"]>) => disk.triage.save(...args),
	} as unknown as TrackedItemStore;
	const projects = {
		list: () => [{ id: "p", path: "/invented" }],
		require: () => ({ id: "p", path: "/invented" }),
		onChange: () => () => {},
	};
	let calls = 0;
	const groomer = new TriageGroomer(projects as never, items, async (cwd, prompt, schema) => {
		calls++;
		assert.equal(cwd, "/invented");
		assert.deepEqual(schema, GUIDE_SCHEMA);
		assert.match(prompt, /Export unavailable/);
		assert.doesNotMatch(prompt, /untrustedSlackThread/);
		disk.triage.append("p", "slack", correction);
		return '{"rules":["Export failures are bugs."]}';
	});
	groomer.queue("p");
	groomer.queue("p");
	t.mock.timers.tick(1999);
	assert.equal(calls, 0);
	t.mock.timers.tick(1);
	// Drain the finite async chain without wall-clock timing.
	for (let i = 0; i < 12; i++) await Promise.resolve();
	assert.equal(calls, 1);
	assert.equal(disk.triage.guide("p", "slack").text, "Export failures are bugs.");
	assert.equal(disk.triage.input("p", "slack").corrections.length, 1);
	await groomer.stop();
});
