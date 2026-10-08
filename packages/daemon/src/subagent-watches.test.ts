import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { AgentEvent } from "@pilot/protocol";
import { startSubagentWatchWorker, type SubagentWatchUpdate, SubagentWatches } from "./subagent-watches.ts";

const snapshot = (ids: number[]): AgentEvent =>
	({
		type: "snapshot",
		entries: ids.map((id) => ({ id, kind: "note", data: { id } })),
		tools: [],
		compactions: [],
		inbox: [],
		agent: {},
		usage: { models: {}, tools: {} },
	}) as unknown as AgentEvent;
const appended = (id: number): AgentEvent =>
	({ type: "entry_appended", entry: { id, kind: "note", data: { id } } }) as unknown as AgentEvent;
const ids = (events: AgentEvent[]) =>
	events.flatMap((event) =>
		event.type === "snapshot"
			? event.entries.map((entry) => Number(entry.id))
			: event.type === "entry_appended"
				? [Number(event.entry.id)]
				: [],
	);

test("watches are shared, merge appended entries for late viewers, stop with the last viewer, and are bounded", () => {
	const started: Array<{ key: string; update: (update: SubagentWatchUpdate) => void; stopped: boolean }> = [];
	const watches = new SubagentWatches((directory, conversationId, update) => {
		const watch = { key: `${directory}/${conversationId}`, update, stopped: false };
		started.push(watch);
		return () => {
			watch.stopped = true;
		};
	}, 2);
	const first: AgentEvent[][] = [];
	const errors: string[] = [];
	const offFirst = watches.watch("/runs/a", "8", {
		events: (events) => first.push(events),
		error: (e) => errors.push(e),
	});
	const early: AgentEvent[][] = [];
	const offEarly = watches.watch("/runs/a", "8", { events: (events) => early.push(events), error: () => {} });
	assert.equal(started.length, 1);
	assert.deepEqual(early, [], "nothing is replayed before the first read");
	started[0]!.update({ full: true, events: [snapshot([1, 2])] });
	started[0]!.update({ full: false, events: [appended(3)] });
	assert.deepEqual(first.map(ids), [[1, 2], [3]]);
	assert.deepEqual(early.map(ids), [[1, 2], [3]]);
	const late: AgentEvent[][] = [];
	const offLate = watches.watch("/runs/a", "8", { events: (events) => late.push(events), error: () => {} });
	assert.deepEqual(late.map(ids), [[1, 2, 3]], "late viewers get one merged snapshot");
	started[0]!.update({ error: "locked" });
	assert.deepEqual(errors, ["locked"]);
	started[0]!.update({ full: true, events: [snapshot([5])] });
	const afterCompaction: AgentEvent[][] = [];
	watches.watch("/runs/a", "8", { events: (events) => afterCompaction.push(events), error: () => {} })();
	assert.deepEqual(afterCompaction.map(ids), [[5]], "full reads replace merged history");

	const offOther = watches.watch("/runs/b", "1", { events: () => {}, error: () => {} });
	assert.throws(() => watches.watch("/runs/c", "1", { events: () => {}, error: () => {} }), /Too many/);
	offFirst();
	offEarly();
	assert.equal(started[0]!.stopped, false);
	offLate();
	assert.equal(started[0]!.stopped, true);
	assert.equal(watches.size, 1);
	offOther();
	assert.equal(watches.size, 0);
});

test("the reader thread streams a snapshot and then only new entries from a live runs.sqlite", {
	timeout: 20_000,
}, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-subagent-watch-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const child = join(dir, "review.durable");
	await mkdir(child);
	const storage = await openNodeSqliteStorage(join(child, "runs.sqlite"));
	const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, context);
	const root = await harness.root(context, { agent: { model: { provider: "missing", modelId: "offline" } } });
	const append = (text: string) =>
		root.commit(async (tx) => {
			await tx.appendEntry(root.id, { kind: "note", data: { text } });
		}, context);
	await append("first");
	const updates: SubagentWatchUpdate[] = [];
	const stop = startSubagentWatchWorker(child, String(root.id), (update) => updates.push(update));
	try {
		const until = async (check: () => boolean) => {
			for (let n = 0; n < 200 && !check(); n++) await new Promise((resolve) => setTimeout(resolve, 25));
			assert.ok(check(), JSON.stringify(updates));
		};
		await until(() => updates.length === 1);
		const [initial] = updates;
		assert.ok(initial && "full" in initial && initial.full);
		assert.equal(initial.events[0]?.type, "snapshot");
		await new Promise((resolve) => setTimeout(resolve, 600));
		assert.equal(updates.length, 1, "an unchanged database posts nothing");
		await append("second");
		await until(() => updates.length === 2);
		const delta = updates[1]!;
		assert.ok("full" in delta && !delta.full);
		assert.deepEqual(
			delta.events.map((event) => event.type === "entry_appended" && event.entry.data),
			[{ text: "second" }],
		);
	} finally {
		stop();
		await harness.close(context);
	}
});
