import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { validateTrackingConfig } from "./projects.ts";
import { parseSlackClassification } from "./slack-classifier.ts";
import { type TrackedInput, TrackedItemDisk } from "./tracked-items-disk.ts";

const input: TrackedInput = {
	externalId: "C1/1.000001",
	title: "Export crashes",
	url: "https://example.com/message",
	status: "open",
	updatedAt: 1,
	metadata: { type: "bug", label: "Client", severity: "high", confidence: 0.9, channel: "C1" },
};
test("Slack overrides, explicit label clearing and all local statuses survive refresh and restart", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "slack-triage-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const path = join(home, "items.sqlite");
	let disk = new TrackedItemDisk(path);
	disk.commit("p", "slack", [input]);
	const id = disk.list({ projectId: "p" }).items[0]!.id;
	const overrides = { type: "question" as const, label: null, severity: "low" as const, status: "done" as const };
	disk.patch(id, { slack: overrides });
	disk.commit("p", "slack", [
		{
			...input,
			updatedAt: 2,
			metadata: { ...input.metadata, type: "request", label: "Server", severity: "critical" },
		},
	]);
	assert.deepEqual(disk.require(id).slack, { ...overrides, overrides });
	assert.equal(disk.require(id).status, "done");
	assert.equal(disk.require(id).metadata.label, null);
	assert.equal(disk.preview("p", "slack").items[0]!.slack?.type, "question");
	disk.close();
	disk = new TrackedItemDisk(path);
	t.after(() => disk.close());
	assert.deepEqual(disk.require(id).slack, { ...overrides, overrides });
	assert.equal(disk.corrections("p").length, 1);
	disk.patch(id, { sessionId: "linked-only" });
	assert.equal(disk.require(id).status, "done", "ordinary linking does not change status");
	disk.patch(id, { sessionId: "s", start: true });
	assert.equal(disk.require(id).slack?.status, "in_progress");
	disk.patch(id, { slack: { status: "dismissed" } });
	assert.equal(disk.list({ projectId: "p" }).total, 0);
	assert.equal(disk.list({ projectId: "p", dismissed: true }).total, 1);
	disk.patch(id, { dismissed: false });
	assert.equal(disk.require(id).status, "open");
	disk.patch(id, { missionId: "m", start: true });
	assert.equal(disk.require(id).status, "in_progress");
	disk.patch(id, { missionId: null });
	assert.equal(disk.require(id).slack?.status, "in_progress");
	assert.equal(disk.require(id).slack?.type, "question");
	assert.throws(() => disk.patch(id, { slack: { status: "working" } } as never), /Invalid Slack status/);
	assert.throws(() => disk.patch(id, { slack: { type: null } } as never), /Invalid Slack type/);
	disk.commit("p", "linear", [input]);
	const linear = disk.list({ projectId: "p", kind: "linear" }).items[0]!;
	assert.throws(() => disk.patch(linear.id, { slack: { type: "bug" } }), /require a Slack item/);
});

test("corrections are bounded, newest first, project-local, and ignore no-op reclassification", () => {
	const disk = new TrackedItemDisk(":memory:");
	try {
		disk.commit("p", "slack", [input]);
		const id = disk.list({ projectId: "p" }).items[0]!.id;
		for (let i = 0; i < 505; i++) disk.patch(id, { slack: { type: i % 2 ? "bug" : "question" } });
		const corrections = disk.corrections("p");
		assert.equal(corrections.length, 500);
		assert.equal(corrections[0]!.values.type, "question");
		assert.equal(corrections.at(-1)!.values.type, "bug");
		assert.equal(corrections[0]!.summary, input.title);
		assert.deepEqual(disk.corrections("other"), []);
		disk.patch(id, { slack: { type: "question" } });
		assert.deepEqual(disk.corrections("p"), corrections);
		disk.patch(id, { sessionId: "s", start: true });
		assert.deepEqual(disk.corrections("p"), corrections, "automatic start status is not a classifier correction");
	} finally {
		disk.close();
	}
});

