import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
	type CompactionResult,
	createRegistry,
	createSession,
	Harness,
	InboxDoc,
	LiveDoc,
	type SubmissionId,
	type TaskId,
	UsageDoc,
	watchEvents,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { AttentionDoc } from "./attention.ts";
import {
	EARLIER_ENTRIES_MAX_BYTES,
	readEarlierEntries,
	readSessionSnapshot,
	readSubagentTranscript,
} from "./snapshot.ts";
import { openSessionReader, openSessionStorage, StorageBusy } from "./storage.ts";
import { subagentStorageSignature } from "./subagent-watch.ts";

test("cold snapshot matches durable active view under a writer lease, without running pending tools", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-cold-reader-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const durable = join(dir, "durable");
	const owned = await openSessionStorage(durable);
	const harness = await Harness.open(owned.storage, { models: createModels(), registry: createRegistry() }, context);
	try {
		const root = await harness.root(context, { agent: { model: { provider: "missing", modelId: "offline" } } });
		const kept = await root.commit(async (tx) => {
			tx.appendEntry(root.id, { kind: "old", data: { text: "not retained" } });
			return (await tx.appendEntry(root.id, { kind: "kept", data: { text: "retained" } })).id;
		}, context);
		await root.commit(async (tx) => {
			tx.appendEntry(root.id, { kind: "pi.compaction", head: kept, data: { summary: "summary" } });
			tx.appendEntry(root.id, { kind: "pilot.artifact", data: { artifact: { id: "artifact" } } });
			const live = await tx.doc(LiveDoc, root.id);
			live.run = { taskId: 900 as TaskId, inputs: [901 as SubmissionId] };
			live.generation = {
				attempt: 2,
				message: JSON.parse(JSON.stringify(fauxAssistantMessage("partial"))),
				retry: { at: 123, error: "offline" },
			};
			live.tools = [
				{
					callId: "call",
					name: "unsafe",
					taskId: 902 as TaskId,
					status: "running",
					output: "persisted output",
					droppedBytes: 3,
					details: { child: "id" },
				},
			];
			live.compactions = [
				{
					taskId: 903 as TaskId<CompactionResult>,
					reason: "manual",
					attempt: 1,
					blocking: false,
					retry: { at: 456, error: "retry" },
				},
			];
			const inbox = await tx.doc(InboxDoc, root.id);
			inbox.items = [
				{ id: 904 as SubmissionId, mode: "steer", content: "steer" },
				{ id: 905 as SubmissionId, mode: "followUp", content: [{ type: "text", text: "follow up" }] },
				{ id: 906 as SubmissionId, mode: "write", entry: { kind: "notice" } },
			];
			const job = await tx.createSubmission({
				conversationId: root.id,
				requestId: "native:jobs.result:abc",
				type: "input",
				status: "queued",
			});
			inbox.items.push({ id: job.id, mode: "followUp", content: "Background job tests done" });
			(await tx.doc(UsageDoc, root.id)).models["missing/offline"] = fauxAssistantMessage("usage").usage;
			(await tx.doc(AttentionDoc, root.id)).completion = {
				input: 899,
				entry: kept,
				outcome: "needs_input",
				outcomeAt: 50,
				outcomeReason: "approval",
			};
		}, context);
		// Exercise durable delta materialization as well as document checkpoints.
		await root.commit(async (tx) => {
			(await tx.doc(LiveDoc, root.id)).tools![0]!.output += " delta";
		}, context);
		const stream = await watchEvents(harness, root.id, context);
		const expected = structuredClone(stream.snapshot);
		await stream.stop();
		await assert.rejects(openSessionStorage(durable), StorageBusy);
		const view = await readSessionSnapshot(durable, dir);
		assert.deepEqual(view.events[0], expected);
		assert.equal(view.completion, undefined, "a running session must not publish an old completion");
		const queue = view.events[1];
		assert.equal(queue?.type, "queue_update");
		assert.deepEqual(queue.items, [
			{ id: 904, mode: "steer", content: "steer" },
			{ id: 905, mode: "followUp", content: [{ type: "text", text: "follow up" }] },
		]);
		assert.deepEqual(
			queue.automatic?.map(({ id, origin, mode, preview }) => ({ id, origin, mode, preview })),
			[{ id: 11, origin: "job", mode: "followUp", preview: "Background job tests done" }],
			"a cold snapshot lists waiting automatic input separately",
		);
		const reader = await openSessionReader(durable);
		assert.ok(reader);
		await assert.rejects(reader.commit([], context), /read-only/);
		const readonlySession = createSession(reader);
		await root.commit(async (tx) => {
			(await tx.doc(LiveDoc, root.id)).tools![0]!.output = "newer writer commit";
		}, context);
		assert.equal(
			(await readonlySession.snapshot(LiveDoc, root.id, context))?.tools?.[0]?.output,
			"persisted output delta",
			"the whole view stays on one committed SQLite revision",
		);
		await readonlySession.close(context);
		await root.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, root.id);
			delete live.run;
			delete live.generation;
			delete live.tools;
		}, context);
		await root.commit(async (tx) => {
			await tx.appendEntry(root.id, { kind: "pi.reset", head: "self" });
			await tx.appendEntry(root.id, { kind: "after-reset", data: { text: "fresh" } });
		}, context);
		const resetStream = await watchEvents(harness, root.id, context);
		const resetView = await readSessionSnapshot(durable, dir);
		assert.deepEqual(resetView.events[0], resetStream.snapshot);
		assert.deepEqual(
			resetStream.snapshot.entries.map((entry) => entry.kind),
			["pi.reset", "after-reset"],
		);
		await resetStream.stop();
	} finally {
		await harness.close(context);
		owned.release();
	}
	try {
		const before = await readFile(join(durable, "harness.sqlite"));
		const view = await readSessionSnapshot(durable, dir);
		assert.deepEqual(view.completion, { outcome: "done", outcomeAt: 50 });
		assert.deepEqual(await readSessionSnapshot(durable, dir), view, "restart reads keep the completion version");
		assert.deepEqual(await readFile(join(durable, "harness.sqlite")), before, "no durable write or WAL checkpoint");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("cold reader rejects unsupported schemas instead of migrating or creating a writer lease", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-cold-schema-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const owned = await openSessionStorage(dir);
	await owned.storage.close(context);
	owned.release();
	const file = join(dir, "harness.sqlite");
	const db = new DatabaseSync(file);
	db.exec("UPDATE durable_schema SET version = version + 1");
	db.close();
	const before = await readFile(file);
	await assert.rejects(openSessionReader(dir), /Unsupported durable snapshot schema/);
	assert.deepEqual(await readFile(file), before);
});

