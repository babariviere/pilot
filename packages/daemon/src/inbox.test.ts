import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Inbox, ProjectDashboardCounts } from "@pilot/protocol";
import type { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import type { SessionManager } from "./sessions.ts";
import { SourceRegistry } from "./sources.ts";
import type { TerminalManager } from "./terminals.ts";
import { TrackedItemDisk, type TrackedInput } from "./tracked-items-disk.ts";
import { TrackedItemStore } from "./tracked-items.ts";

function linear(externalId: string, statusType: string, priority: number, updatedAt: number): TrackedInput {
	return {
		externalId,
		title: `Ticket ${externalId}`,
		url: `https://example.com/${externalId}`,
		status: statusType,
		metadata: { identifier: externalId, statusType, priority },
		updatedAt,
	};
}
function slack(externalId: string, severity: string, label: string | null, updatedAt: number): TrackedInput {
	return {
		externalId,
		title: `Message ${externalId}`,
		url: `https://example.com/${externalId}`,
		status: "open",
		metadata: { type: "bug", label, severity, channel: "C1" },
		updatedAt,
	};
}

test("the Inbox lists open Linear tickets and visible Slack messages across projects, most pressing first", () => {
	const disk = new TrackedItemDisk(":memory:");
	try {
		disk.commit("p1", "linear", [
			linear("A-1", "unstarted", 3, 1),
			linear("A-2", "started", 4, 2),
			linear("A-3", "completed", 1, 3),
			linear("A-4", "canceled", 1, 4),
			linear("A-5", "unstarted", 1, 5),
		]);
		disk.commit("p2", "linear", [linear("B-1", "started", 2, 1)]);
		disk.commit("p3", "linear", [linear("C-1", "started", 1, 1)]);
		disk.commit("p1", "slack", [
			slack("C1/1.000001", "low", null, 1),
			slack("C1/1.000002", "critical", null, 2),
			slack("C1/1.000003", "high", "Product", 3),
			slack("C1/1.000004", "high", null, 4),
			slack("C1/1.000005", "medium", null, 5),
		]);
		disk.commit("p2", "slack", [slack("C1/1.000006", "high", "Product", 6)]);
		const id = (externalId: string) =>
			[...disk.list({ projectId: "p1", kind: "slack" }).items].find((item) => item.externalId === externalId)!.id;
		disk.patch(id("C1/1.000004"), { slack: { status: "done" } });
		disk.patch(id("C1/1.000005"), { slack: { status: "in_progress" } });
		disk.patch(id("C1/1.000002"), { dismissed: true });
		// A user override clears the classifier's hidden label, so the message shows again.
		disk.patch(id("C1/1.000003"), { slack: { label: null } });
		disk.commit("p1", "slack", [slack("C1/1.000007", "low", "Product", 7)]);

		assert.deepEqual(disk.inboxCounts("p1", "linear"), { "": 3 });
		assert.deepEqual(disk.inboxCounts("p1", "slack"), { "": 3, Product: 1 });
		assert.deepEqual(disk.inboxCounts("p3", "slack"), {});

		const inbox = disk.inbox({
			linear: ["p1", "p2"],
			slack: [
				{ projectId: "p1", hidden: ["Product"] },
				// Labels are per project: p2 does not hide "Product".
				{ projectId: "p2", hidden: [] },
			],
			limit: 3,
		});
		assert.equal(inbox.linear.total, 4, "done, canceled and other projects are left out");
		assert.deepEqual(
			inbox.linear.items.map((item) => item.externalId),
			["B-1", "A-2", "A-5"],
			"in progress first, then by priority",
		);
		assert.equal(inbox.slack.total, 4);
		assert.deepEqual(
			inbox.slack.items.map((item) => item.externalId),
			["C1/1.000006", "C1/1.000003", "C1/1.000005"],
			"most severe first, then newest",
		);
		assert.equal(inbox.slack.items[2]!.slack?.status, "in_progress");
		assert.deepEqual(inbox.slack.hidden, [{ label: "Product", count: 1 }]);
		assert.deepEqual(disk.inbox({ linear: [], slack: [], limit: 5 }).linear, { total: 0, items: [] });
		assert.throws(() => disk.inbox({ linear: [], slack: [], limit: 101 }), /limit/);
	} finally {
		disk.close();
	}
});

test("GET /api/inbox and the sidebar counts follow sources, scope and hidden labels", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-inbox-"));
	const projects = new ProjectStore(home);
	await projects.load();
	const labels = [{ name: "Product", description: "Handled by product", hideFromInbox: true }];
	const project = await projects.create({
		path: home,
		tracking: { slackChannels: ["C1"], slackLabels: labels, linearTeam: "team" },
	});
	await mkdir(join(home, "other"));
	const other = await projects.create({ path: join(home, "other") });
	const items = new TrackedItemStore(join(home, "tracked.sqlite"));
	await items.load([project.id, other.id]);
	const tracking = new SourceRegistry(projects, items, {
		async call() {
			throw new Error("no network in tests");
		},
	});
	const sessions = {
		list: () => [],
		get: () => undefined,
		onChange: () => () => {},
		onArtifactsChanged: () => () => {},
		setWorkspaceProcessGuard() {},
	} as unknown as SessionManager;
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		{} as ModelCatalog,
		{ isRunning: () => false } as unknown as TerminalManager,
		undefined,
		undefined,
		undefined,
		undefined,
		tracking,
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
	t.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await tracking.stop();
		await items.close();
		await rm(home, { recursive: true, force: true });
	});
	const get = async <T>(path: string) => (await (await fetch(root + path)).json()) as T;

	assert.deepEqual(await get<Inbox>(`/inbox?projectId=${other.id}`), {
		needsYou: { total: 0, items: [] },
		readyToMerge: { total: 0, items: [] },
	});
	await items.commit(project.id, "linear", [linear("A-1", "started", 2, 1), linear("A-2", "completed", 2, 2)]);
	await items.commit(project.id, "slack", [
		slack("C1/1.000001", "high", null, 1),
		slack("C1/1.000002", "low", "Product", 2),
	]);
	const inbox = await get<Inbox>("/inbox");
	assert.deepEqual(
		inbox.linear?.items.map((item) => item.externalId),
		["A-1"],
	);
	assert.equal(inbox.slack?.total, 1);
	assert.deepEqual(inbox.slack?.hidden, [{ label: "Product", count: 1 }]);
	assert.deepEqual((await get<ProjectDashboardCounts>("/dashboard/counts")).projects[project.id], {
		working: 0,
		needsYou: 0,
		tracked: 2,
	});
	assert.equal((await fetch(`${root}/inbox?limit=0`)).status, 400);
	assert.equal((await fetch(`${root}/inbox?projectId=missing`)).status, 404);

	// Showing the label again counts its messages; removing the team drops Linear from the Inbox.
	await projects.update(project.id, {
		tracking: { slackChannels: ["C1"], slackLabels: [{ ...labels[0]!, hideFromInbox: false }] },
	});
	const shown = await get<Inbox>(`/inbox?projectId=${project.id}`);
	assert.equal(shown.linear, undefined);
	assert.equal(shown.slack?.total, 2);
	assert.deepEqual(shown.slack?.hidden, []);
	assert.equal((await get<ProjectDashboardCounts>("/dashboard/counts")).projects[project.id]?.tracked, 2);
});
