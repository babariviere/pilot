import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, LiveDoc, MemoryStorage } from "@earendil-works/pi-durable";
import type { BaseAgentEvent } from "@pilot/protocol";
import { watchEvents } from "./agent-events.ts";

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

test("wire bridge retains active legacy history across bounded SDK windows and compaction", async (t) => {
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models: createModels(), registry: createRegistry() },
		context,
	);
	t.after(() => harness.close(context));
	const root = await harness.root(context);
	await root.commit(async (tx) => {
		for (let i = 0; i < 300; i++) await tx.appendEntry(root.id, { kind: "old", data: { i } });
		await tx.appendEntry(root.id, { kind: "pi.compaction", head: "self" });
		for (let i = 0; i < 150; i++) await tx.appendEntry(root.id, { kind: "kept", data: { i } });
	}, context);
	const stream = await watchEvents(harness, root.id, context);
	t.after(() => stream.stop());
	assert.equal(stream.snapshot.entries.length, 151);
	assert.equal(stream.snapshot.entries[0]?.kind, "pi.compaction");
	assert.ok(stream.snapshot.entries.every((entry) => entry.kind !== "old"));
	const events: BaseAgentEvent[] = [];
	const received = deferred<void>();
	stream.start(async (batch) => {
		events.push(...batch);
		if (events.filter((event) => event.type === "entry_appended").length === 160) received.resolve();
	});
	await root.commit(async (tx) => {
		for (let i = 0; i < 160; i++) await tx.appendEntry(root.id, { kind: "new", data: { i } });
	}, context);
	await received.promise;
	assert.equal(events.filter((event) => event.type === "entry_appended").length, 160);
	assert.equal(stream.snapshot.entries.length, 151, "attachment snapshots are immutable");
	const reopened = await watchEvents(harness, root.id, context);
	assert.equal(reopened.snapshot.entries.length, 311);
	await reopened.stop();
	await stream.stop();
	assert.equal((await stream.closed).kind, "stopped");
});

test("wire bridge bounds slow-listener queues with a current snapshot and releases cancelled observers", async (t) => {
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models: createModels(), registry: createRegistry() },
		context,
	);
	t.after(() => harness.close(context));
	const root = await harness.root(context);
	const abort = new AbortController();
	const stream = await watchEvents(harness, root.id, { ...context, abortSignal: abort.signal });
	const entered = deferred<void>();
	const release = deferred<void>();
	const snapshot = deferred<Extract<BaseAgentEvent, { type: "snapshot" }>>();
	t.after(() => release.resolve());
	let first = true;
	stream.start(async (events) => {
		if (first) {
			first = false;
			entered.resolve();
			await release.promise;
		}
		for (const event of events) if (event.type === "snapshot") snapshot.resolve(event);
	});
	await root.commit((tx) => tx.appendEntry(root.id, { kind: "first" }), context);
	await entered.promise;
	for (let i = 0; i < 101; i++) await root.commit((tx) => tx.appendEntry(root.id, { kind: "next" }), context);
	release.resolve();
	assert.equal((await snapshot.promise).entries.length, 102);
	abort.abort();
	assert.equal((await stream.closed).kind, "aborted");
});

test("wire compaction events retain reason while SDK state uses trigger", async (t) => {
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models: createModels(), registry: createRegistry() },
		context,
	);
	t.after(() => harness.close(context));
	const root = await harness.root(context);
	const stream = await watchEvents(harness, root.id, context);
	t.after(() => stream.stop());
	const received = deferred<BaseAgentEvent>();
	stream.start(async (events) => {
		for (const event of events) if (event.type === "compaction_start") received.resolve(event);
	});
	await root.commit(async (tx) => {
		(await tx.doc(LiveDoc, root.id)).compactions = [
			{ taskId: 999 as never, trigger: "manual", blocking: false, attempt: 1 },
		];
	}, context);
	assert.deepEqual(await received.promise, {
		type: "compaction_start",
		taskId: 999,
		reason: "manual",
		blocking: false,
	});
});

test("attachment includes entries committed after its context read without duplicating them", async (t) => {
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models: createModels(), registry: createRegistry() },
		context,
	);
	t.after(() => harness.close(context));
	const root = await harness.root(context);
	await root.commit((tx) => tx.appendEntry(root.id, { kind: "before" }), context);
	const conversation = harness.conversation.bind(harness);
	t.mock.method(harness, "conversation", async (...args: Parameters<typeof conversation>) => {
		const result = await conversation(...args);
		assert.ok(result);
		const read = result.context.bind(result);
		t.mock.method(result, "context", async (ctx: typeof context) => {
			const captured = await read(ctx);
			await root.commit((tx) => tx.appendEntry(root.id, { kind: "during" }), context);
			return captured;
		});
		return result;
	});
	const stream = await watchEvents(harness, root.id, context);
	t.after(() => stream.stop());
	assert.deepEqual(
		stream.snapshot.entries.map((entry) => entry.kind),
		["before", "during"],
	);
});
