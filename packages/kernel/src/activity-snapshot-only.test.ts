import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	createSession,
	InboxDoc,
	LiveDoc,
	MemoryStorage,
	type SnapshotEvent,
	type SubmissionId,
	type TaskId,
} from "@earendil-works/pi-durable";
import { hasUnownedChildren, InfrastructureChildren, inspectChildren, watchActivity } from "./activity.ts";
import type { McpTransportFactory } from "@earendil-works/pi-coding-agent";

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
		await update(true);
		await update(false);
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
		await update(false, true);
		await update(true, false);
		await update(false, false);
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
