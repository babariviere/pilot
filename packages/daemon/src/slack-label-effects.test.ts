import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProjectStore } from "./projects.ts";
import { SourceRegistry } from "./sources.ts";
import { TrackedItemStore } from "./tracked-items.ts";
import { type TrackedInput, TrackedItemDisk } from "./tracked-items-disk.ts";

// Invented fixtures: no real workspace, channel or message.
function message(ts: string, label: string | null, updatedAt = 1): TrackedInput {
	return {
		externalId: `C1/${ts}`,
		title: `Invented message ${ts}`,
		url: `https://example.com/${ts}`,
		status: "open",
		metadata: { type: "request", label, severity: "medium", channel: "C1" },
		updatedAt,
	};
}
function ids(disk: TrackedItemDisk, projectId = "p") {
	const all = [
		...disk.list({ projectId, kind: "slack" }).items,
		...disk.list({ projectId, kind: "slack", dismissed: true }).items,
	];
	return (ts: string) => all.find((item) => item.externalId === `C1/${ts}`)!.id;
}

test("a close label dismisses open messages it applies to, naming the label, and never a status the user set", () => {
	const disk = new TrackedItemDisk(":memory:");
	try {
		disk.commit("p", "slack", [
			message("1.000001", "Product"),
			message("2.000001", "Product"),
			message("3.000001", "Product"),
			message("4.000001", null),
		]);
		const id = ids(disk);
		disk.patch(id("2.000001"), { slack: { status: "done" } });
		disk.patch(id("3.000001"), { sessionId: "s", start: true });
		assert.equal(disk.slackLabelEffects("p", ["Product"]), true);
		assert.equal(disk.slackLabelEffects("p", ["Product"]), false, "idempotent");
		const closed = disk.require(id("1.000001"));
		assert.equal(closed.slack?.status, "dismissed");
		assert.equal(closed.dismissed, true);
		assert.equal(closed.slack?.closedByLabel, "Product");
		assert.equal(closed.slack?.overrides.status, undefined, "Pilot's close is not a user status");
		assert.equal(disk.require(id("2.000001")).slack?.status, "done");
		assert.equal(disk.require(id("3.000001")).slack?.status, "in_progress");
		assert.equal(disk.require(id("4.000001")).slack?.status, "open");
		assert.equal(disk.corrections("p").length, 1, "only the user's Done is a correction");

		// A newly classified message closes as it is stored; the Inbox counts it in the footer, not the list.
		disk.commit("p", "slack", [message("5.000001", "Product", 5)]);
		const corrections = disk.corrections("p");
		let events = 0;
		disk.onChange(() => events++);
		disk.commit("p", "slack", [message("5.000001", "Product", 5)]);
		assert.equal(events, 0, "reapplying a label-close is idempotent");
		assert.deepEqual(disk.corrections("p"), corrections);
		assert.deepEqual(
			disk
				.list({ projectId: "p", kind: "slack", closedByLabel: true })
				.items.map((item) => item.externalId)
				.sort(),
			["C1/1.000001", "C1/5.000001"],
		);
		assert.deepEqual(disk.inboxCounts("p", "slack"), { "": 1, Product: 1 });
		const inbox = disk.inbox({ linear: [], slack: [{ projectId: "p", hidden: [] }], limit: 10 });
		assert.equal(inbox.slack.total, 2);
		assert.deepEqual(inbox.slack.hidden, [{ label: "Product", count: 2, closed: true }]);
		// Projects whose effects were never set are left alone.
		disk.commit("q", "slack", [message("1.000001", "Product")]);
		assert.equal(disk.list({ projectId: "q", kind: "slack" }).total, 1);
	} finally {
		disk.close();
	}
});

