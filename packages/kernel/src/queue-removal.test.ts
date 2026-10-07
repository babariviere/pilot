import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	createRegistry,
	createSession,
	defineTool,
	Harness,
	InboxDoc,
	LiveDoc,
	MemoryStorage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { reconcileCompletion } from "./attention.ts";
import { queueUpdate, removeQueuedMessage, watchQueue } from "./queue.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("removal commits one withdrawn input and the queue together, broadcasts, and survives SQLite reopen", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-queue-removal-"));
	const file = join(dir, "session.sqlite");
	let storage = await openNodeSqliteStorage(file);
	let session = createSession(storage);
	try {
		const { conversation, first, second, third, write } = await session.commit(async (tx) => {
			const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
			const first = await tx.createSubmission({ conversationId: conversation.id, type: "input", status: "queued" });
			const second = await tx.createSubmission({ conversationId: conversation.id, type: "input", status: "queued" });
			const third = await tx.createSubmission({ conversationId: conversation.id, type: "input", status: "queued" });
			const write = await tx.createSubmission({ conversationId: conversation.id, type: "write", status: "queued" });
			(await tx.doc(InboxDoc, conversation.id)).items = [
				{ id: first.id, mode: "followUp", content: "First" },
				{ id: second.id, mode: "steer", content: "Remove me" },
				{ id: third.id, mode: "steer", content: "Third" },
				{ id: write.id, mode: "write", entry: { kind: "notice" } },
			];
			return { conversation, first, second, third, write };
		}, context);
		const watch = await watchQueue(session, conversation.id, context);
		const published = deferred();
		watch.start(async (inbox) => {
			if (inbox?.items.length !== 3) return;
			assert.equal((await storage.submission(second.id, context))?.status, "unanswered");
			assert.deepEqual(queueUpdate(inbox).items, [
				{ id: first.id, mode: "followUp", content: "First" },
				{ id: third.id, mode: "steer", content: "Third" },
			]);
			published.resolve();
		});
		await removeQueuedMessage(session, conversation.id, second.id, context);
		await published.promise;
		await watch.stop();
		await removeQueuedMessage(session, conversation.id, first.id, context);
		assert.deepEqual(await storage.submission(third.id, context), third);
		assert.deepEqual(await storage.submission(write.id, context), write);
		await session.close(context);
		storage = await openNodeSqliteStorage(file);
		session = createSession(storage);
		for (const input of [first, second]) {
			assert.deepEqual(await storage.submission(input.id, context), {
				...input,
				status: "unanswered",
				reason: "aborted",
			});
		}
		const reattached = await watchQueue(session, conversation.id, context);
		assert.deepEqual(reattached.value?.items, [
			{ id: third.id, mode: "steer", content: "Third" },
			{ id: write.id, mode: "write", entry: { kind: "notice" } },
		]);
		await reattached.stop();
		assert.deepEqual(
			(await storage.scanEntries({ conversationId: conversation.id }, 100, undefined, context)).items,
			[],
		);
	} finally {
		await session.close(context);
		await rm(dir, { recursive: true, force: true });
	}
});

