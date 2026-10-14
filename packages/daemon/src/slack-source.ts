import { createHash } from "node:crypto";
import type { SlackExcerpt, TrackedItem, TrackingJson } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import type { ModelCatalog } from "./models.ts";
import {
	parseSlackPage,
	parseSlackThread,
	parseSlackThreadParent,
	slackExcerptText,
	slackTimestamp,
	SlackFormatChanged,
} from "./slack-format.ts";
import { SourceToolError } from "./source-mcp.ts";
import type { SourcePollContext, SourcePoller, SourcePollResult } from "./sources.ts";
import type { TrackedInput, TrackedItemStore } from "./tracked-items.ts";
import type { SlackCache } from "./tracked-items-disk.ts";
import { parseSlackClassification, type SlackClassifierContext, type SlackClassification } from "./slack-classifier.ts";

export const SLACK_CONFIDENCE_THRESHOLD = 0.8;
export const SLACK_BATCH_SIZE = 8;
const THREAD_LIMIT = 30;
/** The inspector's quote: a few lines, enough to recognize the message. Open in Slack shows the rest. */
export const SLACK_EXCERPT_CHARS = 600;
export const SLACK_EXCERPT_LINES = 10;
/** A newly added channel starts this far back. Classification results are cached per thread. */
const INITIAL_LOOKBACK_MS = 7 * 86_400_000;
// Compact tuples keyed by a short channel hash, so adding or removing a channel keeps the others' progress.
type ChannelCursor = [
	oldest: string,
	latest: string | null,
	next: string | null,
	pulledAt: number | null,
	failedAt: number | null,
];
type Cursor = { version: 2; last: string | null; channels: Record<string, ChannelCursor> };
type CacheStore = Pick<TrackedItemStore, "slackCached" | "reserveSlack" | "finishSlack" | "corrections">;

/** Per-channel progress for source status. Old or foreign checkpoints report nothing. */
export function slackChannelProgress(
	value: TrackingJson | undefined,
	channels: string[],
): Array<{ pulledAt?: number; failedAt?: number }> {
	let cursor: Cursor | undefined;
	try {
		cursor = value === undefined ? undefined : readCursor(value, channels, 0);
	} catch {
		cursor = undefined;
	}
	return channels.map((channel) => {
		const state = cursor?.channels[channelKey(channel)];
		return {
			...(state?.[3] ? { pulledAt: state[3] } : {}),
			...(state?.[4] ? { failedAt: state[4] } : {}),
		};
	});
}

/** One history page per poll, round-robin channels. At most eight tool-free classification attempts.
 * A channel the tool refuses (for example, no access) is marked failed and the others keep their turns. */
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
		const last = cursor.last === null ? -1 : names.findIndex((name) => channelKey(name) === cursor.last);
		const name = names[(last + 1) % names.length]!;
		const key = channelKey(name);
		const [oldest, savedLatest, next, pulledAt] = cursor.channels[key]!;
		const latest = savedLatest ?? timestamp(now());
		cursor.last = key;
		let page: ReturnType<typeof parseSlackPage>;
		const items: TrackedInput[] = [];
		let issue: SourcePollResult["issue"],
			deferred = false;
		try {
			page = parseSlackPage(
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
			let classifierContext: SlackClassifierContext | undefined;
			let classify: ((text: string) => Promise<SlackClassification>) | undefined;
			for (const message of page.messages) {
				context.signal.throwIfAborted();
				const threadKey = `${context.project.id}/${page.channel}/${message.threadTs}`;
				let cached = await store.slackCached(page.channel, message.threadTs, context.project.id);
				if (cached?.state === "pending") {
					cached = active.has(threadKey) ? await active.get(threadKey)! : { state: "error" };
				}
				if (!cached) {
					classifierContext ??= {
						labels: context.config.slackLabels ?? [],
						corrections: await store.corrections(context.project.id),
					};
					classify ??= models.prepareSlackClassifier
						? await models.prepareSlackClassifier(context.project.path, context.signal, classifierContext)
						: (text) => models.classifySlack(context.project.path, text, context.signal, classifierContext);
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
					const reservation = await store.reserveSlack(page.channel, message.threadTs, now(), context.project.id);
					if (reservation.state === "budget") {
						issue = "slack_budget";
						deferred = true;
						break;
					}
					if (reservation.state === "reserved") {
						const channel = page.channel;
						const work = (async (): Promise<SlackCache> => {
							try {
								context.signal.throwIfAborted();
								const classified = await classify!(
									thread.messages
										.map((reply) => reply.text)
										.join("\n\n")
										.slice(0, 12_000),
								);
								const result = parseSlackClassification(JSON.stringify(classified), classifierContext!.labels);
								await store.finishSlack(channel, message.threadTs, result, context.project.id);
								return { state: "done", result };
							} catch {
								await store.finishSlack(channel, message.threadTs, undefined, context.project.id);
								return { state: "error" };
							}
						})();
						active.set(threadKey, work);
						try {
							cached = await work;
						} finally {
							active.delete(threadKey);
						}
					} else
						cached =
							reservation.state === "pending" && active.has(threadKey)
								? await active.get(threadKey)!
								: reservation;
				}
				context.signal.throwIfAborted();
				if (!cached || cached.state !== "done") {
					issue ??= "slack_classification";
					continue;
				}
				const result = cached.result;
				const type = result.confidence < SLACK_CONFIDENCE_THRESHOLD ? "unknown" : result.type;
				const label = context.config.slackLabels?.some((label) => label.name === result.label)
					? result.label
					: null;
				items.push({
					externalId: `${page.channel}/${message.threadTs}`,
					title: result.summary,
					url: `https://slack.com/archives/${page.channel}/p${message.threadTs.replace(".", "")}`,
					status: "open",
					updatedAt: Number(message.threadTs) * 1000,
					metadata: {
						channel: page.channel,
						channelName: page.name,
						thread_ts: message.threadTs,
						replies: message.replies,
						...result,
						type,
						label,
					},
				});
			}
		} catch (error) {
			// Only the tool's own refusal is channel-specific. Sign-in, limits and format changes stop the source.
			if (!(error instanceof SourceToolError) || context.signal.aborted) throw error;
			cursor.channels[key] = [oldest, savedLatest, next, pulledAt, now()];
			return { items: [], cursor: cursor as unknown as TrackingJson, issue: "slack_channel" };
		}
		const pulled = now();
		cursor.channels[key] = deferred
			? [oldest, latest, next, pulled, null]
			: page.next
				? [oldest, latest, page.next, pulled, null]
				: [latest, null, null, pulled, null];
		return { items, cursor: cursor as unknown as TrackingJson, ...(issue ? { issue } : {}) };
	};
}
function timestamp(now: number): string {
	return `${Math.floor(now / 1000)}.000000`;
}

