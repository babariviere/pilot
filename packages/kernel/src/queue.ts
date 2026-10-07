import type { Context } from "@earendil-works/chord";
import { type ConversationId, type DocumentObserver, InboxDoc, type InboxState } from "@earendil-works/pi-durable";
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
