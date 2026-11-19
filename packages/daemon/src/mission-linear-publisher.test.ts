import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TrackingJson } from "@pilot/protocol";
import { linearPublishContext } from "./linear-publish-context.ts";
import { MissionLinearPublisher, type PublishContext } from "./mission-linear-publisher.ts";
import { MissionStore } from "./missions.ts";
import { publishedPlanningFixture } from "./published-planning.fixture.ts";
import type { SourceMcpClient } from "./source-mcp.ts";
import { SourceNotDispatched, validSourceArguments } from "./source-tool-rules.ts";

const project = "project";
const mission = "mission";
const teamId = "00000000-0000-4000-8000-000000000001";
const uuid = "00000000-0000-4000-8000-000000000002";
const parent = {
	uuid,
	teamId,
	id: "BIL-200",
	url: "https://linear.app/billing/issue/BIL-200/failed-payments",
	title: "Recover failed payments",
	parentId: null,
	archivedAt: null,
	statusType: "started",
};
function fixture() {
	const store = new MissionStore(":memory:");
	const context: PublishContext = {
		projectName: "Billing",
		parentUrls: [parent.url],
		revision: "approved-1",
		tasks: [
			{
				id: "task-a",
				number: 1,
				title: "Explain declined charges",
				outcome: "Customers can see why a charge failed.",
				criteria: ["Keep the invoice visible."],
				checks: ["Simulate a card decline."],
				dependsOn: [],
			},
		],
	};
	const calls: string[] = [];
	const publisher = new MissionLinearPublisher(store.linearPublisher, () => context, {
		async call(_kind, tool) {
			calls.push(tool);
			if (tool === "publishIssueRead") return parent;
			throw new Error("unexpected write");
		},
	});
	return { store, context, calls, publisher };
}

