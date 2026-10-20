import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BackgroundJobDiagnostics, jobConfigurationKey } from "./background-job-diagnostics.ts";
import type { TrackedItemStore } from "./tracked-items.ts";
import { TrackedItemDisk } from "./tracked-items-disk.ts";
import { GUIDE_SCHEMA, parseGuide, TriageGroomer } from "./triage-grooming.ts";
import { TriageGuideDisk } from "./triage-guide-disk.ts";

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
	assert.equal(
		store.input("p", "linear").corrections.length,
		64,
		"grooming consumes bounded batches, not the whole retained history",
	);
	assert.equal(store.context("p", "linear").corrections.length, 5);
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

test("grooming admission persists five-minute spacing and 48-attempt UTC day cap", () => {
	const disk = new TrackedItemDisk(":memory:");
	try {
		const start = Date.parse("2026-10-15T00:00:00Z");
		assert.equal(disk.triage.reserve("p", "slack", start), 0);
		assert.equal(disk.triage.reserve("p", "slack", start + 1), start + 300_000);
		for (let i = 1; i < 48; i++) assert.equal(disk.triage.reserve("p", "slack", start + i * 300_000), 0);
		assert.equal(disk.triage.reserve("p", "slack", start + 48 * 300_000), start + 86_400_000);
		assert.equal(disk.triage.reserve("p", "linear", start), 0);
		assert.equal(disk.triage.reserve("p", "slack", start + 86_400_000), 0);
	} finally {
		disk.close();
	}
});

test("one new correction runs daily without requiring further store events", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100_000 });
	const disk = new TrackedItemDisk(":memory:");
	t.after(() => disk.close());
	disk.triage.append("p", "linear", {
		itemId: "invented",
		summary: "Repair export",
		correctedAt: 100_000,
		values: { size: "quick_fix" },
	});
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
	const groomer = new TriageGroomer(projects as never, items, async () => {
		calls++;
		return '{"rules":["Localized repairs are quick fixes."]}';
	});
	const drain = async () => {
		for (let i = 0; i < 20; i++) await Promise.resolve();
	};
	t.mock.timers.tick(2000);
	await drain();
	t.mock.timers.tick(0);
	await drain();
	assert.equal(calls, 0);
	t.mock.timers.tick(86_400_000);
	await drain();
	assert.equal(calls, 1);
	assert.equal(disk.triage.input("p", "linear").corrections.length, 0);
	await groomer.stop();
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
	const diagnostics = new BackgroundJobDiagnostics();
	const groomer = new TriageGroomer(
		projects as never,
		items,
		async (cwd, prompt, schema) => {
			calls++;
			assert.equal(cwd, "/invented");
			assert.deepEqual(schema, GUIDE_SCHEMA);
			assert.match(prompt, /Export unavailable/);
			assert.doesNotMatch(prompt, /untrustedSlackThread/);
			disk.triage.append("p", "slack", correction);
			return '{"rules":["Export failures are bugs."]}';
		},
		Date.now,
		diagnostics,
	);
	groomer.queue("p");
	groomer.queue("p");
	t.mock.timers.tick(1999);
	assert.equal(calls, 0);
	t.mock.timers.tick(1);
	// Drain the finite async chain without wall-clock timing.
	for (let i = 0; i < 12; i++) await Promise.resolve();
	assert.equal(calls, 1);
	const health = diagnostics.read("triage_rebuild", "slack", "p", jobConfigurationKey(undefined));
	assert.equal(health.observation?.outcome, "success");
	assert.equal(health.observation?.stage, "commit");
	assert.doesNotMatch(JSON.stringify(health), /Export|rules|untrustedSlackThread/);
	assert.equal(calls, 1, "diagnostic inspection never invokes completion");
	assert.equal(disk.triage.guide("p", "slack").text, "Export failures are bugs.");
	assert.equal(disk.triage.input("p", "slack").corrections.length, 1);
	await groomer.stop();
});
