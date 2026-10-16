import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createSession, MemoryStorage, UserEntry } from "@earendil-works/pi-durable";
import { InputOrigins, inputOrigin } from "./input-origin.ts";

test("request IDs map to automatic origins, and user input has none", () => {
	assert.equal(inputOrigin(undefined), undefined);
	assert.equal(inputOrigin("8d0c-uuid"), undefined);
	assert.equal(inputOrigin("native:user:abc"), undefined);
	assert.equal(inputOrigin("native:jobs.result:abc"), "job");
	assert.equal(inputOrigin("native:subagent.result:abc"), "subagent");
	assert.equal(inputOrigin("native:custom:abc"), "extension");
	assert.equal(inputOrigin("mission:send:abc"), "coordinator");
	assert.equal(inputOrigin("mission:draft:abc"), "mission");
	assert.equal(inputOrigin("mission-notice:4"), "mission");
	assert.equal(inputOrigin("pr-follow-up:abc"), "pullRequest");
});

test("only automatic user entries are annotated, and later entries trigger one rescan", async (t) => {
	const storage = new MemoryStorage();
	const session = createSession(storage);
	try {
		const place = (
			conversationId: Parameters<typeof storage.scanSubmissions>[0]["conversationId"],
			requestId: string,
		) =>
			session.commit(async (tx) => {
				const entry = await tx.appendEntry(UserEntry, conversationId!, {
					model: [{ role: "user", content: requestId, timestamp: 0 }],
				});
				await tx.createSubmission({
					conversationId: conversationId!,
					requestId,
					type: "input",
					status: "placed",
					entry: entry.id,
				});
				return entry;
			}, context);
		const conversation = await session.commit(
			(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
			context,
		);
		const user = await place(conversation.id, "typed");
		const mission = await place(conversation.id, "mission:send:1");
		const scan = t.mock.method(storage, "scanSubmissions");
		const origins = new InputOrigins(storage, conversation.id, context);
		const annotated = await origins.entries([user, mission]);
		assert.equal("origin" in annotated[0]!, false);
		assert.equal((annotated[1] as { origin?: string }).origin, "coordinator");
		await origins.entries([user, mission]);
		assert.equal(scan.mock.callCount(), 1, "known entries do not rescan");

		const job = await place(conversation.id, "native:jobs.result:2");
		// The live stream delivers committed user messages as message_end.
		const [event] = await origins.events([{ type: "message_end", entry: job } as never]);
		assert.equal((event as { entry?: { origin?: string } }).entry?.origin, "job");
		assert.equal(scan.mock.callCount(), 2);
		const pr = await place(conversation.id, "pr-follow-up:3");
		const [appended] = await origins.events([{ type: "entry_appended", entry: pr }]);
		assert.equal(
			appended?.type === "entry_appended" && (appended.entry as { origin?: string }).origin,
			"pullRequest",
		);
		const notice = await place(conversation.id, "mission-notice:3");
		const [projectedNotice] = await origins.entries([notice]);
		assert.deepEqual(projectedNotice?.data, { event: { kind: "mission_updated", text: "Mission updated" } });
		assert.equal(projectedNotice?.model, notice.model, "full agent-facing input remains intact");
	} finally {
		await session.close(context);
	}
});

test("an entry committed during an in-flight scan triggers another scan", async () => {
	const storage = new MemoryStorage();
	const session = createSession(storage);
	try {
		const conversation = await session.commit(
			(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
			context,
		);
		const place = (requestId: string) =>
			session.commit(async (tx) => {
				const entry = await tx.appendEntry(UserEntry, conversation.id, {
					model: [{ role: "user", content: requestId, timestamp: 0 }],
				});
				await tx.createSubmission({
					conversationId: conversation.id,
					requestId,
					type: "input",
					status: "placed",
					entry: entry.id,
				});
				return entry;
			}, context);
		const first = await place("typed");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let read!: () => void;
		const firstPageRead = new Promise<void>((resolve) => {
			read = resolve;
		});
		const scan = storage.scanSubmissions.bind(storage);
		let calls = 0;
		storage.scanSubmissions = (async (...args: Parameters<typeof scan>) => {
			const page = await scan(...args);
			if (calls++ === 0) {
				read();
				await gate;
			}
			return page;
		}) as typeof scan;
		const origins = new InputOrigins(storage, conversation.id, context);
		const pending = origins.entries([first]);
		await firstPageRead;
		const job = await place("native:jobs.result:1");
		const annotated = origins.events([{ type: "message_end", entry: job } as never]);
		release();
		await pending;
		const [event] = await annotated;
		assert.equal((event as { entry?: { origin?: string } }).entry?.origin, "job");
	} finally {
		await session.close(context);
	}
});
