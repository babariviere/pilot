/** Bounded, committed provenance read. Tool arguments and later steering inputs cannot replace the run anchor. */
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createSession, LiveDoc } from "@earendil-works/pi-durable";
import type { ControlUserMessageRef } from "@pilot/protocol";
import { activeConversation } from "./attempts.ts";
import { inputOrigin } from "./input-origin.ts";
import { openSessionReader } from "./storage.ts";

export interface ControlTurnOrigin {
	requestId: string;
	userMessage?: ControlUserMessageRef;
}
export async function readControlTurnOrigin(directory: string): Promise<ControlTurnOrigin | undefined> {
	const storage = await openSessionReader(directory);
	if (!storage) return undefined;
	const session = createSession(storage);
	try {
		const conversationId = await activeConversation(storage, context);
		const live = await session.snapshot(LiveDoc, conversationId, context);
		const first = live?.run?.inputs[0];
		if (first === undefined) return undefined;
		const submission = await storage.submission(first, context);
		if (submission?.type !== "input" || submission.status !== "placed" || submission.entry === undefined)
			return undefined;
		const requestId = submission.requestId ?? "";
		return {
			requestId,
			// User admission uses an opaque request ID. Colon namespaces belong to automatic
			// producers, including future ones not yet known to the display-origin classifier.
			...(/^[\w-]{1,128}$/.test(requestId) && !inputOrigin(requestId)
				? {
						userMessage: {
							conversationId: String(conversationId),
							submissionId: Number(first),
							entryId: Number(submission.entry),
							requestId,
						},
					}
				: {}),
		};
	} finally {
		await session.close(context);
	}
}