test("edits keep a label's close, the user's own status replaces it, and only label-closed messages reopen", () => {
	const disk = new TrackedItemDisk(":memory:");
	try {
		disk.slackLabelEffects("p", ["Product", "Sales"]);
		disk.commit(
			"p",
			"slack",
			["1", "2", "3", "4", "5", "6"].map((n) => message(`${n}.000001`, "Product")),
		);
		const id = ids(disk);
		// Unrelated edits do not turn the label's dismissal into a user status.
		const edited = disk.patch(id("1.000001"), { slack: { severity: "high" }, sessionId: "linked" });
		assert.equal(edited.slack?.closedByLabel, "Product");
		assert.equal(edited.slack?.overrides.status, undefined);
		// Choosing Dismissed again is the user's status: it stays even when the label stops closing.
		const confirmed = disk.patch(id("2.000001"), { slack: { status: "dismissed" } });
		assert.equal(confirmed.slack?.closedByLabel, undefined);
		assert.equal(confirmed.slack?.overrides.status, "dismissed");
		assert.deepEqual(disk.patch(id("2.000001"), { slack: { status: "dismissed" } }), confirmed, "idempotent");
		disk.patch(id("3.000001"), { dismissed: true });
		assert.equal(disk.require(id("3.000001")).slack?.closedByLabel, undefined, "dismissed: true confirms too");
		assert.equal(disk.require(id("3.000001")).slack?.overrides.status, "dismissed");

		// Reopening is a correction the classifier learns from, and a later reclassification keeps it open.
		const before = disk.corrections("p").length;
		const reopened = disk.patch(id("4.000001"), { slack: { status: "open" } });
		assert.equal(reopened.slack?.status, "open");
		assert.equal(reopened.slack?.closedByLabel, undefined);
		assert.equal(disk.corrections("p").length, before + 1);
		assert.deepEqual(disk.corrections("p")[0]!.values, {
			type: "request",
			label: "Product",
			severity: "medium",
			status: "open",
		});
		disk.commit("p", "slack", [{ ...message("4.000001", "Product", 9), title: "Reclassified" }]);
		assert.equal(disk.require(id("4.000001")).slack?.status, "open");

		// The user relabels: another close label keeps it closed under that label, a plain label reopens it.
		assert.equal(disk.patch(id("5.000001"), { slack: { label: "Sales" } }).slack?.closedByLabel, "Sales");
		const relabelled = disk.patch(id("5.000001"), { slack: { label: "Other" } });
		assert.equal(relabelled.slack?.status, "open");
		assert.equal(relabelled.slack?.overrides.status, undefined);
		assert.equal(disk.corrections("p")[0]!.values.status, "open", "the correction records the outcome");
		// The user picks a close label: it closes like the classifier's.
		assert.equal(disk.patch(id("5.000001"), { slack: { label: "Sales" } }).slack?.closedByLabel, "Sales");
		// The classifier relabels: a label that does not close reopens it.
		disk.commit("p", "slack", [message("6.000001", null, 9)]);
		assert.equal(disk.require(id("6.000001")).slack?.status, "open");

		// Removing the effect reopens only what labels closed.
		disk.slackLabelEffects("p", []);
		assert.equal(disk.require(id("1.000001")).slack?.status, "open");
		assert.equal(disk.require(id("5.000001")).slack?.status, "open");
		assert.equal(disk.require(id("2.000001")).slack?.status, "dismissed");
		assert.equal(disk.require(id("3.000001")).slack?.status, "dismissed");
		assert.equal(disk.list({ projectId: "p", kind: "slack", closedByLabel: true }).total, 0);
	} finally {
		disk.close();
	}
});

test("explicitly choosing Open before applying a close label protects that status", () => {
	const disk = new TrackedItemDisk(":memory:");
	try {
		disk.commit("p", "slack", [message("1.000001", null)]);
		const id = ids(disk)("1.000001");
		disk.patch(id, { dismissed: false });
		assert.equal(disk.require(id).slack?.overrides.status, "open");
		disk.slackLabelEffects("p", ["Product"]);
		assert.equal(disk.patch(id, { slack: { label: "Product" } }).slack?.status, "open");
		assert.equal(disk.require(id).slack?.closedByLabel, undefined);
		const before = disk.corrections("p");
		let events = 0;
		disk.onChange(() => events++);
		disk.commit("p", "slack", [message("1.000001", "Product", 9)]);
		assert.equal(disk.require(id).slack?.status, "open");
		events = 0;
		disk.commit("p", "slack", [message("1.000001", "Product", 9)]);
		assert.equal(events, 0, "reapplying an identical classification emits nothing");
		assert.deepEqual(disk.corrections("p"), before);
	} finally {
		disk.close();
	}
});

