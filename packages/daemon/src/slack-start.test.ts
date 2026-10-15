import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { TrackedItem, TrackingJson } from "@pilot/protocol";
import { ProjectStore } from "./projects.ts";
import { decodeMcpResult, dedicatedSourceTool, validSourceArguments } from "./source-mcp.ts";
import { SourceRegistry } from "./sources.ts";
import { TrackedItemStore, validatePatch } from "./tracked-items.ts";

type Response = Parameters<typeof decodeMcpResult>[0];
const parentTs = "1780000000.123456";
const input = {
	externalId: `CEXAMPLE/${parentTs}`,
	title: "Sample export question",
	url: `https://slack.com/archives/CEXAMPLE/p${parentTs.replace(".", "")}`,
	status: "open",
	metadata: { channel: "CEXAMPLE", channelName: "sample-bugs", thread_ts: parentTs, type: "question" },
	updatedAt: 1,
};

async function fixture(t: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "pilot-slack-start-"));
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: home, tracking: { slackChannels: ["CEXAMPLE"] } });
	const path = join(home, "tracked.sqlite");
	const items = new TrackedItemStore(path);
	await items.load([project.id]);
	const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
	let beforeWrite: (signal: AbortSignal) => Promise<void> = async () => {};
	let response: Response = { structuredContent: { ok: true } };
	const tracking = new SourceRegistry(projects, items, {
		async call(kind, tool, args, signal) {
			assert.equal(kind, "slack", "only the dedicated Slack source");
			if (tool === "reactions") return { present: false };
			assert.equal(dedicatedSourceTool(kind, tool), "slack_add_reaction");
			assert.ok(validSourceArguments(tool, args));
			assert.deepEqual(args, { channel_id: "CEXAMPLE", message_ts: parentTs, emoji: "eyes" });
			calls.push({ tool, args });
			await beforeWrite(signal);
			signal.throwIfAborted();
			return decodeMcpResult(response, tool);
		},
	});
	tracking.register("slack", async () => ({ items: [structuredClone(input)] }));
	await tracking.poll(`${project.id}:slack`);
	const item = (await items.list({ projectId: project.id })).items[0]!;
	t.after(async () => {
		await tracking.stop();
		await items.close();
		await rm(home, { recursive: true, force: true });
	});
	return {
		tracking,
		items,
		projects,
		project,
		item,
		path,
		calls,
		respond: (value: Response) => {
			response = value;
		},
		beforeWrite: (value: typeof beforeWrite) => {
			beforeWrite = value;
		},
	};
}

function outcome(item: TrackedItem): Record<string, TrackingJson> | undefined {
	return item.metadata.slackStart as Record<string, TrackingJson> | undefined;
}

test("confirmed chat and mission starts react on the parent without awaiting Slack; concurrent starts coalesce", async (t) => {
	for (const link of [{ sessionId: "chat-example" }, { missionId: "mission-example" }]) {
		const f = await fixture(t);
		let release!: () => void, entered!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const called = new Promise<void>((resolve) => {
			entered = resolve;
		});
		t.after(release);
		f.beforeWrite(async () => {
			entered();
			await gate;
		});
		const linked = await f.tracking.patch(f.item.id, { ...link, start: true });
		assert.equal(linked.sessionId ?? linked.missionId, Object.values(link)[0]);
		assert.equal(linked.slack?.status, "in_progress");
		const pending = f.tracking.startSlack(linked);
		assert.equal(f.tracking.startSlack(linked), pending);
		await called;
		assert.equal(outcome(await f.items.require(linked.id)), undefined, "no premature error while pending");
		release();
		await pending;
		const saved = await f.items.require(linked.id);
		assert.equal(outcome(saved)?.outcome, "reacted");
		assert.equal(typeof outcome(saved)?.attemptedAt, "number");
		assert.equal(outcome(saved)?.error, undefined);
		assert.equal(saved.updatedAt, f.item.updatedAt, "source timestamp stays source-owned");
		await f.tracking.patch(linked.id, { ...link, start: true });
		await f.tracking.patch(linked.id, { sessionId: "another-chat", start: true });
		await f.tracking.startSlack(linked);
		assert.equal(f.calls.length, 1, "new work, stale item snapshots and replay never react again");
		await f.tracking.patch(linked.id, { dismissed: true, sessionId: null, missionId: null });
		await f.tracking.patch(linked.id, { dismissed: false });
		assert.deepEqual(
			outcome(await f.items.require(linked.id)),
			outcome(saved),
			"unlink/dismiss never removes reaction outcome",
		);
	}
});