test("preview is read-only and exact while publishing is off", async (t) => {
	const f = fixture();
	t.after(() => f.store.close());
	const initial = await f.publisher.request(project, mission, { action: "read" });
	assert.equal(initial.enabled, false);
	assert.deepEqual(f.calls, []);
	const preview = await f.publisher.request(project, mission, {
		action: "preview",
		parentUrl: parent.url,
		taskIds: ["task-a"],
	});
	assert.equal(preview.preview?.parent.identifier, "BIL-200");
	assert.match(preview.preview!.issues[0].after.description, /## Outcome\nCustomers can see why a charge failed\./);
	assert.match(preview.preview!.issues[0].after.description, /## Checks\n- Simulate a card decline\./);
	assert.match(preview.preview!.issues[0].after.description, /## Dependencies\nNone\./);
	assert.equal(preview.preview?.pin, null);
	assert.deepEqual(f.calls, ["publishIssueRead"]);
});

test("the real approved-plan projection exports slices but not worker ownership or file paths", async (t) => {
	const f = await publishedPlanningFixture(t, { twoSlices: true, files: [["src/importer.ts"], ["src/exporter.ts"]] });
	f.store.addResource(f.missionId, { url: parent.url });
	f.store.addTask(f.missionId, { title: "Unapproved notes" });
	const projected = linearPublishContext(f.store, f.projects, f.project.id, f.missionId);
	assert.deepEqual(projected.parentUrls, [parent.url]);
	assert.deepEqual(
		projected.tasks.map((t) => t.title),
		["Importer", "Exporter"],
	);
	assert.equal(projected.tasks[1]?.dependsOn[0], projected.tasks[0]?.id);
	assert.doesNotMatch(JSON.stringify(projected), /src\/|sol-backend|Unapproved notes/);
});

test("disable at connector admission proves non-dispatch and leaves no uncertainty", async (t) => {
	const f = fixture();
	t.after(() => f.store.close());
	let sent = 0;
	const run = new MissionLinearPublisher(f.store.linearPublisher, () => f.context, {
		async call(_kind, tool, args, _signal, permit) {
			if (tool === "publishIssueRead") return parent;
			assert.equal(validSourceArguments(tool, args), true);
			await run.request(project, mission, { action: "setting", enabled: false, revision: 1 });
			try {
				await permit!();
			} catch {
				throw new SourceNotDispatched();
			}
			sent++;
			return {};
		},
	});
	await run.request(project, mission, { action: "setting", enabled: true, revision: 0 });
	const selection = { taskIds: ["task-a"], parentUrl: parent.url };
	const preview = (await run.request(project, mission, { action: "preview", ...selection })).preview!;
	const result = await run.request(project, mission, { action: "publish", pin: preview.pin, ...selection });
	assert.equal(result.enabled, false);
	assert.equal(result.pending, null);
	assert.equal(sent, 0);
});

test("lost create and blocking-link replies reconcile after restart without replay", async (t) => {
	const f = fixture();
	t.after(() => f.store.close());
	const dir = mkdtempSync(join(tmpdir(), "publisher-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "missions.sqlite");
	let store = new MissionStore(file);
	t.after(() => store.close());
	f.context.tasks.push({
		...f.context.tasks[0]!,
		id: "task-b",
		number: 2,
		title: "Offer a safe retry",
		dependsOn: ["task-a"],
	});
	const issues: Record<string, TrackingJson>[] = [];
	const writes: Record<string, unknown>[] = [];
	let hideChildren = true;
	const mcp: SourceMcpClient = {
		async call(_kind, tool, args, _signal, permit) {
			if (tool === "publishIssueRead")
				return [parent, ...issues].find(
					(i) => (i as Record<string, TrackingJson>).uuid === args.id || i.id === args.id,
				) as TrackingJson;
			if (tool === "publishChildrenRead") return { issues: hideChildren ? [] : issues, hasNextPage: false };
			assert.equal(tool, "publishIssueWrite");
			await permit!();
			writes.push(args);
			if (!args.id) {
				const i = issues.length + 1;
				const row = {
					...parent,
					id: `BIL-${200 + i}`,
					url: `https://linear.app/billing/issue/BIL-${200 + i}`,
					uuid: `00000000-0000-4000-8000-00000000001${i}`,
					parentId: uuid,
					title: String(args.title),
					description: String(args.description),
					relations: { blocks: [] },
				};
				issues.push(row);
				if (i === 1) throw new Error("lost create reply");
				return row;
			}
			assert.deepEqual(args, { id: issues[0]!.uuid, blocks: [issues[1]!.uuid] });
			issues[0]!.relations = { blocks: [{ id: "BIL-202" }] };
			throw new Error("lost link reply");
		},
	};
	let run = new MissionLinearPublisher(store.linearPublisher, () => f.context, mcp);
	const selection = { taskIds: ["task-a", "task-b"], parentUrl: parent.url };
	await run.request(project, mission, { action: "setting", revision: 0, enabled: true });
	const draft = (await run.request(project, mission, { action: "preview", ...selection })).preview!;
	assert.equal(draft.links[0]?.label, "#1 Explain declined charges blocks #2 Offer a safe retry");
	const pending = await run.request(project, mission, { action: "publish", pin: draft.pin, ...selection });
	assert.equal(pending.pending, "Explain declined charges");
	assert.equal(writes.length, 1);
	store.close();
	store = new MissionStore(file);
	run = new MissionLinearPublisher(store.linearPublisher, () => f.context, mcp);
	assert.equal((await run.request(project, mission, { action: "check" })).pending, "Explain declined charges");
	assert.equal((await run.request(project, mission, { action: "preview", ...selection })).preview, null);
	assert.equal(writes.length, 1);
	hideChildren = false;
	const checked = await run.request(project, mission, { action: "check" });
	assert.equal(checked.pending, null);
	assert.equal(checked.mappings[0]?.identifier, "BIL-201");
	const next = (await run.request(project, mission, { action: "preview", ...selection })).preview!;
	assert.deepEqual(
		next.issues.map((i) => i.change),
		["unchanged", "create"],
	);
	assert.equal(
		(await run.request(project, mission, { action: "publish", pin: next.pin, ...selection })).pending,
		"blocking link",
	);
	assert.equal((await run.request(project, mission, { action: "check" })).pending, null);
	assert.equal(writes.length, 3);
	const upToDate = (await run.request(project, mission, { action: "preview", ...selection })).preview!;
	assert.deepEqual(
		upToDate.issues.map((i) => i.change),
		["unchanged", "unchanged"],
	);
	assert.equal(upToDate.links[0]?.change, "present");
	assert.equal(upToDate.pin, null);
});

test("changed plan invalidates preview; external edits need separate reconciliation before a guarded update", async (t) => {
	const f = fixture();
	t.after(() => f.store.close());
	let child: Record<string, TrackingJson> | undefined;
	const writes: Record<string, unknown>[] = [];
	const selection = { taskIds: ["task-a"], parentUrl: parent.url };
	const run = new MissionLinearPublisher(f.store.linearPublisher, () => f.context, {
		async call(_kind, tool, args, _signal, permit) {
			if (tool === "publishIssueRead") return args.id === parent.id || args.id === parent.uuid ? parent : child!;
			assert.equal(tool, "publishIssueWrite");
			await permit!();
			writes.push(args);
			if (!args.id) {
				child = {
					...parent,
					id: "BIL-201",
					uuid: "00000000-0000-4000-8000-000000000003",
					url: "https://linear.app/billing/issue/BIL-201",
					parentId: uuid,
					title: String(args.title),
					description: String(args.description),
				};
			} else {
				const [patch] = args.patch as { old_string: string; new_string: string }[];
				assert.equal(patch!.old_string, child!.description);
				child!.description = patch!.new_string;
			}
			return child!;
		},
	});
	await run.request(project, mission, { action: "setting", enabled: true, revision: 0 });
	const preview = async () => (await run.request(project, mission, { action: "preview", ...selection })).preview!;
	const publish = (pin: string | null) => run.request(project, mission, { action: "publish", pin, ...selection });
	const initial = await preview();
	f.context.revision = "approved-2";
	assert.match((await publish(initial.pin)).message, /preview changed/);
	assert.equal(writes.length, 0);
	await publish((await preview()).pin);
	assert.equal(writes.length, 1);
	child!.description = "Detailed description edited in Linear.";
	f.context.tasks[0]!.criteria = ["Keep the invoice and its payment state visible."];
	const conflict = await preview();
	assert.equal(conflict.edits[0]?.current.description, "Detailed description edited in Linear.");
	assert.match((await publish(conflict.pin)).message, /reconcile/);
	assert.equal(writes.length, 1);
	await run.request(project, mission, { action: "reconcile", pin: (await preview()).pin, ...selection });
	assert.equal(writes.length, 1);
	const update = await preview();
	assert.deepEqual(update.edits, []);
	assert.equal(update.issues[0]?.before?.description, "Detailed description edited in Linear.");
	assert.match(update.issues[0]!.after.description, /Keep the invoice and its payment state visible/);
	assert.equal((await publish(update.pin)).pending, null);
	assert.equal(writes.length, 2);
	f.context.tasks = [];
	f.context.removed = ["task-a"];
	assert.equal((await run.request(project, mission, { action: "read" })).mappings[0]?.removed, true);
	assert.equal(writes.length, 2);
});
