import type { TrackedItem } from "@pilot/protocol";
import type { SlackReactionOwner } from "./slack-reaction-owner.ts";
import { validSourceArguments } from "./source-mcp.ts";
import type { SourcePollContext } from "./sources.ts";

/** Start write: eyes on the stored parent, never the reply that surfaced the thread. */
export async function slackStart(
	context: SourcePollContext,
	item: TrackedItem,
): Promise<{ outcome: "reacted" | "skipped"; owner?: SlackReactionOwner }> {
	const { channel, thread_ts: ts } = item.metadata;
	const args = { channel_id: channel, message_ts: ts, emoji: "eyes" };
	if (!validSourceArguments("startSlack", args)) throw new Error("Invalid Slack thread");
	if (!slackStartAllowed(context.config.slackChannels, item)) return { outcome: "skipped" };
	context.signal.throwIfAborted();
	const result = (await context.call("startSlack", args)) as { userId?: string };
	const owner =
		typeof result?.userId === "string" && /^[UW][A-Z0-9]{1,39}$/.test(result.userId)
			? { userId: result.userId, channel: channel as string, messageTs: ts as string }
			: undefined;
	return { outcome: "reacted", ...(owner ? { owner } : {}) };
}

export function slackStartAllowed(channels: string[], item: TrackedItem): boolean {
	const { channel, channelName } = item.metadata;
	return (
		item.metadata.manual === true ||
		channels.some(
			(entry) => entry === channel || (typeof channelName === "string" && entry.replace(/^#/, "") === channelName),
		)
	);
}