test("already_reacted in JSON, structured errors or MCP error text is successful and sanitized", async (t) => {
	for (const response of [
		{ structuredContent: { ok: false, error: "already_reacted" } },
		{ isError: true, structuredContent: { error: { code: "already_reacted", message: "private detail" } } },
		{ isError: true, content: [{ type: "text", text: "Slack API error: already_reacted (private detail)" }] },
		{ content: [{ type: "text", text: '{"ok":false,"error":"already_reacted"}' }] },
	]) {
		const f = await fixture(t);
		f.respond(response);
		const item = await f.tracking.patch(f.item.id, { sessionId: "chat", start: true });
		await f.tracking.startSlack(item);
		const saved = await f.items.require(item.id);
		assert.equal(outcome(saved)?.outcome, "reacted");
		assert.ok(!JSON.stringify(saved).includes("private detail"));
	}
});

test("failure is quiet, durable, never retried, visible in dashboard/Inbox and preserved by polling", async (t) => {
	const f = await fixture(t);
	f.respond({ isError: true, content: [{ type: "text", text: "missing_scope: private external detail" }] });
	const linked = await f.tracking.patch(f.item.id, { missionId: "mission", start: true });
	await f.tracking.startSlack(linked);
	const failed = await f.items.require(linked.id);
	assert.equal(failed.missionId, "mission");
	assert.equal(failed.slack?.status, "in_progress");
	assert.deepEqual(outcome(failed), {
		outcome: "error",
		attemptedAt: outcome(failed)?.attemptedAt,
		error: "Couldn't add eyes reaction in Slack.",
	});
	assert.ok(!JSON.stringify(failed).includes("private external"));
	assert.deepEqual(f.tracking.dashboard(f.project.id)[0]?.items[0]?.metadata?.slackStart, outcome(failed));
	assert.deepEqual((await f.tracking.inbox(f.project.id, 5)).slack?.items[0]?.metadata.slackStart, outcome(failed));
	await f.tracking.poll(`${f.project.id}:slack`);
	assert.deepEqual(outcome(await f.items.require(linked.id)), outcome(failed));
	const reopened = new TrackedItemStore(f.path);
	try {
		await reopened.load([f.project.id]);
		assert.deepEqual(outcome(await reopened.require(linked.id)), outcome(failed));
		assert.equal(await reopened.reserveSlackStart(linked.id), false);
	} finally {
		await reopened.close();
	}
	await f.tracking.patch(linked.id, { sessionId: "new-chat", start: true });
	await f.tracking.startSlack(linked);
	assert.equal(f.calls.length, 1);
});

test("ordinary/replayed links, Linear starts, invalid confirmation and polling never invoke the Slack write", async (t) => {
	const f = await fixture(t);
	await f.tracking.patch(f.item.id, { missionId: "existing" });
	await f.tracking.patch(f.item.id, { missionId: "existing", start: true });
	await f.tracking.poll(`${f.project.id}:slack`);
	for (const patch of [
		{ start: true },
		{ start: true, sessionId: "s", missionId: "m" },
		{ start: true, sessionId: null },
	])
		assert.throws(() => validatePatch(patch));
	await f.tracking.startSlack({ ...f.item, kind: "linear" });
	f.tracking.register("linear", async (context) => {
		for (const tool of ["startSlack", "startIssue", "doneSlack"])
			await assert.rejects(context.call(tool, {}), /cannot write/);
		return { items: [] };
	});
	await f.projects.update(f.project.id, { tracking: { linearTeam: "example", slackChannels: ["CEXAMPLE"] } });
	await f.tracking.poll(`${f.project.id}:linear`);
	assert.equal(f.calls.length, 0);
});

