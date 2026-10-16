import type { TrackedItem, TrackingJson } from "@pilot/protocol";
import { slackStartAllowed } from "./slack-start.ts";
import { SourceToolError, validSourceArguments } from "./source-mcp.ts";
import type { SourcePollContext } from "./sources.ts";
import type { TrackedItemStore } from "./tracked-items.ts";

export async function refreshSlackReactions(
	items: Pick<TrackedItemStore, "reserveSlackReactions" | "recordSlackReaction">,
	context: SourcePollContext,
): Promise<boolean> {
	const batch = await items.reserveSlackReactions(context.project.id, Date.now());
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
	return batch.budget;
}

/** Add the check through the dedicated Slack server. Persist its outcome before attempting removal. */
export async function addSlackDone(context: SourcePollContext, item: TrackedItem): Promise<"reacted" | "skipped"> {
	if (item.slack?.status !== "done" || !slackStartAllowed(context.config.slackChannels, item)) return "skipped";
	const args = { channel_id: item.metadata.channel, message_ts: item.metadata.thread_ts, emoji: "white_check_mark" };
	if (!validSourceArguments("doneSlack", args)) throw new SourceToolError("Invalid Slack parent");
	context.signal.throwIfAborted();
	await context.call("doneSlack", args);
	return "reacted";
}

/** Shares the durable Done admission, never its outcome. No generic proxy capability is exposed. */
export async function removeSlackEyes(context: SourcePollContext, item: TrackedItem): Promise<void> {
	if (
		item.slack?.status !== "done" ||
		!slackStartAllowed(context.config.slackChannels, item) ||
		(item.metadata.slackStart as { outcome?: string } | undefined)?.outcome !== "reacted"
	)
		return;
	const args = { channel_id: item.metadata.channel, message_ts: item.metadata.thread_ts, emoji: "eyes" };
	if (!validSourceArguments("removeSlackEyes", args)) throw new SourceToolError("Invalid Slack parent");
	context.signal.throwIfAborted();
	await context.call("removeSlackEyes", args);
}
