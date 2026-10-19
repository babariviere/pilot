import { createHash } from "node:crypto";
import type { SlackExcerpt, TrackedItem, TrackingJson } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import type { ModelCatalog } from "./models.ts";
import { parseSlackClassification, type SlackClassification, type SlackClassifierContext } from "./slack-classifier.ts";
import {
	parseSlackPage,
	parseSlackThread,
	parseSlackThreadParent,
	SLACK_SEARCH_CHARS,
	SlackFormatChanged,
	slackExcerptText,
	slackTimestamp,
} from "./slack-format.ts";
import {
	dominantSlackGroup,
	mentionsMe,
	parseSlackIdentity,
	parseSlackMentions,
	type SlackIdentity,
} from "./slack-mentions.ts";
import { SourceToolError } from "./source-mcp.ts";
import type { SourcePollContext, SourcePoller, SourcePollResult } from "./sources.ts";
import type { TrackedInput, TrackedItemStore } from "./tracked-items.ts";
import type { SlackCache } from "./tracked-items-disk.ts";

export const SLACK_CONFIDENCE_THRESHOLD = 0.8;
export const SLACK_BATCH_SIZE = 8;
const THREAD_LIMIT = 30;
/** The inspector's quote: a few lines, enough to recognize the message. Open in Slack shows the rest. */
export const SLACK_EXCERPT_CHARS = 600;
export const SLACK_EXCERPT_LINES = 10;
/** A newly added channel starts this far back. Classification results are cached per thread. */
const INITIAL_LOOKBACK_MS = 7 * 86_400_000;
/** Your Slack user ID and username rarely change. One profile read a day is enough. */
const IDENTITY_TTL_MS = 86_400_000;
/** An unresolved group handle is searched again at most this often. A resolved one never is. */
const GROUP_RETRY_MS = 86_400_000;
const GROUP_SEARCH_LIMIT = 20;
/** Mention-only scopes include this so checkpoints from the former search-based discovery start over once:
 * their search cursors are not valid history cursors. */
const MENTION_SCOPE_VERSION = "history";
// Compact tuples keyed by a short channel hash, so adding or removing a channel keeps the others' progress.
type ChannelCursor = [
	oldest: string,
	latest: string | null,
	next: string | null,
	pulledAt: number | null,
	failedAt: number | null,
];
type Cursor = {
	version: 2;
	last: string | null;
	channels: Record<string, ChannelCursor>;
	// term and privateSearch are left over from search-based discovery. They are read but no longer used.
	mentions?: Record<string, [scope: string, term: number, privateSearch?: boolean]>;
};
type CacheStore = Pick<
	TrackedItemStore,
	"slackCached" | "reserveSlack" | "finishSlack" | "corrections" | "slackGroups" | "saveSlackGroup"
>;

/** The project's labels, latest corrections and triage guide, as the classifier reads them. */
async function classifierContextFor(store: CacheStore, context: SourcePollContext): Promise<SlackClassifierContext> {
	const recent =
		"triageContext" in store
			? await (store as TrackedItemStore).triageContext(context.project.id, "slack")
			: undefined;
	return {
		labels: context.config.slackLabels ?? [],
		corrections: recent
			? (recent.corrections as SlackClassifierContext["corrections"])
			: (await store.corrections(context.project.id)).slice(0, 5),
		guide: recent?.guide.text ?? "",
	};
}

/** Per-channel progress for source status. Old or foreign checkpoints report nothing. */
export function slackChannelProgress(
	value: TrackingJson | undefined,
	channels: string[],
	includeCoverage = false,
): Array<{ pulledAt?: number; failedAt?: number; hasMore?: boolean }> {
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
			...(includeCoverage && state && state[3] !== null ? { hasMore: state[2] !== null } : {}),
		};
	});
}

/** One history page per poll, round-robin channels. At most eight tool-free classification attempts.
 * A channel the tool refuses (for example, no access) is marked failed and the others keep their turns.
 * Mention-only channels read the same history and keep top-level messages that mention you or your groups.
 * Mentions only in thread replies are not found: that would need a search or a thread read per message. */