test("invalid, foreign, write, consumed, and already withdrawn IDs reject without history or queue changes", async () => {
	const storage = new MemoryStorage();
	const session = createSession(storage);
	try {
		const { conversation, other, input, write } = await session.commit(async (tx) => {
			const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
			const other = await tx.createConversation({ ownership: { kind: "ownerless" } });
			const input = await tx.createSubmission({ conversationId: conversation.id, type: "input", status: "queued" });
			const write = await tx.createSubmission({ conversationId: conversation.id, type: "write", status: "queued" });
			(await tx.doc(InboxDoc, conversation.id)).items = [
				{ id: input.id, mode: "followUp", content: "Original" },
				{ id: write.id, mode: "write", entry: { kind: "notice" } },
			];
			return { conversation, other, input, write };
		}, context);
		const before = await session.snapshot(InboxDoc, conversation.id, context);
		for (const id of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])
			await assert.rejects(removeQueuedMessage(session, conversation.id, id, context), /Invalid queued message ID/);
		for (const [conversationId, id] of [
			[other.id, input.id],
			[conversation.id, write.id],
			[conversation.id, 99999],
		] as const)
			await assert.rejects(removeQueuedMessage(session, conversationId!, id!, context), /no longer queued/);
		assert.deepEqual(await session.snapshot(InboxDoc, conversation.id, context), before);
		assert.deepEqual(await storage.submission(input.id, context), input);
		assert.deepEqual(await storage.submission(write.id, context), write);
		assert.deepEqual(
			(await storage.scanEntries({ conversationId: conversation.id }, 100, undefined, context)).items,
			[],
		);
		// A consuming commit wins the line; removal must not retroactively remove its user entry.
		const consuming = session.commit(async (tx) => {
			const inbox = await tx.doc(InboxDoc, conversation.id);
			const entry = await tx.appendEntry(conversation.id, {
				kind: "pi.user",
				model: [{ role: "user", content: "Original", timestamp: 0 }],
			});
			tx.placeSubmission(input.id, entry.id);
			inbox.items.splice(0, 1);
		}, context);
		const removing = removeQueuedMessage(session, conversation.id, input.id, context);
		await consuming;
		const entries = await storage.scanEntries({ conversationId: conversation.id }, 100, undefined, context);
		await assert.rejects(removing, /no longer queued/);
		assert.equal((await storage.submission(input.id, context))?.status, "placed");
		assert.deepEqual(
			await storage.scanEntries({ conversationId: conversation.id }, 100, undefined, context),
			entries,
		);
		// Conversely, removal first leaves nothing for a consuming commit to place.
		const queued = await session.commit(async (tx) => {
			const input = await tx.createSubmission({ conversationId: conversation.id, type: "input", status: "queued" });
			(await tx.doc(InboxDoc, conversation.id)).items.push({ id: input.id, mode: "steer", content: "Withdraw" });
			return input;
		}, context);
		const withdrawal = removeQueuedMessage(session, conversation.id, queued.id, context);
		const after = session.commit(async (tx) => {
			assert.ok(!(await tx.doc(InboxDoc, conversation.id)).items.some((item) => item.id === queued.id));
		}, context);
		await Promise.all([withdrawal, after]);
		assert.equal((await storage.submission(queued.id, context))?.status, "unanswered");
		await assert.rejects(removeQueuedMessage(session, conversation.id, queued.id, context), /no longer queued/);
		assert.deepEqual(
			await storage.scanEntries({ conversationId: conversation.id }, 100, undefined, context),
			entries,
		);
	} finally {
		await session.close(context);
	}
});

test("withdrawal settles waiters without stopping the active run or overwriting its completion", async () => {
	const started = deferred();
	const release = deferred();
	const probe = defineTool({
		name: "probe",
		description: "Pause the current run",
		parameters: Type.Object({}),
		execute: async () => {
			started.resolve();
			await release.promise;
			return {};
		},
	});
	const faux = fauxProvider({ tokensPerSecond: 0 });
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install({ name: "test", tools: [probe] });
	const storage = new MemoryStorage();
	const harness = await Harness.open(storage, { models, registry }, context);
	try {
		const model = faux.getModel();
		const conversation = await harness.root(context, {
			agent: { model: { provider: model.provider, modelId: model.id } },
		});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("Finished active run"),
			fauxAssistantMessage("Finished remaining follow-up"),
		]);
		const active = await conversation.submit({ type: "input", content: "Start" }, context);
		await started.promise;
		const followUp = await conversation.submit({ type: "input", content: "Withdraw follow-up" }, context);
		const steer = await conversation.submit({ type: "input", content: "Withdraw steer", whenBusy: "steer" }, context);
		const remaining = await conversation.submit({ type: "input", content: "Remaining" }, context);
		const waits = [followUp.wait(context), steer.wait(context)];
		const live = await harness.snapshot(LiveDoc, conversation.id, context);
		const entries = await storage.scanEntries({ conversationId: conversation.id }, 100, undefined, context);
		for (const input of [followUp, steer]) await removeQueuedMessage(harness, conversation.id, input.id, context);
		for (const record of await Promise.all(waits)) {
			assert.equal(record.status, "unanswered");
			assert.equal(record.reason, "aborted");
			assert.equal(record.entry, undefined);
		}
		assert.deepEqual(await harness.snapshot(LiveDoc, conversation.id, context), live);
		assert.deepEqual(
			await storage.scanEntries({ conversationId: conversation.id }, 100, undefined, context),
			entries,
		);
		assert.equal(await reconcileCompletion(storage, harness, conversation, context), undefined);
		release.resolve();
		assert.equal((await active.wait(context)).status, "done");
		assert.equal((await remaining.wait(context)).status, "done");
		const completion = await reconcileCompletion(storage, harness, conversation, context);
		assert.equal(completion?.outcome, "done");
		assert.deepEqual(
			await reconcileCompletion(storage, harness, conversation, context, [followUp.id, steer.id]),
			completion,
		);
	} finally {
		release.resolve();
		await harness.close(context);
	}
});
