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
import { queueGuardToken } from "./queue.ts";
import {
	DIAGNOSTIC_HISTORY_ENTRY_MAX_BYTES,
	DIAGNOSTIC_HISTORY_MAX_BYTES,
	DIAGNOSTIC_HISTORY_MAX_SCANNED_ENTRIES,
	EARLIER_ENTRIES_MAX_BYTES,
	readDiagnosticHistoryPage,
	readEarlierEntries,
	readSessionSnapshot,
	readSubagentTranscript,
} from "./snapshot.ts";
import { openSessionReader, openSessionStorage, StorageBusy } from "./storage.ts";
import { subagentStorageSignature } from "./subagent-watch.ts";

test("paged cold snapshot and pinned older pages preserve metadata and exact legacy entries", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-paged-reader-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const owned = await openSessionStorage(dir);
	const harness = await Harness.open(owned.storage, { models: createModels(), registry: createRegistry() }, context);
	try {
		const root = await harness.root(context);
		const empty = (await readSessionSnapshot(dir, dir, true, true)).events[0];
		assert.equal(empty?.type, "snapshot");
		assert.deepEqual(empty.entries, []);
		assert.equal(empty.history?.more, false, "existing empty storage is distinguishable from missing storage");
		await root.commit(async (tx) => {
			for (let i = 0; i < 300; i++)
				await tx.appendEntry(root.id, {
					kind: "pi.user",
					model: [{ role: "user", content: `exact 日本 ${i}`, timestamp: i }],
				});
			(await tx.doc(LiveDoc, root.id)).run = { taskId: 900 as TaskId, inputs: [901 as SubmissionId] };
		}, context);
		const legacy = (await readSessionSnapshot(dir, dir)).events[0];
		const recent = (await readSessionSnapshot(dir, dir, true, true)).events[0];
		assert.equal(legacy?.type, "snapshot");
		assert.equal(recent?.type, "snapshot");
		assert.equal(recent.entries.length, 60);
		assert.deepEqual(recent.run, legacy.run);
		assert.ok(recent.history?.more);
		const entries = [...recent.entries];
		let before = recent.history.before;
		// Live appends never change the immutable range covered by the captured pages.
		await root.commit(async (tx) => {
			await tx.appendEntry(root.id, { kind: "new-live" });
		}, context);
		while (before !== undefined) {
			const page = await readEarlierEntries(dir, before, 24, recent.history.context);
			assert.deepEqual(page.context, recent.history.context);
			assert.equal(page.before, before);
			entries.unshift(...page.entries);
			before = page.nextBefore;
		}
		assert.deepEqual(entries, legacy.entries);
		assert.deepEqual(await readEarlierEntries(dir, 0, 24, recent.history.context), {
			entries: [],
			more: false,
			context: recent.history.context,
			before: 0,
		});
	} finally {
		await harness.close(context);
		owned.release();
	}
	await assert.rejects(readEarlierEntries(join(dir, "missing"), 4, 24, { conversationId: 0, tail: 4 }), /unavailable/);
	await assert.rejects(readSessionSnapshot(join(dir, "missing"), dir, true, true), /unavailable/);
	const legacyMissing = (await readSessionSnapshot(join(dir, "missing"), dir)).events[0];
	assert.equal(legacyMissing?.type, "snapshot");
	assert.deepEqual(legacyMissing.entries, [], "legacy missing-storage behavior is unchanged");
});

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
		assert.deepEqual(
			queue.items,
			[
				{ id: 904, mode: "steer", content: "steer" },
				{ id: 905, mode: "followUp", content: [{ type: "text", text: "follow up" }] },
			].map((item) => ({ ...item, guardToken: queueGuardToken(item) })),
		);
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

