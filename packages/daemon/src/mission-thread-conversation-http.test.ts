import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openSessionStorage } from "@pilot/kernel/testing";
import { nativePlanningFixture } from "./native-mission-planning.fixture.ts";

test("authenticated HTTP conversation reads real SQLite causal links and late answers without a worker start", async (t) => {
	const f = await nativePlanningFixture();
	const chatId = randomUUID(),
		topicId = randomUUID();
	const directory = join(f.home, "sessions", chatId);
	await mkdir(directory, { recursive: true });
	const chat = {
		id: chatId,
		title: "Original thread chat",
		projectId: f.project.id,
		cwd: f.home,
		mode: "ask" as const,
		state: "idle" as const,
		createdAt: 1,
		updatedAt: 1,
		ask: { source: f.home },
	};
	await writeFile(join(directory, "meta.json"), JSON.stringify(chat));
	await f.sessions.load();
	const get = f.sessions.get.bind(f.sessions);
	t.mock.method(f.sessions, "get", (id: string) => (id === chatId ? chat : get(id)));
	t.mock.method(f.sessions, "planningIdentity", () => ({ inputGeneration: 0 }));
	const owned = await openSessionStorage(join(directory, "durable"));
	const harness = await Harness.open(owned.storage, { models: createModels(), registry: createRegistry() }, context);
	t.after(async () => {
		await harness.close(context);
		await owned.storage.close(context);
		owned.release();
		await f.close();
	});
	const root = await harness.root(context);
	const full = "Exact full message 🙂\n".repeat(1000);
	const placed = await root.commit(async (tx) => {
		const input = await tx.appendEntry(root.id, {
			kind: "pi.user",
			model: [{ role: "user", content: full, timestamp: 1 }],
		});
		const submission = await tx.createSubmission({
			conversationId: root.id,
			requestId: "original-input",
			type: "input",
			status: "placed",
			entry: input.id,
		});
		return { input, submission };
	}, context);
	const url = `${f.root}/api/projects/${f.project.id}/missions/${f.missionId}/threads`;
	const headers = { "x-pilot-github-capability": f.capability };
	const view = await (await fetch(url, { headers })).json();
	const create = f.operation(
		f.missionId,
		{ purpose: "thread-create", topicId, title: "Question", source: view.source },
		view.source,
	);
	assert.equal((await (await f.post(create)).json()).state, "accepted");
	f.store.join(chatId, f.missionId, undefined, "explorer");
	f.store.threads.amend(f.missionId, topicId, (topic) => {
		topic.chat = { operationId: randomUUID(), sessionId: chatId };
	});
	let historyURL = `${url}/${topicId}/history`;
	assert.equal((await fetch(historyURL)).status, 403);
	assert.equal((await fetch(`${historyURL}?sessionId=${randomUUID()}`, { headers })).status, 409);
	const first = await (await fetch(historyURL, { headers })).json();
	assert.equal(first.conversation.entries[0].text, full);
	assert.equal(first.conversation.entries[0].replyState, "awaiting");
	assert.equal(first.conversation.entries[0].original.entryId, Number(placed.input.id));
	const answer = await root.commit(async (tx) => {
		const reply = await tx.appendEntry(root.id, {
			kind: "pi.assistant",
			model: [fauxAssistantMessage("Exact answer")],
		});
		tx.settleSubmission(placed.submission.id, { status: "done", answer: reply.id });
		return reply;
	}, context);
	const latest = await (await fetch(historyURL, { headers })).json();
	assert.equal(latest.conversation.entries[0].replyState, "answered");
	assert.equal(latest.conversation.entries[1].text, "Exact answer");
	assert.equal(latest.conversation.entries[1].role, "chat");
	const older = await (
		await fetch(`${historyURL}?before=${Number(answer.id)}&limit=1&sessionId=${chatId}`, { headers })
	).json();
	assert.equal(older.conversation.entries.length, 1);
	assert.equal(older.conversation.entries[0].original.entryId, Number(placed.input.id));
	const send = f.operation(
		f.missionId,
		{ purpose: "thread-send", topicId, text: "Queued exact words", source: view.source },
		view.source,
	);
	const queued = await root.commit(
		(tx) =>
			tx.createSubmission({ conversationId: root.id, requestId: send.operationId, type: "input", status: "queued" }),
		context,
	);
	// Saved accepted effects without starting any model, just as the cold HTTP reader must observe them.
	const sent = await f.journal.execute(send, async () => ({
		topic: f.store.threads.amend(f.missionId, topicId, (topic) => {
			topic.inputs.push({ operationId: send.operationId, sessionId: f.owner, at: 123 });
		}),
		chat: { sessionId: chatId },
	}));
	assert.equal(sent.state, "accepted", JSON.stringify(sent));
	assert.equal((await f.sessions.inputCausality(chatId, [], [send.operationId]))[0]?.status, "queued");
	await f.restart();
	historyURL = `${f.root}/api/projects/${f.project.id}/missions/${f.missionId}/threads/${topicId}/history`;
	headers["x-pilot-github-capability"] = f.capability;
	const waiting = await (await fetch(historyURL, { headers })).json();
	assert.deepEqual(waiting.conversation.queuedMessages, [
		{ operationId: send.operationId, text: "Queued exact words", timestamp: 123, replyState: "pending" },
	]);
	await root.commit(async (tx) => {
		const input = await tx.appendEntry(root.id, {
			kind: "pi.user",
			model: [{ role: "user", content: "Queued exact words", timestamp: 3 }],
		});
		tx.placeSubmission(queued.id, input.id);
	}, context);
	const nowPlaced = await (await fetch(historyURL, { headers })).json();
	assert.deepEqual(nowPlaced.conversation.queuedMessages, []);
	assert.equal(nowPlaced.conversation.entries.at(-1).operationId, send.operationId);
	assert.equal(nowPlaced.conversation.entries.at(-1).replyState, "awaiting");
	await root.commit(async (tx) => {
		const notice = await tx.appendEntry(root.id, {
			kind: "pi.user",
			model: [{ role: "user", content: "Automatic mission notice", timestamp: 4 }],
		});
		const submission = await tx.createSubmission({
			conversationId: root.id,
			requestId: "mission:automatic-notice",
			type: "input",
			status: "placed",
			entry: notice.id,
		});
		const reply = await tx.appendEntry(root.id, {
			kind: "pi.assistant",
			model: [fauxAssistantMessage("Automatic notice answer")],
		});
		tx.settleSubmission(submission.id, { status: "done", answer: reply.id });
	}, context);
	const withActivity = await (await fetch(historyURL, { headers })).json();
	assert.equal(
		withActivity.conversation.entries.some((e: { text: string }) => e.text.includes("Automatic")),
		false,
	);
	assert.equal(
		withActivity.history.entries.some((e: { kind: string }) => e.kind === "pi.assistant"),
		true,
		"authorized original activity remains available",
	);
	assert.equal(f.store.tasks(f.missionId).length, 0, "reading never creates work");
});
