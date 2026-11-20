import type { TrackedItem } from "@pilot/protocol";
import type { SourcePollContext } from "./source-poll.ts";
import { validSourceArguments } from "./source-tool-rules.ts";

/** Start write: eyes on the stored parent, never the reply that surfaced the thread. */
export async function slackStart(context: SourcePollContext, item: TrackedItem): Promise<"reacted" | "skipped"> {
	const { channel, thread_ts: ts } = item.metadata;
	const args = { channel_id: channel, message_ts: ts, emoji: "eyes" };
	if (!validSourceArguments("startSlack", args)) throw new Error("Invalid Slack thread");
	if (!slackStartAllowed(context.config.slackChannels, item)) return "skipped";
	context.signal.throwIfAborted();
	await context.call("startSlack", args);
	return "reacted";
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
