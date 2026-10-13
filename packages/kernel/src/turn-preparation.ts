/** Await host maintenance at the first prompt preparation, never between tool rounds or on a steer. */
import { LiveDoc, type PromptInput, type Storage } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";

export function turnPreparation(
	storage: Pick<Storage, "submission" | "scanEntries">,
	prepare: () => Promise<void>,
	enabled: () => boolean = () => true,
) {
	let seen: number | undefined;
	return async (input: PromptInput, context: Context): Promise<void> => {
		if (!enabled()) return;
		const live = await input.read.snapshot(LiveDoc, input.conversationId, context);
		const first = live?.run?.inputs[0];
		if (first === undefined || first === seen) return;
		seen = first;
		// Recovery of an in-flight request/backoff is still the same turn, even before an answer
		// reached the transcript. A tool round is likewise never a maintenance boundary.
		if (live?.generation || live?.tools) return;
		const submission = await storage.submission(first, context);
		if (submission?.status !== "placed" || submission.entry === undefined) return;
		// On recovery, an existing assistant entry means this turn already began. Bound the read:
		// an unusually large intervening history is treated as unsafe, not scanned in the hot path.
		const entries = await storage.scanEntries(
			{ conversationId: input.conversationId, minEntryId: submission.entry },
			16,
			undefined,
			context,
		);
		if (
			entries.next ||
			entries.items.some((entry) => entry.kind === "pi.assistant" || entry.kind === "pi.tool-result")
		)
			return;
		await prepare();
	};
}
