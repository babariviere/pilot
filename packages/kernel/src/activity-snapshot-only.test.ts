import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serialize } from "node:v8";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	createSession,
	type CompactionStatus,
	InboxDoc,
	LiveDoc,
	MemoryStorage,
	type SnapshotEvent,
	type SubmissionId,
	type TaskId,
} from "@earendil-works/pi-durable";
import { hasUnownedChildren, InfrastructureChildren, inspectChildren, watchActivity } from "./activity.ts";
import type { McpTransportFactory } from "@earendil-works/pi-coding-agent";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

test("reopened activity snapshots detach compactions and nested retries for advanced IPC", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-activity-reopen-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const file = join(dir, "harness.sqlite");
	let session = createSession(await openNodeSqliteStorage(file));
	const compaction: CompactionStatus = {
		taskId: 100 as CompactionStatus["taskId"],
		reason: "manual",
		blocking: false,
		attempt: 1,
	};
	const conversation = await session.commit(async (tx) => {
		const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
		(await tx.doc(LiveDoc, conversation.id)).compactions = [compaction];
		await tx.doc(InboxDoc, conversation.id);
		return conversation;
	}, context);
	await session.close(context);
	session = createSession(await openNodeSqliteStorage(file));
	t.after(() => session.close(context));
	const stream = await watchActivity(session, conversation.id, context);
	t.after(() => stream.stop());
	const checkIpc = (frame: SnapshotEvent) => {
		const packet = { type: "events", watchId: "activity", events: [frame] };
		assert.ok(serialize(packet).byteLength > 0, "Node advanced IPC must accept the entire packet");
		assert.deepEqual(structuredClone(packet), packet);
	};
	checkIpc(stream.snapshot);
	assert.deepEqual(stream.snapshot.compactions, [compaction]);
	assert.equal(stream.idle, false, "a compaction without a run must prevent parking");
	const frames: SnapshotEvent[] = [];
	stream.start(async (events) => {
		for (const event of events)
			if (event.type === "snapshot") {
				checkIpc(event);
				frames.push(event);
			}
	});
	await session.commit(async (tx) => {
		const active = (await tx.doc(LiveDoc, conversation.id)).compactions![0]!;
		active.attempt = 2;
		active.retry = { at: 123, error: "retry later" };
	}, context);
	await delay(1);
	assert.equal(frames.length, 1);
	assert.deepEqual(stream.snapshot.compactions, [compaction], "later commits cannot mutate the captured snapshot");
	assert.deepEqual(frames[0]!.compactions, [{ ...compaction, attempt: 2, retry: { at: 123, error: "retry later" } }]);
	// Attachment during a persisted retry must detach the nested draft as well.
	const retry = await watchActivity(session, conversation.id, context);
	checkIpc(retry.snapshot);
	assert.deepEqual(retry.snapshot.compactions, frames[0]!.compactions);
	await retry.stop();
	await session.commit(async (tx) => {
		delete (await tx.doc(LiveDoc, conversation.id)).compactions;
	}, context);
	await delay(1);
	assert.equal(frames.length, 2);
	assert.equal(stream.idle, true);
	assert.equal(stream.settledVersion, 1);
});

test("only exact idle MCP PIDs bypass child protection; active requests, unknown children and closed transports do not", async () => {
	type Transport = ReturnType<McpTransportFactory>;
	const messages = new Set<Parameters<Transport["onMessage"]>[0]>();
	const closed = new Set<() => void>();
	const transport: Transport & { pid?: number } = {
		pid: 123,
		start: async () => {},
		send: async () => {},
		close: async () => {},
		onMessage(listener) {
			messages.add(listener);
			return () => messages.delete(listener);
		},
		onError() {
			return () => {};
		},
		onClose(listener) {
			closed.add(listener);
			return () => closed.delete(listener);
		},
	};
	const infrastructure = new InfrastructureChildren();
	infrastructure.track(transport);
	assert.equal(hasUnownedChildren("123\n", infrastructure.idlePids()), false);
	assert.equal(hasUnownedChildren("123\n456\n", infrastructure.idlePids()), true, "jobs/subagents remain protected");
	assert.equal(hasUnownedChildren("invalid", infrastructure.idlePids()), true);
	await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} });
	assert.equal(
		hasUnownedChildren("123", infrastructure.idlePids()),
		true,
		"outstanding MCP calls are not idle infrastructure",
	);
	for (const listener of messages) listener({ jsonrpc: "2.0", id: 1, result: {} });
	assert.equal(hasUnownedChildren("123", infrastructure.idlePids()), false);
	transport.pid = undefined;
	assert.equal(infrastructure.idlePids().size, 0, "exited transport PIDs cannot remain allowlisted");
	transport.pid = 123;
	for (const listener of closed) listener();
	assert.equal(infrastructure.idlePids().size, 0);
	assert.equal(messages.size, 0);
	assert.equal(closed.size, 0);
});

