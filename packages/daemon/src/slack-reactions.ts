import type { TrackingJson } from "@pilot/protocol";
import { slackStartAllowed } from "./slack-start.ts";
import { SourceToolError, validSourceArguments } from "./source-tool-rules.ts";
import type { SourcePollContext } from "./sources.ts";
import type { TrackedItemStore } from "./tracked-items.ts";

export async function refreshSlackReactions(
	items: Pick<TrackedItemStore, "reserveSlackReactions" | "recordSlackReaction">,
	context: SourcePollContext,
	recheckMs?: number,
): Promise<boolean> {
	const batch = await items.reserveSlackReactions(context.project.id, Date.now(), recheckMs, context.force);
	for (const { item, version } of batch.reads) {
		context.signal.throwIfAborted();
		if (!slackStartAllowed(context.config.slackChannels, item)) continue;
		const args = { channel_id: item.metadata.channel, message_ts: item.metadata.thread_ts };
		if (!validSourceArguments("reactions", args)) continue;
		const value = (await context.call("reactions", args)) as { present?: TrackingJson };
		context.signal.throwIfAborted();
		if (!value || typeof value.present !== "boolean") throw new SourceToolError("Invalid Slack reactions response");
		await items.recordSlackReaction(item.id, value.present, version);
	}
	context.observe?.({
		stage: "reaction_reads",
		phase: "completed",
		outcome: "success",
		count: batch.reads.length,
	});
	return false;
}
