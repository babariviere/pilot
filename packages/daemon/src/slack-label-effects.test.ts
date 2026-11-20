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

test("labels organize reports without changing open, waiting, tackled or dismissed status", () => {
	const disk = new TrackedItemDisk(":memory:");
	try {
		disk.slackLabelEffects("p", ["Product", "Sales"]);
		for (const status of ["open", "in_progress", "waiting", "done", "dismissed"] as const) {
			disk.commit("p", "slack", [message(status, "Product")]);
			const id = ids(disk)(status);
			disk.patch(id, { slack: { status } });
			disk.patch(id, { slack: { label: "Sales" } });
			assert.equal(disk.require(id).slack?.status, status);
			assert.equal(disk.require(id).slack?.closedByLabel, undefined);
			disk.commit("p", "slack", [message(status, null, 9)]);
			assert.equal(disk.require(id).slack?.status, status);
		}
		disk.commit("p", "slack", [message("new", "Product")]);
		assert.equal(disk.require(ids(disk)("new")).slack?.status, "open");
		disk.slackLabelEffects("p", []);
		assert.equal(disk.require(ids(disk)("new")).slack?.status, "open");
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

test("legacy label settings remain readable but never close messages at startup", async (t) => {
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
	const migratedLabels = [
		{ name: "Product", description: "Invented team", effect: "hide" },
		{ name: "Ops", description: "", effect: "none" },
	];
	assert.deepEqual(projects.require("p").tracking?.slackLabels, migratedLabels);
	const migrated = JSON.parse(await readFile(join(home, "projects.json"), "utf8"));
	assert.deepEqual(migrated[0].tracking.slackLabels, migratedLabels);

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
	assert.deepEqual(closed.items, []);
	assert.equal(tracking.inboxCount("p"), 1);
	const inbox = await tracking.inbox("p", 10);
	assert.deepEqual(inbox.slack?.hidden, [{ label: "Product", count: 1 }]);

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

	assert.equal(tracking.inboxCount("p"), 1);
	const reopened = (await items.list({ projectId: "p", kind: "slack" })).items.find(
		(item) => item.externalId === "C1/1.000001",
	);
	assert.equal(reopened?.slack?.status, "open");
	assert.equal(reopened?.slack?.overrides.status, undefined);
});
