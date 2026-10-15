import type { TrackedItem } from "@pilot/protocol";
import { validSourceArguments } from "./source-mcp.ts";
import type { SourcePollContext } from "./sources.ts";

/** The only Slack write: eyes on the stored parent, never the reply that surfaced the thread. */
export async function slackStart(context: SourcePollContext, item: TrackedItem): Promise<"reacted" | "skipped"> {
	const { channel, thread_ts: ts } = item.metadata;
	const args = { channel_id: channel, message_ts: ts, name: "eyes" };
	if (!validSourceArguments("startSlack", args)) throw new Error("Invalid Slack thread");
	if (!slackStartAllowed(context.config.slackChannels, item)) return "skipped";
	context.signal.throwIfAborted();
	await context.call("startSlack", args);
	return "reacted";
}

export function slackStartAllowed(channels: string[], item: TrackedItem): boolean {
	const { channel, channelName } = item.metadata;
	return channels.some(
		(entry) => entry === channel || (typeof channelName === "string" && entry.replace(/^#/, "") === channelName),
	);
}
