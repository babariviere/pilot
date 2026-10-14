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
		const [event] = await origins.events([{ type: "entry_appended", entry: job }]);
		assert.equal(event?.type === "entry_appended" && (event.entry as { origin?: string }).origin, "job");
		assert.equal(scan.mock.callCount(), 2);
	} finally {
		await session.close(context);
	}
});
