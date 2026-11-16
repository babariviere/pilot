import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, type EntryId, MemoryStorage } from "@earendil-works/pi-durable";
import type { EntryRecord } from "@pilot/protocol";
import type { MissionThread } from "../../protocol/src/mission-thread.ts";
import { threadConversationEntries } from "./mission-thread-conversation.ts";

test("coordinator output needs explicit links, not adjacency or matching text", async () => {
	const storage = new MemoryStorage();
	const make = async (kind: string, text: string, assistant = false): Promise<EntryRecord> => ({
		id: await storage.mintId<EntryId>(),
		conversationId: await storage.mintId<ConversationId>(),
		kind,
		model: assistant ? [fauxAssistantMessage(text)] : [{ role: "user", content: text, timestamp: 123 }],
	});
	const input = await make("pilot.planning-input", "wrapper");
	const exact = {
		...input,
		data: {
			operation: JSON.stringify({
				kind: "thread-send",
				operationId: "send",
				payload: JSON.stringify({ topicId: "t", text: "  exact 🙂 " }),
			}),
		},
	};
	const reply = await make("pi.assistant", "unrelated", true);
	const topic: MissionThread = {
		version: 1,
		id: "t",
		missionId: "m",
		projectId: "p",
		ownerSessionId: "s",
		title: "T",
		revision: 1,
		disposition: "open",
		createdBy: { kind: "user", operationId: "create", host: { hostId: "local", daemonId: "d", lineageId: "l" } },
		inputs: [{ operationId: "send", sessionId: "s" }],
		references: [],
	};
	const rows = threadConversationEntries(topic, "s", [exact, reply], false, new Set(["send"]));
	assert.equal(rows.length, 1);
	assert.equal(rows[0]!.text, "  exact 🙂 ");
	assert.equal(rows[0]!.replyState, "pending");
	assert.equal(rows[0]!.timestamp, 123);
	assert.equal(threadConversationEntries(topic, "other", [reply], false, new Set()).length, 0);
	const linked = { ...topic, references: [{ kind: "history" as const, sessionId: "s", entryId: Number(reply.id) }] };
	const shared = threadConversationEntries(linked, "s", [reply], false, new Set());
	assert.equal(shared[0]!.shared, true);
	assert.equal(shared[0]!.text, "unrelated");
	const user = await make("pi.user", "new question");
	for (const [status, expected] of [
		["queued", "pending"],
		["placed", "awaiting"],
		["done", "answered"],
		["unanswered", "unanswered"],
	] as const) {
		const rows = threadConversationEntries(topic, "chat", [user], true, new Set(), [
			{ entryId: Number(user.id), status },
		]);
		assert.equal(rows[0]!.replyState, expected);
	}
	const unknown = threadConversationEntries(topic, "chat", [user, reply], true, new Set());
	assert.equal(unknown[0]!.replyState, "unknown", "following assistant text proves nothing by itself");
	const batch = {
		...input,
		data: {
			operation: JSON.stringify({
				kind: "plan-thread-messages",
				operationId: "carrier",
				payload: JSON.stringify({ operationIds: ["send", "another", "foreign"] }),
			}),
		},
	};
	const batchedTopic = { ...topic, inputs: [...topic.inputs, { operationId: "another", sessionId: "s" }] };
	const sends = new Map([
		["send", "First exact question"],
		["another", "Second exact question"],
		["foreign", "Other topic words"],
	]);
	const carrier = new Map([["carrier", ["send", "another", "foreign"]]]);
	const rowsBatch = threadConversationEntries(
		batchedTopic,
		"s",
		[batch, reply],
		false,
		new Set(["another"]),
		[{ requestId: "carrier", entryId: Number(input.id), answerId: Number(reply.id), status: "done" }],
		sends,
		carrier,
	);
	assert.deepEqual(
		rowsBatch.map((r) => r.text),
		["First exact question", "Second exact question", "unrelated"],
	);
	assert.deepEqual(
		rowsBatch.slice(0, 2).map((r) => r.operationId),
		["send", "another"],
	);
	assert.equal(rowsBatch[0]!.id, rowsBatch[1]!.id, "both link the actual carrier, never a fake entry");
	assert.equal(rowsBatch[0]!.replyState, "unknown", "shared coordinator output does not prove a topic-only answer");
	assert.equal(rowsBatch[1]!.replyState, "pending");
	assert.equal(rowsBatch[2]!.shared, true);
	const notice = {
		...user,
		origin: "mission",
		model: [{ role: "user" as const, content: "Automatic status notice", timestamp: 4 }],
	};
	const automatic = threadConversationEntries(topic, "chat", [notice, reply], true, new Set(), [
		{ requestId: "mission:notice", entryId: Number(notice.id), answerId: Number(reply.id), status: "done" },
	]);
	assert.deepEqual(automatic, [], "automatic input and its answer remain original activity, not human conversation");
	const human = threadConversationEntries(topic, "chat", [user, reply], true, new Set(), [
		{ requestId: "human", entryId: Number(user.id), answerId: Number(reply.id), status: "done" },
	]);
	assert.equal(human.length, 2, "exact human causal reply joins the dedicated topic");
});