/** Read one thread's first message for the triage inspector, only from a channel the project still tracks.
 * Plain, bounded text that is returned to the app and never stored. */
export async function slackExcerpt(context: SourcePollContext, item: TrackedItem): Promise<SlackExcerpt> {
	const { channel, channelName, thread_ts: ts } = item.metadata;
	if (typeof channel !== "string" || !/^[CDG][A-Z0-9]{1,199}$/.test(channel) || !slackTimestamp(ts))
		throw new Conflict("This message can't be read from Slack");
	const tracked = context.config.slackChannels.some(
		(configured) =>
			configured === channel || (typeof channelName === "string" && configured.replace(/^#/, "") === channelName),
	);
	if (!tracked) throw new Conflict("This message's channel is no longer tracked");
	const parent = parseSlackThreadParent(
		// Only the parent is shown. Fetch as few replies as the tool allows.
		await context.call("thread", { channel_id: channel, message_ts: ts, limit: 1, response_format: "detailed" }),
		ts,
	);
	const { text, truncated } = slackExcerptText(parent.text, SLACK_EXCERPT_CHARS, SLACK_EXCERPT_LINES);
	return { itemId: item.id, ...(parent.author ? { author: parent.author } : {}), text, truncated };
}
/** Short, stable key. Configured entries can be up to 200 characters; the checkpoint stays small. */
function channelKey(channel: string): string {
	return createHash("sha256").update(channel).digest("base64url").slice(0, 12);
}
/** Keeps progress of channels still configured, starts new ones at the bounded lookback, drops removed ones. */
function readCursor(value: TrackingJson | undefined, names: string[], now: number): Cursor {
	const fresh = (): ChannelCursor => [timestamp(now - INITIAL_LOOKBACK_MS), null, null, null, null];
	const previous = value as unknown as (Omit<Partial<Cursor>, "version"> & { version?: number }) | null;
	// Version 1 cursors were positional and tied to the whole channel list. Start over once.
	if (value === undefined || (previous && typeof previous === "object" && previous.version === 1))
		return { version: 2, last: null, channels: Object.fromEntries(names.map((name) => [channelKey(name), fresh()])) };
	if (
		!previous ||
		typeof previous !== "object" ||
		previous.version !== 2 ||
		(previous.last !== null && (typeof previous.last !== "string" || previous.last.length > 32)) ||
		!previous.channels ||
		typeof previous.channels !== "object" ||
		Array.isArray(previous.channels) ||
		Object.keys(previous.channels).length > 100 ||
		Object.values(previous.channels).some(
			(channel) =>
				!Array.isArray(channel) ||
				channel.length !== 5 ||
				!slackTimestamp(channel[0]) ||
				(channel[1] !== null && !slackTimestamp(channel[1])) ||
				(channel[2] !== null &&
					(typeof channel[2] !== "string" || !channel[2].length || channel[2].length > 96 || !channel[1])) ||
				(channel[3] !== null && !Number.isFinite(channel[3])) ||
				(channel[4] !== null && !Number.isFinite(channel[4])),
		)
	)
		throw new Error("Invalid Slack checkpoint");
	const channels = previous.channels;
	return {
		version: 2,
		last: previous.last ?? null,
		channels: Object.fromEntries(
			names.map((name) => {
				const key = channelKey(name);
				return [key, Object.hasOwn(channels, key) ? structuredClone(channels[key]!) : fresh()];
			}),
		),
	};
}
