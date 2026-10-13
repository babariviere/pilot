import type { TrackingJson } from "@pilot/protocol";
import type { ModelCatalog } from "./models.ts";
import { parseSlackPage, parseSlackThread, slackTimestamp, SlackFormatChanged } from "./slack-format.ts";
import type { SourcePoller, SourcePollResult } from "./sources.ts";
import type { TrackedInput, TrackedItemStore } from "./tracked-items.ts";
import type { SlackCache } from "./tracked-items-disk.ts";
import type { SlackClassification } from "./slack-classifier.ts";

export const SLACK_CONFIDENCE_THRESHOLD = 0.8;
export const SLACK_BATCH_SIZE = 8;
const THREAD_LIMIT = 30;
const INITIAL_LOOKBACK_MS = 7 * 86_400_000;
// Compact positional tuples, aligned to the config fingerprint, fit 100 channels in a 16 KiB checkpoint.
type ChannelCursor = [oldest: string, latest: string | null, next: string | null];
type Cursor = { version: 1; index: number; channels: ChannelCursor[] };
type CacheStore = Pick<TrackedItemStore, "slackCached" | "reserveSlack" | "finishSlack">;

/** One history page per poll, round-robin channels. At most eight tool-free classification attempts. */
export function createSlackPoller(
	store: CacheStore,
	models: Pick<ModelCatalog, "classifySlack"> & Partial<Pick<ModelCatalog, "prepareSlackClassifier">>,
	now = Date.now,
): SourcePoller {
	const active = new Map<string, Promise<SlackCache>>();
	return async (context) => {
		const names = context.config.slackChannels;
		if (!names.length) return { items: [] };
		if (names.length > 100) throw new Error("Too many configured Slack channels");
		context.signal.throwIfAborted();
		const cursor = readCursor(context.cursor, names, now());
		const name = names[cursor.index]!;
		const [oldest, savedLatest, next] = cursor.channels[cursor.index]!;
		const latest = savedLatest ?? timestamp(now());
		const page = parseSlackPage(
			await context.call("history", {
				channel_id: name,
				oldest,
				latest,
				...(next ? { cursor: next } : {}),
				limit: SLACK_BATCH_SIZE,
				response_format: "detailed",
			}),
			SLACK_BATCH_SIZE,
		);
		if (/^[CDG][A-Z0-9]+$/.test(name) && name !== page.channel) throw new SlackFormatChanged();
		if (!/^[CDG][A-Z0-9]+$/.test(name) && name.replace(/^#/, "") !== page.name) throw new SlackFormatChanged();
		const items: TrackedInput[] = [];
		let classify: ((text: string) => Promise<SlackClassification>) | undefined;
		let issue: SourcePollResult["issue"],
			deferred = false;
		for (const message of page.messages) {
			context.signal.throwIfAborted();
			const key = `${page.channel}/${message.threadTs}`;
			let cached = await store.slackCached(page.channel, message.threadTs);
			if (cached?.state === "pending") {
				cached = active.has(key) ? await active.get(key)! : { state: "error" };
			}
			if (!cached) {
				classify ??= models.prepareSlackClassifier
					? await models.prepareSlackClassifier(context.project.path, context.signal)
					: (text) => models.classifySlack(context.project.path, text, context.signal);
				// Read only a bounded prefix, once. Later replies never cause reclassification.
				const thread = message.replies
					? parseSlackThread(
							await context.call("thread", {
								channel_id: page.channel,
								message_ts: message.threadTs,
								limit: THREAD_LIMIT,
								response_format: "detailed",
							}),
							message.threadTs,
							THREAD_LIMIT,
						)
					: { messages: [message] };
				context.signal.throwIfAborted();
				const reservation = await store.reserveSlack(page.channel, message.threadTs, now());
				if (reservation.state === "budget") {
					issue = "slack_budget";
					deferred = true;
					break;
				}
				if (reservation.state === "reserved") {
					const work = (async (): Promise<SlackCache> => {
						try {
							context.signal.throwIfAborted();
							const result = await classify!(
								thread.messages
									.map((reply) => reply.text)
									.join("\n\n")
									.slice(0, 12_000),
							);
							await store.finishSlack(page.channel, message.threadTs, result);
							return { state: "done", result };
						} catch {
							await store.finishSlack(page.channel, message.threadTs);
							return { state: "error" };
						}
					})();
					active.set(key, work);
					try {
						cached = await work;
					} finally {
						active.delete(key);
					}
				} else cached = reservation.state === "pending" && active.has(key) ? await active.get(key)! : reservation;
			}
			context.signal.throwIfAborted();
			if (!cached || cached.state !== "done") {
				issue ??= "slack_classification";
				continue;
			}
			const result = cached.result;
			if (!result.isBugReport || result.confidence < SLACK_CONFIDENCE_THRESHOLD) continue;
			items.push({
				externalId: `${page.channel}/${message.threadTs}`,
				title: result.summary,
				url: `https://slack.com/archives/${page.channel}/p${message.threadTs.replace(".", "")}`,
				status: "bug_report",
				updatedAt: Number(message.threadTs) * 1000,
				metadata: { channel: page.channel, thread_ts: message.threadTs, ...result },
			});
		}
		cursor.channels[cursor.index] = deferred
			? [oldest, latest, next]
			: page.next
				? [oldest, latest, page.next]
				: [latest, null, null];
		cursor.index = (cursor.index + 1) % names.length;
		return { items, cursor: cursor as unknown as TrackingJson, ...(issue ? { issue } : {}) };
	};
}
function timestamp(now: number): string {
	return `${Math.floor(now / 1000)}.000000`;
}
function readCursor(value: TrackingJson | undefined, names: string[], now: number): Cursor {
	if (value === undefined)
		return {
			version: 1,
			index: 0,
			channels: names.map(() => [timestamp(now - INITIAL_LOOKBACK_MS), null, null]),
		};
	const cursor = value as unknown as Cursor;
	if (
		!cursor ||
		cursor.version !== 1 ||
		!Number.isInteger(cursor.index) ||
		cursor.index < 0 ||
		cursor.index >= names.length ||
		!Array.isArray(cursor.channels) ||
		cursor.channels.length !== names.length ||
		cursor.channels.some(
			(channel) =>
				!Array.isArray(channel) ||
				channel.length !== 3 ||
				!slackTimestamp(channel[0]) ||
				(channel[1] !== null && !slackTimestamp(channel[1])) ||
				(channel[2] !== null &&
					(typeof channel[2] !== "string" || !channel[2].length || channel[2].length > 96 || !channel[1])),
		)
	)
		throw new Error("Invalid Slack checkpoint");
	return structuredClone(cursor);
}