test("cold reader reads a schema 1 store without migrating it", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-cold-schema-1-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const owned = await openSessionStorage(dir);
	const harness = await Harness.open(owned.storage, { models: createModels(), registry: createRegistry() }, context);
	const root = await harness.root(context);
	await root.commit(async (tx) => {
		await tx.appendEntry(root.id, { kind: "before-upgrade", data: { text: "kept" } });
	}, context);
	await harness.close(context);
	owned.release();
	const file = join(dir, "harness.sqlite");
	const db = new DatabaseSync(file);
	db.exec("UPDATE durable_schema SET version = 1");
	db.close();
	const before = await readFile(file);
	const view = await readSessionSnapshot(dir, dir);
	const snapshot = view.events[0];
	assert.equal(snapshot?.type, "snapshot");
	assert.deepEqual(
		snapshot.entries.map((entry) => entry.kind),
		["before-upgrade"],
	);
	assert.deepEqual(await readFile(file), before, "the reader leaves the schema for the worker to migrate");
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

test("diagnostic history cold-reads active and compacted entries with explicit byte bounds and cursors", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-diagnostic-history-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const durable = join(dir, "durable");
	const target = {
		host: { hostId: "local", daemonId: "daemon", lineageId: "lineage" },
		sessionId: "01234567-89ab-4cde-8fab-0123456789ab",
		chatUrl: "pilot://chat/01234567-89ab-4cde-8fab-0123456789ab",
	};
	const missing = await readDiagnosticHistoryPage(durable, target, undefined, 2);
	assert.deepEqual(missing.source, {
		availability: "missing",
		freshness: "unavailable",
		reason: "storage_missing",
	});

	const owned = await openSessionStorage(durable);
	const harness = await Harness.open(owned.storage, { models: createModels(), registry: createRegistry() }, context);
	try {
		const root = await harness.root(context, { agent: { model: { provider: "missing", modelId: "offline" } } });
		const ids = await root.commit(async (tx) => {
			const first = await tx.appendEntry(root.id, {
				kind: "pi.user",
				model: [{ role: "user", content: "old question", timestamp: 1 }],
			});
			const tool = await tx.appendEntry(root.id, {
				kind: "pi.tool-result",
				apiKey: "credential-secret",
				model: [
					{
						role: "toolResult",
						toolCallId: "call-1",
						toolName: "read",
						content: [
							{ type: "image", data: "attachment-secret", mimeType: "image/png" } as never,
							{ type: "text", text: "Bearer inline-secret" },
							{ type: "text", text: "é".repeat(DIAGNOSTIC_HISTORY_ENTRY_MAX_BYTES) },
						],
						isError: false,
						timestamp: 2,
					},
				],
			} as never);
			const tail = await tx.appendEntry(root.id, {
				kind: "pi.assistant",
				model: [
					fauxAssistantMessage([
						{ type: "thinking", thinking: "private-reasoning", thinkingSignature: "opaque-signature" },
						{ type: "text", text: "newest" },
					]),
				],
			});
			await tx.appendEntry(root.id, { kind: "note", data: { mustNotAppear: true } });
			return [Number(first.id), Number(tool.id), Number(tail.id)];
		}, context);

		const newest = await readDiagnosticHistoryPage(durable, target, undefined, 2);
		assert.deepEqual(newest.source, { availability: "available", freshness: "fresh" });
		assert.deepEqual(
			newest.entries.map((entry) => entry.entryId),
			ids.slice(1),
			"page output is chronological even though storage scans newest first",
		);
		assert.equal(newest.pagination.more, true);
		assert.equal(newest.pagination.nextBefore, ids[1]);
		assert.equal(newest.pagination.scannedEntries, 3, "internal state is skipped under an explicit scan bound");
		assert.doesNotMatch(JSON.stringify(newest), /mustNotAppear|"kind":"note"/);
		assert.equal(newest.entries[0]?.truncated, true);
		assert.doesNotMatch(newest.entries[0]!.excerpt, /attachment-secret/);
		assert.doesNotMatch(newest.entries[0]!.excerpt, /credential-secret/);
		assert.doesNotMatch(newest.entries[0]!.excerpt, /inline-secret/);
		assert.match(newest.entries[0]!.excerpt, /"apiKey":"\[REDACTED\]"/);
		assert.doesNotMatch(newest.entries[1]!.excerpt, /private-reasoning|opaque-signature/);
		assert.match(newest.entries[1]!.excerpt, /"omitted":"private_reasoning"/);
		assert.match(newest.entries[0]!.excerpt, /"omitted":"attachment"/);
		assert.ok(Buffer.byteLength(newest.entries[0]!.excerpt) <= DIAGNOSTIC_HISTORY_ENTRY_MAX_BYTES);
		assert.ok(newest.pagination.encodedBytes <= DIAGNOSTIC_HISTORY_MAX_BYTES);
		assert.equal(newest.pagination.truncatedEntries, 1);

		const older = await readDiagnosticHistoryPage(durable, target, newest.pagination.nextBefore, 2);
		assert.deepEqual(
			older.entries.map((entry) => entry.entryId),
			[ids[0]],
		);
		assert.equal(older.pagination.more, false);
		assert.equal(older.pagination.before, ids[1]);
		assert.match(older.entries[0]!.ref, new RegExp(`${target.sessionId}:${ids[0]}$`));
	} finally {
		await harness.close(context);
		owned.release();
	}
});

test("diagnostic history scan bounds internal records and continues even when a page returns no transcript entries", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-diagnostic-history-scan-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const durable = join(dir, "durable");
	const target = {
		host: { hostId: "local", daemonId: "daemon", lineageId: "lineage" },
		sessionId: "01234567-89ab-4cde-8fab-0123456789ab",
		chatUrl: "pilot://chat/01234567-89ab-4cde-8fab-0123456789ab",
	};
	const owned = await openSessionStorage(durable);
	const harness = await Harness.open(owned.storage, { models: createModels(), registry: createRegistry() }, context);
	try {
		const root = await harness.root(context, { agent: { model: { provider: "missing", modelId: "offline" } } });
		const userId = await root.commit(async (tx) => {
			const user = await tx.appendEntry(root.id, {
				kind: "pi.user",
				model: [{ role: "user", content: "old but authorized", timestamp: 1 }],
			});
			for (let index = 0; index < DIAGNOSTIC_HISTORY_MAX_SCANNED_ENTRIES + 5; index++)
				await tx.appendEntry(root.id, { kind: "note", data: { index } });
			return Number(user.id);
		}, context);

		const first = await readDiagnosticHistoryPage(durable, target, undefined, 1);
		assert.deepEqual(first.entries, []);
		assert.equal(first.pagination.scannedEntries, DIAGNOSTIC_HISTORY_MAX_SCANNED_ENTRIES);
		assert.equal(first.pagination.more, true);
		assert.ok(first.pagination.nextBefore);
		const second = await readDiagnosticHistoryPage(durable, target, first.pagination.nextBefore, 1);
		assert.deepEqual(
			second.entries.map((entry) => entry.entryId),
			[userId],
		);
		assert.equal(second.pagination.scannedEntries, 6);
		assert.equal(second.pagination.more, false);
	} finally {
		await harness.close(context);
		owned.release();
	}
});