test("project labels are bounded and validated, and classifier labels must belong to that project", () => {
	const config = {
		slackChannels: [],
		slackLabels: [
			{ name: " Client ", description: " App support ", effect: "close" as const },
			{ name: "Product", description: "", hideFromInbox: true },
			{ name: "Ops", description: "", hideFromInbox: false },
			{ name: "Billing", description: "", effect: "none" as const, hideFromInbox: true },
		],
	};
	assert.deepEqual(validateTrackingConfig(config).slackLabels, [
		{ name: "Client", description: "App support", effect: "close" },
		{ name: "Product", description: "", effect: "hide" },
		{ name: "Ops", description: "", effect: "none" },
		{ name: "Billing", description: "", effect: "none" },
	]);
	for (const slackLabels of [
		null,
		[null],
		[{ name: "", description: "" }],
		[{ name: "x", description: "two\nlines" }],
		[{ name: "x", description: "", hideFromInbox: "yes" }],
		[{ name: "x", description: "", effect: "archive" }],
		[{ name: "x", description: "", effect: true }],
		[{ name: "x", description: "", extra: 1 }],
		[
			{ name: "x", description: "" },
			{ name: " x ", description: "" },
		],
		Array.from({ length: 51 }, (_, i) => ({ name: String(i), description: "" })),
	]) {
		assert.throws(() => validateTrackingConfig({ slackChannels: [], slackLabels }), /Invalid Slack labels/);
	}
	const result = { type: "request", label: "Client", severity: "low", summary: "Add export", confidence: 0.9 };
	assert.equal(
		parseSlackClassification(
			JSON.stringify(result),
			config.slackLabels.map((label) => ({ ...label, name: label.name.trim() })),
		).label,
		"Client",
	);
	assert.throws(() => parseSlackClassification(JSON.stringify(result), []), /Invalid Slack classification/);
	assert.throws(
		() => parseSlackClassification(JSON.stringify({ ...result, label: ["Client"] })),
		/Invalid Slack classification/,
	);
});

test("legacy global boolean cache migrates without calls or budget charges; new results are project-specific", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "slack-migration-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const path = join(home, "items.sqlite");
	let disk = new TrackedItemDisk(path);
	disk.commit("p", "slack", [
		{
			...input,
			status: "bug_report",
			metadata: { isBugReport: true, severity: "high", guessedProject: "Invented app" },
		},
	]);
	const id = disk.list({ projectId: "p" }).items[0]!.id;
	disk.patch(id, { dismissed: true, sessionId: "s" });
	disk.close();
	const db = new DatabaseSync(path);
	db.exec(
		`PRAGMA user_version=0;
		DROP INDEX slack_reaction_reads_unfinished; DROP INDEX slack_waiting_reads; DROP INDEX slack_done_pending;
		ALTER TABLE tracked_items DROP COLUMN slack_status; ALTER TABLE tracked_items DROP COLUMN slack_overrides`,
	);
	const legacy = {
		isBugReport: true,
		confidence: 0.9,
		severity: "high",
		summary: "Export crashes",
		guessedProject: null,
	};
	for (const [ts, result] of [
		["1.000001", legacy],
		["2.000001", { ...legacy, isBugReport: false }],
	] as const)
		db.prepare("INSERT INTO slack_classifications VALUES ('C1', ?, 'done', ?)").run(ts, JSON.stringify(result));
	db.exec(
		"INSERT INTO slack_classifications VALUES ('C1', '3.000001', 'error', NULL); INSERT INTO slack_classifications VALUES ('C1', '4.000001', 'pending', NULL)",
	);
	db.close();
	disk = new TrackedItemDisk(path);
	try {
		assert.equal(disk.require(id).status, "dismissed");
		assert.equal(disk.require(id).sessionId, "s");
		assert.equal(disk.require(id).slack?.type, "bug");
		assert.equal(disk.require(id).metadata.isBugReport, undefined);
		for (const project of ["p", "other"]) {
			const positive = disk.slackCached("C1", "1.000001", project);
			assert.equal(positive?.state === "done" && positive.result.type, "bug");
			const negative = disk.slackCached("C1", "2.000001", project);
			assert.equal(negative?.state === "done" && negative.result.type, "unknown");
			assert.deepEqual(disk.slackCached("C1", "3.000001", project), { state: "error" });
			assert.deepEqual(disk.slackCached("C1", "4.000001", project), { state: "pending" });
		}
		assert.deepEqual(disk.reserveSlack("C1", "5.000001", 0, "p"), { state: "reserved" });
		disk.finishSlack(
			"C1",
			"5.000001",
			{ type: "question", label: "Client", severity: "low", confidence: 0.9, summary: "Export help" },
			"p",
		);
		assert.equal(disk.slackCached("C1", "5.000001", "other"), undefined);
		assert.deepEqual(disk.reserveSlack("C1", "5.000001", 0, "other"), { state: "reserved" });
	} finally {
		disk.close();
	}
	const check = new DatabaseSync(path);
	assert.equal(check.prepare("SELECT used FROM slack_budget").get()!.used, 2);
	check.close();
});
