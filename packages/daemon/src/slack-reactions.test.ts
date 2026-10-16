// biome-ignore-all lint/complexity/useLiteralKeys: Inspect the bounded background-drain seam in offline fixtures.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { TrackedItem } from "@pilot/protocol";
import { ProjectStore } from "./projects.ts";
import { decodeMcpResult, dedicatedSourceTool, validSourceArguments } from "./source-mcp.ts";
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
async function until(check: () => boolean | Promise<boolean>) {
	const deadline = performance.now() + 10_000;
	while (!(await check())) {
		assert.ok(performance.now() < deadline, "fixture did not settle");
		await delay(1);
	}
}
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
	let read: Response = { structuredContent: { reactions: [] } },
		write: Response = { structuredContent: { ok: true } };
	let removal: Response | Error = { structuredContent: { ok: true } };
	let beforeRead = async (_signal: AbortSignal) => {},
		beforeWrite = async (_signal: AbortSignal) => {},
		beforeRemoval = async (_signal: AbortSignal) => {};
	const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
	const registry = new SourceRegistry(projects, items, {
		async call(kind, tool, args, signal) {
			assert.equal(kind, "slack");
			assert.ok(validSourceArguments(tool, args));
			if (tool === "removeSlackEyes") {
				calls.push({ tool, args });
				assert.deepEqual(args, { channel_id: "CEXAMPLE", message_ts: parent, emoji: "eyes" });
				await beforeRemoval(signal);
				signal.throwIfAborted();
				if (removal instanceof Error) throw removal;
				return decodeMcpResult(removal, tool);
			}
			assert.equal(
				dedicatedSourceTool(kind, tool),
				tool === "reactions" ? "slack_get_reactions" : "slack_add_reaction",
			);
			calls.push({ tool, args });
			if (tool === "reactions") {
				assert.deepEqual(args, { channel_id: "CEXAMPLE", message_ts: parent });
				await beforeRead(signal);
				signal.throwIfAborted();
				return decodeMcpResult(read, tool);
			}
			assert.equal(tool, "doneSlack");
			assert.deepEqual(args, { channel_id: "CEXAMPLE", message_ts: parent, emoji: "white_check_mark" });
			await beforeWrite(signal);
			signal.throwIfAborted();
			return decodeMcpResult(write, tool);
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
		write: (value: Response) => {
			write = value;
		},
		removal: (value: Response | Error) => {
			removal = value;
		},
		beforeRemoval: (value: typeof beforeRemoval) => {
			beforeRemoval = value;
		},
		beforeRead: (value: typeof beforeRead) => {
			beforeRead = value;
		},
		beforeWrite: (value: typeof beforeWrite) => {
			beforeWrite = value;
		},
		eyes: async () => {
			assert.equal(await items.reserveSlackStart(item.id), true);
			await items.slackStartResult(item.id, "reacted");
		},
		drain: () => until(() => registry["doneRuns"].size === 0 && registry["doneDue"].size === 0),
	};
}

test("all Done routes add one check and remove eyes on the parent only after a successful eyes outcome", async (t) => {
	for (const route of ["manual", "merge", "mission", "reaction"]) {
		const f = await fixture(t);
		await f.eyes();
		if (route === "manual") await f.registry.patch(f.item.id, { slack: { status: "done" } });
		if (route === "reaction") {
			f.read(checked());
			await f.poll();
		}
		if (route === "merge") {
			await f.items.patch(f.item.id, { sessionId: "chat" });
			const pr = {
				number: 42,
				url: "https://github.com/example/sample/pull/42",
				title: "Invented",
				state: "open" as const,
				checkedAt: 10,
			};
			await f.items.observeSlackPullRequests({
				projectId: f.project.id,
				sessionId: "chat",
				prs: [pr],
				pending: false,
			});
			await f.items.observeSlackPullRequests({
				projectId: f.project.id,
				sessionId: "chat",
				prs: [{ ...pr, state: "merged", checkedAt: 20 }],
				pending: false,
			});
		}
		if (route === "mission") {
			await f.items.patch(f.item.id, { missionId: "example-work" });
			await f.items.completeSlackMission(f.project.id, "example-work", 20);
		}
		await until(async () => outcome(await f.items.require(f.item.id)) === "reacted");
		assert.equal((await f.items.require(f.item.id)).slack?.status, "done");
		assert.equal((await f.items.require(f.item.id)).updatedAt, 1);
		assert.equal(
			(await f.items.require(f.item.id)).metadata.slackStart &&
				((await f.items.require(f.item.id)).metadata.slackStart as { outcome: string }).outcome,
			"reacted",
		);
		await f.drain();
		await f.poll();
		await f.drain();
		assert.equal(f.calls.filter((call) => call.tool === "doneSlack").length, 1);
		assert.equal(f.calls.filter((call) => call.tool === "removeSlackEyes").length, 1);
		assert.ok(
			f.calls.every((call) => ["doneSlack", "removeSlackEyes", "reactions"].includes(call.tool)),
			"no messages or fallback tool",
		);
	}
});

test("failed removal keeps Done and the check successful, logs one safe line, and never retries", async (t) => {
	const warnings: unknown[][] = [];
	t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args));
	for (const error of ["no_reaction", "not authorized", "unconfigured", "unreachable"]) {
		const f = await fixture(t);
		await f.eyes();
		f.removal(
			["unconfigured", "unreachable"].includes(error)
				? new Error(`${error}: private fixture detail`)
				: { isError: true, content: [{ type: "text", text: `${error}: private fixture detail` }] },
		);
		await f.registry.patch(f.item.id, { slack: { status: "done" } });
		await f.drain();
		assert.equal(outcome(await f.items.require(f.item.id)), "reacted");
		assert.equal((await f.items.require(f.item.id)).slack?.status, "done");
		await f.poll();
		await f.registry.patch(f.item.id, { slack: { status: "open" } });
		await f.registry.patch(f.item.id, { slack: { status: "done" } });
		await f.drain();
		assert.equal(f.calls.filter((call) => call.tool === "removeSlackEyes").length, 1);
		const reopened = new TrackedItemStore(f.path);
		try {
			assert.equal(await reopened.reserveSlackDone(f.project.id), undefined);
		} finally {
			await reopened.close();
		}
	}
	assert.deepEqual(warnings, Array(4).fill(["pilotd: Slack eyes removal skipped or failed; no retry"]));
});