test("cold snapshot of an unopened session creates no storage and ignores legacy TODO files", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-cold-unopened-"));
	try {
		await mkdir(join(dir, ".pi", "todos"), { recursive: true });
		await writeFile(
			join(dir, ".pi", "todos", "aabbccdd.md"),
			'{"title":"Check","status":"open","created_at":"today"}\nNotes',
		);
		const view = await readSessionSnapshot(join(dir, "durable"), dir);
		assert.equal(view.events[0]?.type, "snapshot");
		assert.deepEqual(
			view.events.find((event) => event.type === "github_actions_update"),
			{ type: "github_actions_update", actions: [] },
		);
		assert.deepEqual(
			view.events.find((event) => event.type === "todos_update"),
			{
				type: "todos_update",
				items: [],
			},
		);
		assert.deepEqual(await readdir(dir), [".pi"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("Ask cold snapshots return empty TODOs without reading live checkout extension files", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-cold-ask-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await mkdir(join(dir, ".pi", "todos"), { recursive: true });
	await writeFile(join(dir, ".pi", "todos", "aabbccdd.md"), '{"title":"Live checkout only","status":"open"}');
	const durable = join(dir, "durable");
	const unopened = await readSessionSnapshot(durable, dir, false);
	assert.deepEqual(
		unopened.events.find((event) => event.type === "todos_update"),
		{ type: "todos_update", items: [] },
	);
	assert.deepEqual(await readdir(dir), [".pi"]);
	const owned = await openSessionStorage(durable);
	const harness = await Harness.open(owned.storage, { models: createModels(), registry: createRegistry() }, context);
	try {
		await harness.root(context, { agent: { model: { provider: "missing", modelId: "offline" } } });
		const persisted = await readSessionSnapshot(durable, dir, false);
		assert.deepEqual(
			persisted.events.find((event) => event.type === "todos_update"),
			{ type: "todos_update", items: [] },
		);
	} finally {
		await harness.close(context);
		owned.release();
	}
});

test("subagent transcripts read fully, then incrementally, and fall back to full reads after compaction", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-cold-subagent-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const child = join(dir, "review.durable");
	assert.deepEqual(await readSubagentTranscript(child, "1"), { full: true, events: [] }, "no storage before start");
	const missing = subagentStorageSignature(child);
	await mkdir(child);
	const storage = await openNodeSqliteStorage(join(child, "runs.sqlite"));
	const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, context);
	try {
		const root = await harness.root(context, { agent: { model: { provider: "missing", modelId: "offline" } } });
		const append = (text: string, head?: number) =>
			root.commit(async (tx) => {
				const entry = await tx.appendEntry(root.id, {
					kind: head === undefined ? "note" : "pi.compaction",
					data: { text },
					...(head === undefined ? {} : { head: head as never }),
				});
				return Number(entry.id);
			}, context);
		const first = await append("first");
		const full = await readSubagentTranscript(child, String(root.id));
		assert.equal(full.full, true);
		assert.equal(full.cursor, first);
		const [snapshot] = full.events;
		assert.ok(snapshot?.type === "snapshot");
		assert.deepEqual(
			snapshot.entries.map((entry) => entry.data),
			[{ text: "first" }],
		);
		const before = subagentStorageSignature(child);
		assert.notEqual(before, missing);
		assert.deepEqual(await readSubagentTranscript(child, String(root.id), first), {
			full: false,
			events: [],
			cursor: first,
		});
		const second = await append("second");
		const third = await append("third");
		assert.notEqual(subagentStorageSignature(child), before, "every commit changes the signature");
		const delta = await readSubagentTranscript(child, String(root.id), first);
		assert.equal(delta.full, false);
		assert.equal(delta.cursor, third);
		assert.deepEqual(
			delta.events.map((event) =>
				event.type === "entry_appended" ? [Number(event.entry.id), event.entry.data] : event,
			),
			[
				[second, { text: "second" }],
				[third, { text: "third" }],
			],
		);
		await append("summary", third);
		const compacted = await readSubagentTranscript(child, String(root.id), third);
		assert.equal(compacted.full, true, "a moved head marker needs a full replacement");
		await assert.rejects(readSubagentTranscript(child, "not-a-number"), /Invalid subagent conversation/);
		await assert.rejects(readSubagentTranscript(child, String(root.id), -1), /Invalid cursor/);
	} finally {
		await harness.close(context);
	}
});

test("earlier entries page backwards through history hidden by compaction, under a writer lease", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-cold-earlier-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const durable = join(dir, "durable");
	assert.deepEqual(await readEarlierEntries(durable, 10, 5), { entries: [], more: false }, "no storage yet");
	const owned = await openSessionStorage(durable);
	const harness = await Harness.open(owned.storage, { models: createModels(), registry: createRegistry() }, context);
	try {
		const root = await harness.root(context, { agent: { model: { provider: "missing", modelId: "offline" } } });
		const ids = await root.commit(async (tx) => {
			const ids: number[] = [];
			for (let index = 0; index < 5; index++)
				ids.push(Number((await tx.appendEntry(root.id, { kind: "note", data: { index } })).id));
			return ids;
		}, context);
		const kept = ids[3]!;
		await root.commit(async (tx) => {
			await tx.appendEntry(root.id, { kind: "pi.compaction", head: kept as never, data: { summary: "summary" } });
		}, context);
		const [snapshot] = (await readSessionSnapshot(durable, dir, false)).events;
		assert.ok(snapshot?.type === "snapshot");
		assert.ok(
			snapshot.entries.every((entry) => Number(entry.id) >= kept || entry.head !== undefined),
			"the active view hides entries before the head",
		);

		const first = await readEarlierEntries(durable, kept, 2);
		assert.deepEqual(
			first.entries.map((entry) => entry.data),
			[{ index: 1 }, { index: 2 }],
			"newest page first, returned oldest first",
		);
		assert.equal(first.more, true);
		const second = await readEarlierEntries(durable, Number(first.entries[0]!.id), 2);
		assert.deepEqual(
			second.entries.map((entry) => entry.data),
			[{ index: 0 }],
		);
		assert.equal(second.more, false);
		assert.deepEqual(await readEarlierEntries(durable, ids[0]!, 2), { entries: [], more: false });
		await assert.rejects(readEarlierEntries(durable, -1, 2), /Invalid cursor/);
		await assert.rejects(readEarlierEntries(durable, kept, 0), /Invalid limit/);
	} finally {
		await harness.close(context);
		owned.release();
	}
});

test("an earlier-entries page ends early once it is large, but always returns one entry", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-cold-earlier-large-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const durable = join(dir, "durable");
	const owned = await openSessionStorage(durable);
	const harness = await Harness.open(owned.storage, { models: createModels(), registry: createRegistry() }, context);
	try {
		const root = await harness.root(context, { agent: { model: { provider: "missing", modelId: "offline" } } });
		const big = "x".repeat(EARLIER_ENTRIES_MAX_BYTES);
		const last = await root.commit(async (tx) => {
			await tx.appendEntry(root.id, { kind: "note", data: { text: big } });
			await tx.appendEntry(root.id, { kind: "note", data: { text: big } });
			return Number((await tx.appendEntry(root.id, { kind: "note", data: { text: "tail" } })).id);
		}, context);
		const page = await readEarlierEntries(durable, last, 100);
		assert.equal(page.entries.length, 1, "one oversized entry fills the page");
		assert.equal(page.more, true);
	} finally {
		await harness.close(context);
		owned.release();
	}
});