test("an idle owned MCP root cannot hide unknown descendants or failed descendant inspection", async () => {
	const infrastructure = new InfrastructureChildren();
	const idle = new Set([123, 124]);
	infrastructure.idlePids = () => idle;
	const calls: number[][] = [];
	assert.equal(
		await inspectChildren(infrastructure, async (parents) => {
			calls.push([...parents]);
			return parents.length === 1 ? "123\n124\n" : "456\n";
		}),
		true,
		"a server's background build is not idle infrastructure",
	);
	assert.deepEqual(calls, [[process.pid], [123, 124]], "all exact idle roots are checked in one bounded query");
	assert.equal(
		await inspectChildren(infrastructure, async (parents) => {
			return parents.length === 1 ? "123\n124\n" : "";
		}),
		false,
		"idle roots without descendants can park",
	);
	assert.equal(
		await inspectChildren(infrastructure, async (parents) => {
			if (parents.length === 1) return "123\n124\n";
			throw new Error("process-list query failed");
		}),
		true,
	);
	assert.equal(
		await inspectChildren(infrastructure, async () => {
			throw new Error("direct query failed");
		}),
		true,
	);
	assert.equal(
		await inspectChildren(infrastructure, async (parents) => {
			if (parents.length === 1) return "123\n124\n";
			idle.clear();
			return "";
		}),
		true,
		"a transport becoming active/closed during inspection invalidates its exemption",
	);
});

test("activity coalesces small committed snapshots while async delivery is blocked", async () => {
	const session = createSession(new MemoryStorage());
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	try {
		const conversation = await session.commit(async (tx) => {
			const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
			await tx.doc(LiveDoc, conversation.id);
			await tx.doc(InboxDoc, conversation.id);
			return conversation;
		}, context);
		const stream = await watchActivity(session, conversation.id, context);
		const frames: SnapshotEvent[] = [];
		stream.start(async (events) => {
			frames.push(events[0] as SnapshotEvent);
			if (frames.length === 1) await gate;
		});
		const update = (running: boolean) =>
			session.commit(async (tx) => {
				const live = await tx.doc(LiveDoc, conversation.id);
				if (running) live.run = { taskId: 1 as TaskId, inputs: [] };
				else delete live.run;
			}, context);
		await update(true);
		await Promise.resolve();
		await update(false);
		assert.equal(stream.current?.run, undefined, "current state advances even while delivery is blocked");
		assert.equal(stream.idle, true);
		await update(true);
		await update(false);
		assert.equal(stream.settledVersion, 2, "coalescing preserves busy-to-idle boundaries");
		assert.equal(frames.length, 1, "delivery awaits the listener rather than buffering every update");
		release();
		await Promise.resolve();
		await stream.stop();
		assert.ok(frames.length <= 2);
		assert.ok(frames.every((frame) => frame.entries.length === 0));
	} finally {
		release();
		await session.close(context);
	}
});

test("activity attachment reads no history, writes no existing docs and delivers only commit-consistent run/inbox", async (t) => {
	const storage = new MemoryStorage();
	const session = createSession(storage);
	try {
		const conversation = await session.commit(async (tx) => {
			const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
			await tx.doc(LiveDoc, conversation.id);
			await tx.doc(InboxDoc, conversation.id);
			await tx.appendEntry(conversation.id, { kind: "very-large-history", data: { text: "unused" } });
			return conversation;
		}, context);
		t.mock.method(storage, "scanEntries", () => {
			assert.fail("activity must not scan transcript");
		});
		const commit = t.mock.method(storage, "commit");
		const stream = await watchActivity(session, conversation.id, context);
		assert.equal(commit.mock.callCount(), 0, "snapshot attachment is a no-op transaction");
		assert.deepEqual(stream.snapshot.entries, []);
		assert.deepEqual(stream.snapshot.inbox, []);
		const frames: SnapshotEvent[] = [];
		stream.start(async (events) => {
			for (const event of events) if (event.type === "snapshot") frames.push(event);
		});
		const update = async (run: boolean, queued: boolean) => {
			const count = frames.length;
			await session.commit(async (tx) => {
				const live = await tx.doc(LiveDoc, conversation.id);
				if (run) live.run = { taskId: 100 as TaskId, inputs: [101 as SubmissionId] };
				else delete live.run;
				(await tx.doc(InboxDoc, conversation.id)).items = queued
					? [{ id: 102 as SubmissionId, mode: "followUp", content: "large content not sent" }]
					: [];
			}, context);
			await delay(1);
			assert.equal(frames.length, count + 1);
			assert.equal(Boolean(frames.at(-1)?.run), run);
			assert.equal(Boolean(frames.at(-1)?.inbox.length), queued);
		};
		await update(true, false);
		assert.equal(stream.idle, false);
		await update(false, true);
		assert.equal(stream.idle, false, "a retained inbox is not settled");
		await update(true, false);
		await update(false, false);
		assert.equal(stream.idle, true);
		assert.equal(stream.settledVersion, 1, "queued end/start does not settle");
		const count = frames.length;
		await session.commit(async (tx) => {
			(await tx.doc(LiveDoc, conversation.id)).tools = [
				{ callId: "call", name: "tool", status: "running", output: "large output not sent" },
			];
			await tx.appendEntry(conversation.id, { kind: "entry-only-change" });
		}, context);
		await delay(1);
		assert.equal(frames.length, count, "output and transcript updates do not enlarge the activity stream");
		await stream.stop();
		assert.equal(stream.current, null);
		assert.equal(stream.idle, false, "closed monitors never advertise idle");
		await session.commit(async (tx) => {
			(await tx.doc(InboxDoc, conversation.id)).items = [
				{ id: 102 as SubmissionId, mode: "followUp", content: "after stop" },
			];
		}, context);
		await delay(1);
		assert.equal(frames.length, count, "stopped watch does not deliver");
	} finally {
		await session.close(context);
	}
});