test("missing, failed and pending eyes outcomes never remove any reaction", async (t) => {
	for (const start of ["missing", "pending", "error"]) {
		const f = await fixture(t);
		if (start !== "missing") await f.items.reserveSlackStart(f.item.id);
		if (start === "error") await f.items.slackStartResult(f.item.id, "error");
		await f.registry.patch(f.item.id, { slack: { status: "done" } });
		await f.drain();
		assert.equal(f.calls.filter((call) => call.tool !== "reactions").length, 0);
	}
});

test("a cancelled removal never turns an already persisted check into an error", async (t) => {
	const f = await fixture(t),
		entered = gate();
	await f.eyes();
	f.beforeRemoval(async (signal) => {
		entered.release();
		await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
	});
	await f.registry.patch(f.item.id, { slack: { status: "done" } });
	await entered.promise;
	assert.equal(outcome(await f.items.require(f.item.id)), "reacted");
	await f.registry.stop();
	assert.equal(outcome(await f.items.require(f.item.id)), "reacted");
	assert.equal((await f.items.require(f.item.id)).slack?.status, "done");
	assert.equal(await f.items.reserveSlackDone(f.project.id), undefined);
});

test("normal source reads cannot invoke the configured removal write", async (t) => {
	const f = await fixture(t, async (context) => {
		await assert.rejects(
			context.call("removeSlackEyes", { channel_id: "CEXAMPLE", message_ts: parent, emoji: "eyes" }),
			/cannot write/,
		);
		return { items: [] };
	});
	await f.poll();
	assert.equal(f.calls.filter((call) => call.tool === "removeSlackEyes").length, 0);
});

