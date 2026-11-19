// biome-ignore-all lint/complexity/useLiteralKeys: Inspect the bounded background-drain seam in offline fixtures.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { TrackedItem } from "@pilot/protocol";
import { ProjectStore } from "./projects.ts";
import { decodeMcpResult, dedicatedSourceTool, validSourceArguments } from "./source-tool-rules.ts";
import { type SourcePoller, SourceRegistry } from "./sources.ts";
import { TrackedItemStore } from "./tracked-items.ts";

const parent = "1780000000.123456";
const input = {
	externalId: `CEXAMPLE/${parent}`,
	title: "Invented bug",
	url: "https://example.slack.com/archives/CEXAMPLE/p1780000000123456",
	status: "open",
	metadata: { channel: "CEXAMPLE", channelName: "bugs", thread_ts: parent, type: "bug" },
	updatedAt: 1,
};
type Response = Parameters<typeof decodeMcpResult>[0];
const checked = (count = 1): Response => ({
	structuredContent: { reactions: [{ name: "white_check_mark", count, users: ["invented-user"] }] },
});
const outcome = (item: TrackedItem) =>
	(item.metadata.slackDone as { outcome?: string; error?: string } | undefined)?.outcome;
function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
async function fixture(t: TestContext, adapter: SourcePoller = async () => ({ items: [] })) {
	const home = await mkdtemp(join(tmpdir(), "slack-done-"));
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: home, tracking: { slackChannels: ["CEXAMPLE"] } });
	const path = join(home, "items.sqlite");
	const items = new TrackedItemStore(path);
	await items.load([project.id]);
	await items.commit(project.id, "slack", [input]);
	const item = (await items.list({ projectId: project.id })).items[0]!;
	let read: Response = { structuredContent: { reactions: [] } };
	let beforeRead = async (_signal: AbortSignal) => {};
	const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
	const registry = new SourceRegistry(projects, items, {
		async call(kind, tool, args, signal) {
			assert.equal(kind, "slack");
			assert.ok(validSourceArguments(tool, args));
			assert.equal(tool, "reactions", "Slack reaction checks only read");
			assert.equal(dedicatedSourceTool(kind, tool), "slack_get_reactions");
			calls.push({ tool, args });
			assert.deepEqual(args, { channel_id: "CEXAMPLE", message_ts: parent });
			await beforeRead(signal);
			signal.throwIfAborted();
			return decodeMcpResult(read, tool);
		},
	});
	registry.register("slack", adapter);
	// Every poll checks reactions again, so each step observes the latest fixture response.
	registry.slackReactionRecheckMs = 0;
	const poll = () => registry.poll(`${project.id}:slack`);
	await poll();
	t.after(async () => {
		await registry.stop();
		await items.close();
		await rm(home, { recursive: true, force: true });
	});
	return {
		project,
		projects,
		path,
		items,
		item,
		registry,
		poll,
		calls,
		read: (value: Response) => {
			read = value;
		},
		beforeRead: (value: typeof beforeRead) => {
			beforeRead = value;
		},
		eyes: async () => {
			assert.equal(await items.reserveSlackStart(item.id), true);
			await items.slackStartResult(item.id, "reacted");
		},
		drain: async () => {
			await delay(10);
		},
	};
}

test("only Start writes a reaction; tackling and completion evidence never write or remove reactions", async (t) => {
	const f = await fixture(t);
	await f.items.patch(f.item.id, { sessionId: "chat", start: true });
	await f.eyes();
	f.calls.length = 0;
	await f.items.observeSlackPullRequests({ projectId: f.project.id, sessionId: "chat", prs: [], pending: false });
	await f.items.completeSlackMission(f.project.id, "mission", 1);
	await assert.rejects(f.items.agentSlackStatus("chat", "done"), /Only the user/);
	await f.items.patch(f.item.id, { slack: { status: "done" } });
	await f.drain();
	assert.equal((await f.items.require(f.item.id)).slack?.status, "done");
	assert.equal(outcome(await f.items.require(f.item.id)), undefined);
	assert.deepEqual(f.calls, []);
});

test("emoji changes never complete open or in-progress reports", async (t) => {
	const f = await fixture(t);
	for (const status of ["open", "in_progress", "waiting"] as const) {
		await f.items.patch(f.item.id, { slack: { status } });
		f.read(checked());
		await f.poll();
		assert.equal((await f.items.require(f.item.id)).slack?.status, status);
		f.read({ structuredContent: { reactions: [] } });
		await f.poll();
		f.read(checked(3));
		await f.poll();
		assert.equal((await f.items.require(f.item.id)).slack?.status, status);
	}
	assert.equal(f.calls.filter((call) => call.tool !== "reactions").length, 0);
});

test("a user reopen fences an in-flight check and later seeing the same reaction does not close it", async (t) => {
	const f = await fixture(t),
		entered = gate(),
		release = gate();
	t.after(release.release);
	f.read(checked());
	f.beforeRead(async () => {
		entered.release();
		await release.promise;
	});
	const poll = f.poll();
	await entered.promise;
	await f.items.patch(f.item.id, { slack: { status: "done" } });
	await f.items.patch(f.item.id, { slack: { status: "open" } });
	release.release();
	await poll;
	assert.equal((await f.items.require(f.item.id)).slack?.status, "open");
	await f.poll();
	assert.equal((await f.items.require(f.item.id)).slack?.status, "open");
});

test("reaction reads keep batch, fairness and recheck limits without an hourly cap", async () => {
	const items = new TrackedItemStore(":memory:");
	try {
		await items.commit(
			"p",
			"slack",
			Array.from({ length: 20 }, (_, i) => ({ ...input, externalId: String(i) })),
		);
		const t = 7_200_000; // Two hours into the UTC day, so never-checked items are due.
		const first = await items.reserveSlackReactions("p", t + 100, 0),
			second = await items.reserveSlackReactions("p", t + 200, 0);
		assert.equal(first.reads.length, 8);
		assert.equal(second.reads.length, 8);
		assert.equal(new Set([...first.reads, ...second.reads].map((read) => read.item.id)).size, 16);
		// By default an item checked within the hour waits: only the four never-checked items remain.
		assert.equal((await items.reserveSlackReactions("p", t + 300)).reads.length, 4);
		assert.equal((await items.reserveSlackReactions("p", t + 400)).reads.length, 0);
		let used = 20;
		for (let i = 0; i < 12; i++) used += (await items.reserveSlackReactions("p", t + 500 + i, 0)).reads.length;
		assert.equal(used, 116);
		assert.equal((await items.reserveSlackReactions("p", t + 600, 0)).reads.length, 8);
		assert.equal((await items.reserveSlack("CEXAMPLE", parent, "p")).state, "reserved");
		assert.equal((await items.reserveSlackReactions("p", t + 600, 0, true)).reads.length, 8);
		assert.equal((await items.reserveSlackReactions("p", t + 601, 0)).reads.length, 8);
		assert.equal((await items.reserveSlackReactions("p", t + 3_600_000 + 1_000)).reads.length, 8);
	} finally {
		await items.close();
	}
});