test("removed channel skips, malformed parent fails closed and legacy channel-name configuration is supported", async (t) => {
	for (const [channels, metadata, expected] of [
		[["COTHER"], input.metadata, "skipped"],
		[["CEXAMPLE"], { ...input.metadata, thread_ts: "not-a-timestamp" }, "error"],
		[["#sample-bugs"], input.metadata, "reacted"],
	] as const) {
		const f = await fixture(t);
		await f.projects.update(f.project.id, { tracking: { slackChannels: [...channels] } });
		await f.tracking.poll(`${f.project.id}:slack`);
		await f.items.commit(f.project.id, "slack", [{ ...input, metadata: { ...metadata } }]);
		await f.tracking.patch(f.item.id, { sessionId: "chat", start: true });
		await f.tracking.startSlack(await f.items.require(f.item.id));
		assert.equal(outcome(await f.items.require(f.item.id))?.outcome, expected);
		assert.equal(f.calls.length, expected === "reacted" ? 1 : 0);
	}
});

test("interrupted reservations recover as errors and remain consumed after restart", async (t) => {
	const f = await fixture(t);
	assert.equal(await f.items.reserveSlackStart(f.item.id), true);
	assert.equal(await f.items.reserveSlackStart(f.item.id), false);
	assert.equal(outcome(await f.items.require(f.item.id)), undefined);
	const reopened = new TrackedItemStore(f.path);
	try {
		await reopened.load([f.project.id]);
		assert.equal(outcome(await reopened.require(f.item.id))?.outcome, "error");
		assert.equal(await reopened.reserveSlackStart(f.item.id), false);
	} finally {
		await reopened.close();
	}
	await f.tracking.patch(f.item.id, { sessionId: "chat", start: true });
	await f.tracking.startSlack(f.item);
	assert.equal(f.calls.length, 0);
});

test("shutdown bounds a stuck reaction, persists failure and releases its slot", async (t) => {
	const f = await fixture(t);
	let entered!: () => void;
	const called = new Promise<void>((resolve) => {
		entered = resolve;
	});
	f.beforeWrite(async (signal) => {
		entered();
		await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
	});
	await f.tracking.patch(f.item.id, { sessionId: "chat", start: true });
	await called;
	await f.tracking.stop();
	assert.equal(outcome(await f.items.require(f.item.id))?.outcome, "error");
	assert.equal(f.calls.length, 1);
});

test("reaction admission shares two slots with reads and records overflow once", async (t) => {
	const f = await fixture(t);
	const gates = new Map<string, () => void>();
	f.tracking.register("linear", async (context) => {
		await new Promise<void>((resolve) => {
			gates.set(context.project.id, resolve);
			context.signal.addEventListener("abort", () => resolve(), { once: true });
		});
		return { items: [] };
	});
	await f.projects.update(f.project.id, { tracking: { linearTeam: "sample", slackChannels: ["CEXAMPLE"] } });
	await mkdir(join(f.project.path, "other"));
	const other = await f.projects.create({
		path: join(f.project.path, "other"),
		tracking: { linearTeam: "sample", slackChannels: [] },
	});
	const first = f.tracking.poll(`${f.project.id}:linear`);
	const second = f.tracking.poll(`${other.id}:linear`);
	t.after(() => {
		for (const release of gates.values()) release();
	});
	const linked = await f.tracking.patch(f.item.id, { sessionId: "chat", start: true });
	await f.tracking.startSlack(linked);
	assert.equal(outcome(await f.items.require(f.item.id))?.outcome, "error");
	for (const release of gates.values()) release();
	await Promise.all([first, second]);
	await f.tracking.patch(f.item.id, { missionId: "another-start", start: true });
	await f.tracking.startSlack(linked);
	assert.equal(f.calls.length, 0, "overflow has no retry queue after slots clear");
});

test("configuration changes cancel obsolete reactions without retrying", async (t) => {
	const f = await fixture(t);
	let entered!: () => void;
	const called = new Promise<void>((resolve) => {
		entered = resolve;
	});
	f.beforeWrite(async (signal) => {
		entered();
		await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
	});
	await f.tracking.patch(f.item.id, { sessionId: "chat", start: true });
	const pending = f.tracking.startSlack(f.item);
	await called;
	await f.projects.update(f.project.id, { tracking: { slackChannels: ["COTHER"] } });
	await pending;
	assert.equal(outcome(await f.items.require(f.item.id))?.outcome, "error");
	await f.tracking.startSlack(f.item);
	assert.equal(f.calls.length, 1);
});