test("anyone's check closes Open/In progress, but not Done/Dismissed; reopen survives counts and refresh", async (t) => {
	const f = await fixture(t);
	f.read(checked());
	await f.poll();
	let saved = await f.items.require(f.item.id);
	assert.equal(saved.slack?.doneReason, "Done · ✅ in Slack");
	assert.ok(saved.metadata.reactionDone);
	assert.equal(f.calls.filter((call) => call.tool === "doneSlack").length, 0, "no eyes outcome, no write");
	await f.items.patch(f.item.id, { slack: { status: "open" } });
	f.read(checked(3));
	await f.poll();
	assert.equal((await f.items.require(f.item.id)).slack?.status, "open");
	f.read({ structuredContent: { reactions: [] } });
	await f.poll();
	f.read(checked());
	await f.poll();
	assert.equal(
		(await f.items.require(f.item.id)).slack?.status,
		"done",
		"observed removal then re-add is a new reaction",
	);
	await f.items.patch(f.item.id, { dismissed: true });
	const reads = f.calls.length;
	await f.poll();
	assert.equal(f.calls.length, reads, "Done/Dismissed rows are not read");
	saved = await f.items.require(f.item.id);
	assert.equal(saved.slack?.status, "dismissed");
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

test("a check written on manual Done does not undo reopening, and starting work does not consume a new check", async (t) => {
	const f = await fixture(t);
	await f.eyes();
	await f.items.patch(f.item.id, { sessionId: "new-chat", start: true });
	f.read(checked());
	await f.poll();
	assert.equal((await f.items.require(f.item.id)).slack?.status, "done", "In progress can close on a new check");
	await until(async () => outcome(await f.items.require(f.item.id)) === "reacted");
	await f.drain();
	await f.items.patch(f.item.id, { slack: { status: "open" } });
	await f.poll();
	assert.equal((await f.items.require(f.item.id)).slack?.status, "open");
	await f.items.patch(f.item.id, { slack: { status: "done" } });
	await f.items.patch(f.item.id, { slack: { status: "open" } });
	await f.poll();
	await f.drain();
	assert.equal((await f.items.require(f.item.id)).slack?.status, "open");
	assert.equal(f.calls.filter((call) => call.tool === "doneSlack").length, 1);
});

test("a spent read budget defers only reaction checks, not discovery or Done writes", async (t) => {
	const f = await fixture(t);
	await f.eyes();
	for (let i = 0; i < 100; i++) await f.items.reserveSlackReactions(f.project.id, Date.now(), 0);
	const reads = f.calls.filter((call) => call.tool === "reactions").length;
	await f.poll();
	assert.equal(f.registry.require(`${f.project.id}:slack`).status, "ok");
	assert.equal(f.calls.filter((call) => call.tool === "reactions").length, reads);
	await f.items.patch(f.item.id, { slack: { status: "done" } });
	await until(async () => outcome(await f.items.require(f.item.id)) === "reacted");
});

test("interrupted Done admissions recover as quiet errors without retrying", async (t) => {
	const f = await fixture(t);
	await f.registry.stop();
	await f.eyes();
	await f.items.patch(f.item.id, { slack: { status: "done" } });
	assert.ok(await f.items.reserveSlackDone(f.project.id));
	assert.equal(await f.items.reserveSlackDone(f.project.id), undefined);
	const reopened = new TrackedItemStore(f.path);
	try {
		assert.equal(outcome(await reopened.require(f.item.id)), "error");
		assert.equal((await reopened.require(f.item.id)).slack?.status, "done");
		assert.equal(await reopened.reserveSlackDone(f.project.id), undefined);
	} finally {
		await reopened.close();
	}
});

test("write failure is quiet, once-only and durable; already_reacted succeeds and source refresh preserves outcomes", async (t) => {
	for (const [response, expected] of [
		[{ isError: true, content: [{ type: "text", text: "missing_scope: invented private error" }] }, "error"],
		[{ isError: true, structuredContent: { error: "already_reacted" } }, "reacted"],
	] satisfies [Response, string][]) {
		const f = await fixture(t);
		await f.eyes();
		f.write(response);
		await f.items.patch(f.item.id, { slack: { status: "done" } });
		await until(async () => outcome(await f.items.require(f.item.id)) === expected);
		await f.drain();
		const saved = await f.items.require(f.item.id);
		assert.equal(saved.slack?.status, "done");
		assert.ok(!JSON.stringify(saved).includes("invented private"));
		await f.items.commit(f.project.id, "slack", [{ ...input, updatedAt: 2 }]);
		await f.items.patch(f.item.id, { slack: { status: "open" } });
		await f.poll();
		await f.drain();
		assert.equal(f.calls.filter((call) => call.tool === "doneSlack").length, 1);
		const reopened = new TrackedItemStore(f.path);
		try {
			assert.equal(outcome(await reopened.require(f.item.id)), expected);
			await reopened.patch(f.item.id, { slack: { status: "done" } });
			assert.equal(await reopened.reserveSlackDone(f.project.id), undefined);
		} finally {
			await reopened.close();
		}
	}
});

test("reaction reads are capped, rotate fairly, wait between checks and share the durable daily Slack budget", async () => {
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
		assert.equal(used, 100);
		assert.deepEqual(await items.reserveSlackReactions("p", t + 600, 0), { reads: [], budget: true });
		assert.equal((await items.reserveSlack("CEXAMPLE", parent, t + 600, "p")).state, "budget");
		assert.equal((await items.reserveSlackReactions("p", 86_400_000)).reads.length, 8);
	} finally {
		await items.close();
	}
});

test("channel removal, reopen and shutdown cancel pending writes without retrying or overriding local status", async (t) => {
	for (const action of ["remove", "reopen", "stop"]) {
		const f = await fixture(t),
			entered = gate();
		await f.eyes();
		f.beforeWrite(async (signal) => {
			entered.release();
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
		});
		await f.items.patch(f.item.id, { slack: { status: "done" } });
		await entered.promise;
		if (action === "remove") await f.projects.update(f.project.id, { tracking: { slackChannels: [] } });
		else if (action === "reopen") await f.registry.patch(f.item.id, { slack: { status: "open" } });
		else await f.registry.stop();
		await until(async () => outcome(await f.items.require(f.item.id)) === "error");
		assert.equal((await f.items.require(f.item.id)).slack?.status, action === "reopen" ? "open" : "done");
		assert.equal(f.calls.filter((call) => call.tool === "doneSlack").length, 1);
	}
});

test("Done writes wait for admission and share the global two-slot bound with normal polls", async (t) => {
	const f = await fixture(t);
	await f.eyes();
	await f.drain();
	const linearEntered = gate(),
		slackEntered = gate(),
		releaseLinear = gate(),
		releaseSlack = gate();
	t.after(() => {
		releaseLinear.release();
		releaseSlack.release();
	});
	await f.projects.update(f.project.id, { tracking: { linearTeam: "EXAMPLE", slackChannels: ["CEXAMPLE"] } });
	f.registry.register("linear", async () => {
		linearEntered.release();
		await releaseLinear.promise;
		return { items: [] };
	});
	f.beforeRead(async () => {
		slackEntered.release();
		await releaseSlack.promise;
	});
	const linear = f.registry.poll(`${f.project.id}:linear`);
	await linearEntered.promise;
	const slack = f.poll();
	await slackEntered.promise;
	await f.registry.patch(f.item.id, { slack: { status: "done" } });
	assert.equal(f.calls.filter((call) => call.tool === "doneSlack").length, 0);
	assert.equal(f.registry["busy"](), 2);
	releaseSlack.release();
	await slack;
	await until(async () => outcome(await f.items.require(f.item.id)) === "reacted");
	assert.ok(f.registry["busy"]() <= 2);
	releaseLinear.release();
	await linear;
	await f.drain();
	assert.equal(f.calls.filter((call) => call.tool === "doneSlack").length, 1);
});
