import type { Context } from "@earendil-works/chord";
import {
	type ConversationId,
	type DocumentObserver,
	InboxDoc,
	type InboxState,
	type Session,
} from "@earendil-works/pi-durable";
import type { QueueUpdateEvent } from "@pilot/protocol";

export function queueUpdate(inbox: Readonly<InboxState> | null): QueueUpdateEvent {
	return {
		type: "queue_update",
		items: (inbox?.items ?? []).flatMap((item) =>
			item.mode === "write" ? [] : [{ id: item.id, mode: item.mode, content: item.content }],
		),
	};
}

/** Exact committed inbox frames, independent of the agent stream's content-free queue IDs. */
export async function watchQueue(observer: DocumentObserver, conversationId: ConversationId, context: Context) {
	const watch = await observer.watchDoc(InboxDoc, conversationId, context);
	if (!watch) throw new Error("Conversation inbox is missing");
	return watch;
}

/** Replace pending content on the mutation line, never withdraw/resubmit or change history. */
export async function editQueuedMessage(
	session: Pick<Session, "commit">,
	conversationId: ConversationId,
	submissionId: number,
	content: string,
	context: Context,
): Promise<void> {
	if (!Number.isSafeInteger(submissionId) || submissionId <= 0) throw new Error("Invalid queued message ID");
	if (typeof content !== "string" || !content.trim()) throw new Error("message is required");
	await session.commit(async (tx) => {
		// Admission, consumption, and withdrawal all mutate this conversation's inbox on the same line.
		const inbox = await tx.doc(InboxDoc, conversationId);
		const item = inbox.items.find((item) => item.id === submissionId);
		if (!item || item.mode === "write") throw new Error("Message is no longer queued. Your edit has not been sent.");
		item.content = content;
	}, context);
}