export function createSlackPoller(
	store: CacheStore,
	models: Pick<ModelCatalog, "classifySlack"> & Partial<Pick<ModelCatalog, "prepareSlackClassifier">>,
	now = Date.now,
): SourcePoller {
	const active = new Map<string, Promise<SlackCache>>();
	let identity: { value: SlackIdentity; at: number } | undefined;
	return async (context) => {
		const names = context.config.slackChannels;
		if (!names.length) return { items: [] };
		if (names.length > 100) throw new Error("Too many configured Slack channels");
		context.signal.throwIfAborted();
		const cursor = readCursor(context.cursor, names, now());
		const last = cursor.last === null ? -1 : names.findIndex((name) => channelKey(name) === cursor.last);
		const name = names[(last + 1) % names.length]!;
		const channelIndex = (last + 1) % names.length;
		context.observe?.({ stage: "discovery", phase: "started", channelIndex });
		const key = channelKey(name);
		const filtered = context.config.slackMentionOnlyChannels?.includes(name) ?? false;
		const groups = context.config.slackGroupHandles ?? [];
		// Filter edits reset only this channel's discovery, never the classification cache or existing items.
		const scope = channelKey(JSON.stringify([MENTION_SCOPE_VERSION, groups]));
		const priorMention = cursor.mentions?.[key];
		if ((filtered && priorMention?.[0] !== scope) || (!filtered && priorMention)) {
			cursor.channels[key] = [timestamp(now() - INITIAL_LOOKBACK_MS), null, null, null, null];
			cursor.mentions ??= {};
			if (filtered) cursor.mentions[key] = [scope, 0];
			else delete cursor.mentions[key];
		}
		const [oldest, savedLatest, next, pulledAt] = cursor.channels[key]!;
		const latest = savedLatest ?? timestamp(now());
		cursor.last = key;
		let page: ReturnType<typeof parseSlackPage>;
		const items: TrackedInput[] = [];
		let issue: SourcePollResult["issue"],
			deferred = false;
		try {
			let me: SlackIdentity | undefined;
			const groupIds: string[] = [];
			if (filtered) {
				if (!identity || now() - identity.at >= IDENTITY_TTL_MS) {
					const value = parseSlackIdentity(await context.call("profile", { response_format: "detailed" }));
					identity = { value, at: now() };
				}
				me = identity.value;
				// History shows group mentions only by ID. Learn each handle's ID once, with one search in this channel.
				const known = groups.length ? await store.slackGroups(groups) : {};
				const unresolved = groups.find((handle) => {
					const entry = known[handle];
					return !entry || (entry.id === null && now() - entry.checkedAt >= GROUP_RETRY_MS);
				});
				if (unresolved) {
					const id = await resolveGroup(context, name, unresolved);
					await store.saveSlackGroup(unresolved, id, now());
					known[unresolved] = { id, checkedAt: now() };
				}
				for (const handle of groups) if (known[handle]?.id) groupIds.push(known[handle].id!);
			}
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
			context.observe?.({
				stage: "discovery",
				phase: "completed",
				outcome: "success",
				channelIndex,
				count: page.messages.length,
			});
			context.observe?.({ stage: "classification", phase: "started" });
			let classifierContext: SlackClassifierContext | undefined;
			let classify: ((text: string) => Promise<SlackClassification>) | undefined;
			const seen = new Set<string>();
			for (const message of page.messages) {
				context.signal.throwIfAborted();
				if (filtered && !mentionsMe(message.text, me!, groups, groupIds)) continue;
				if (seen.has(message.threadTs)) continue;
				seen.add(message.threadTs);
				// The thread's text when it was read for classification, else the message's own: kept for search only.
				let searchText = message.text;
				const threadKey = `${context.project.id}/${page.channel}/${message.threadTs}`;
				let cached = await store.slackCached(page.channel, message.threadTs, context.project.id);
				if (cached?.state === "pending") {
					cached = active.has(threadKey) ? await active.get(threadKey)! : { state: "error" };
				}
				if (!cached) {
					// Read the bounded full context only for a new qualifying parent with replies.
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
					message.replies = thread.messages[0]!.replies;
					searchText = thread.messages.map((reply) => reply.text).join("\n\n");
					classifierContext ??= await classifierContextFor(store, context);
					classify ??= models.prepareSlackClassifier
						? await models.prepareSlackClassifier(context.project.path, context.signal, classifierContext)
						: (text) => models.classifySlack(context.project.path, text, context.signal, classifierContext);
					context.signal.throwIfAborted();
					const reservation = await store.reserveSlack(page.channel, message.threadTs, now(), context.project.id);
					if (reservation.state === "budget") {
						context.observe?.({
							stage: "classification",
							phase: "partial",
							reason: "local_classification_budget",
						});
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
				if (cached?.state !== "done") {
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
					searchText: searchText.slice(0, SLACK_SEARCH_CHARS),
					url: `https://slack.com/archives/${page.channel}/p${message.threadTs.replace(".", "")}`,
					status: "open",
					updatedAt: Number(message.threadTs) * 1000,
					metadata: {
						channel: page.channel,
						...(filtered ? { mentionQualified: true } : {}),
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
			context.observe?.({
				stage: "discovery",
				phase: "completed",
				outcome: "partial",
				reason: "channel_read",
				channelIndex,
			});
			cursor.channels[key] = [oldest, savedLatest, next, pulledAt, now()];
			return { items: [], cursor: cursor as unknown as TrackingJson, issue: "slack_channel" };
		}
		const pulled = now();
		context.observe?.({
			stage: "classification",
			phase: "completed",
			outcome:
				issue === "slack_budget" ? "budget_limited" : issue === "slack_classification" ? "partial" : "success",
			...(issue
				? { reason: issue === "slack_budget" ? "local_classification_budget" : "classification_failed" }
				: {}),
		});
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

/** One channel-scoped search for a group handle. A refusal or unfamiliar result leaves it unresolved for a day. */
async function resolveGroup(context: SourcePollContext, channel: string, handle: string): Promise<string | null> {
	try {
		const page = parseSlackMentions(
			await context.call("mentionsPrivate", {
				keywords: [`@${handle}`],
				filters: /^[CDG][A-Z0-9]+$/.test(channel) ? `in:<#${channel}>` : `in:${channel.replace(/^#/, "")}`,
				natural_language_query: "",
				content_types: "messages",
				include_context: false,
				include_bots: true,
				channel_types: "public_channel,private_channel",
				limit: GROUP_SEARCH_LIMIT,
				response_format: "detailed",
			}),
			channel,
			channel.replace(/^#/, ""),
			GROUP_SEARCH_LIMIT,
		);
		return dominantSlackGroup(page);
	} catch (error) {
		if (context.signal.aborted || !(error instanceof SourceToolError || error instanceof SlackFormatChanged))
			throw error;
		return null;
	}
}

export type SlackMessageLink = { channel: string; ts: string; threadTs: string };
export type SlackAdder = (context: SourcePollContext, link: SlackMessageLink) => Promise<TrackedInput>;

/** Adds one message the user pasted, from any channel their Slack account can read. Reads its thread and classifies
 * it like a polled thread: cached per project and sharing the daily budget, but a cached failure is retried because
 * the user asked. When classification is unavailable the message is still added, untyped, titled by its first line.
 * The row is marked manual, so it stays listed when its channel is not tracked. */
export function createSlackAdder(
	store: CacheStore,
	models: Pick<ModelCatalog, "classifySlack"> & Partial<Pick<ModelCatalog, "prepareSlackClassifier">>,
	now = Date.now,
): SlackAdder {
	return async (context, link) => {
		const thread = parseSlackThread(
			await context.call("thread", {
				channel_id: link.channel,
				message_ts: link.threadTs,
				limit: THREAD_LIMIT,
				response_format: "detailed",
			}),
			link.threadTs,
			THREAD_LIMIT,
		);
		const parent = thread.messages[0]!;
		let channelName = context.config.slackChannelNames?.[link.channel];
		if (!channelName) {
			// Thread reads omit the channel. One history read around the parent names it; the row works without it.
			try {
				const page = parseSlackPage(
					await context.call("history", {
						channel_id: link.channel,
						oldest: link.threadTs,
						latest: link.threadTs,
						limit: 1,
						response_format: "detailed",
					}),
					1,
				);
				if (page.channel === link.channel) channelName = page.name;
			} catch (error) {
				if (context.signal.aborted) throw error;
			}
		}
		context.signal.throwIfAborted();
		let result: SlackClassification | undefined;
		const reservation = await store.reserveSlack(link.channel, link.threadTs, now(), context.project.id, true);
		if (reservation.state === "done") result = reservation.result;
		else if (reservation.state === "reserved") {
			try {
				const classifierContext = await classifierContextFor(store, context);
				const classified = models.prepareSlackClassifier
					? await (await models.prepareSlackClassifier(context.project.path, context.signal, classifierContext))(
							thread.messages
								.map((reply) => reply.text)
								.join("\n\n")
								.slice(0, 12_000),
						)
					: await models.classifySlack(
							context.project.path,
							thread.messages
								.map((reply) => reply.text)
								.join("\n\n")
								.slice(0, 12_000),
							context.signal,
							classifierContext,
						);
				result = parseSlackClassification(JSON.stringify(classified), classifierContext.labels);
			} catch (error) {
				if (context.signal.aborted) {
					await store.finishSlack(link.channel, link.threadTs, undefined, context.project.id);
					throw error;
				}
			}
			await store.finishSlack(link.channel, link.threadTs, result, context.project.id);
		}
		context.signal.throwIfAborted();
		const title = result?.summary ?? firstLine(parent.text);
		const type = !result || result.confidence < SLACK_CONFIDENCE_THRESHOLD ? "unknown" : result.type;
		const label =
			result && context.config.slackLabels?.some((entry) => entry.name === result.label) ? result.label : null;
		return {
			externalId: `${link.channel}/${link.threadTs}`,
			title,
			searchText: thread.messages
				.map((reply) => reply.text)
				.join("\n\n")
				.slice(0, SLACK_SEARCH_CHARS),
			url: `https://slack.com/archives/${link.channel}/p${link.threadTs.replace(".", "")}`,
			status: "open",
			updatedAt: Number(link.threadTs) * 1000,
			metadata: {
				channel: link.channel,
				...(channelName ? { channelName } : {}),
				thread_ts: link.threadTs,
				replies: parent.replies,
				...(result ?? { confidence: 0, severity: "low", summary: title }),
				type,
				label,
				manual: true,
			},
		};
	};
}
/** A plain, single-line title from a message's text, for messages Pilot could not classify. */
function firstLine(text: string): string {
	const line = text
		.split("\n")
		.map((part) =>
			part
				.replace(/[\x00-\x1f\x7f]/g, " ")
				.replace(/\s+/g, " ")
				.trim(),
		)
		.find(Boolean);
	if (!line) return "Slack message";
	return line.length > 240 ? `${line.slice(0, 239).trimEnd()}…` : line;
}

/** Read one thread's first message for the triage inspector, only from a channel the project still tracks.
 * Plain, bounded text that is returned to the app and never stored. */
export async function slackExcerpt(context: SourcePollContext, item: TrackedItem): Promise<SlackExcerpt> {
	const { channel, channelName, thread_ts: ts } = item.metadata;
	if (typeof channel !== "string" || !/^[CDG][A-Z0-9]{1,199}$/.test(channel) || !slackTimestamp(ts))
		throw new Conflict("This message can't be read from Slack");
	const tracked =
		item.metadata.manual === true ||
		context.config.slackChannels.some(
			(configured) =>
				configured === channel || (typeof channelName === "string" && configured.replace(/^#/, "") === channelName),
		);
	if (!tracked) throw new Conflict("This message's channel was removed from this project");
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
	const mentions = previous.mentions;
	if (
		mentions !== undefined &&
		(!mentions ||
			typeof mentions !== "object" ||
			Array.isArray(mentions) ||
			Object.keys(mentions).length > 100 ||
			Object.values(mentions).some(
				(entry) =>
					!Array.isArray(entry) ||
					(entry.length !== 2 && entry.length !== 3) ||
					(entry[2] !== undefined && typeof entry[2] !== "boolean") ||
					typeof entry[0] !== "string" ||
					!/^[\w-]{12}$/.test(entry[0]) ||
					!Number.isInteger(entry[1]) ||
					entry[1] < 0 ||
					entry[1] > 30,
			))
	)
		throw new Error("Invalid Slack checkpoint");
	return {
		version: 2,
		last: previous.last ?? null,
		...(mentions
			? {
					mentions: Object.fromEntries(
						names.flatMap((name) => {
							const key = channelKey(name);
							return Object.hasOwn(mentions, key)
								? [[key, [...mentions[key]!] as [string, number, boolean?]]]
								: [];
						}),
					),
				}
			: {}),
		channels: Object.fromEntries(
			names.map((name) => {
				const key = channelKey(name);
				return [key, Object.hasOwn(channels, key) ? structuredClone(channels[key]!) : fresh()];
			}),
		),
	};
}