test("label effects migrate from hideFromInbox, survive a restart and reconcile stored messages at startup", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "slack-label-effects-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	// A projects.json from before effects, with a hidden label.
	await writeFile(
		join(home, "projects.json"),
		JSON.stringify([
			{
				id: "p",
				name: "Invented",
				path: home,
				createdAt: 1,
				tracking: {
					slackChannels: ["C1"],
					slackLabels: [
						{ name: "Product", description: "Invented team", hideFromInbox: true },
						{ name: "Ops", description: "" },
					],
				},
			},
		]),
	);
	let projects = new ProjectStore(home);
	await projects.load();
	assert.deepEqual(projects.require("p").tracking?.slackLabels, [
		{ name: "Product", description: "Invented team", effect: "hide" },
		{ name: "Ops", description: "", effect: "none" },
	]);
	const migrated = await readFile(join(home, "projects.json"), "utf8");
	assert.match(migrated, /"effect": "hide"/);
	assert.doesNotMatch(migrated, /hideFromInbox/);

	const path = join(home, "tracked.sqlite");
	const mcp = {
		async call(): Promise<never> {
			throw new Error("no network in tests");
		},
	};
	let items = new TrackedItemStore(path);
	await items.load(["p"]);
	let tracking = new SourceRegistry(projects, items, mcp);
	await items.commit("p", "slack", [message("1.000001", "Ops"), message("2.000001", "Product")]);
	assert.equal(tracking.inboxCount("p"), 1, "the hidden label stays out of the Inbox");
	await tracking.stop();
	await items.close();

	// Settings edited while pilotd was stopped: Ops now closes. The restart applies it before any poll.
	const saved = JSON.parse(await readFile(join(home, "projects.json"), "utf8"));
	saved[0].tracking.slackLabels[1].effect = "close";
	await writeFile(join(home, "projects.json"), JSON.stringify(saved));
	projects = new ProjectStore(home);
	await projects.load();
	items = new TrackedItemStore(path);
	await items.load(["p"]);
	tracking = new SourceRegistry(projects, items, mcp);
	t.after(async () => {
		await tracking.stop();
		await items.close();
	});
	const changes: string[] = [];
	tracking.onChange((change) => changes.push(change.type));
	const closed = await items.list({ projectId: "p", kind: "slack", closedByLabel: true });
	assert.deepEqual(
		closed.items.map((item) => [item.externalId, item.slack?.closedByLabel]),
		[["C1/1.000001", "Ops"]],
	);
	assert.equal(tracking.inboxCount("p"), 0, "cached counts follow the reconciliation");
	const inbox = await tracking.inbox("p", 10);
	assert.deepEqual(inbox.slack?.hidden, [
		{ label: "Product", count: 1 },
		{ label: "Ops", count: 1, closed: true },
	]);

	// Changing the effect reopens what Ops closed, and updates reach listeners and cached counts.
	await projects.update("p", {
		tracking: {
			slackChannels: ["C1"],
			slackLabels: [
				{ name: "Product", description: "Invented team", effect: "hide" },
				{ name: "Ops", description: "", effect: "none" },
			],
		},
	});
	assert.equal((await items.list({ projectId: "p", kind: "slack", closedByLabel: true })).total, 0);
	assert.ok(changes.includes("items"));
	assert.equal(tracking.inboxCount("p"), 1);
	const reopened = (await items.list({ projectId: "p", kind: "slack" })).items.find(
		(item) => item.externalId === "C1/1.000001",
	);
	assert.equal(reopened?.slack?.status, "open");
	assert.equal(reopened?.slack?.overrides.status, undefined);
});
