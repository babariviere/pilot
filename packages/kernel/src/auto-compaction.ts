/**
 * Compact a long, cold conversation before the user's next message. Once the provider's prompt cache has expired,
 * the next turn pays full price for the whole history and every later request in the turn re-reads it. Summarizing
 * first costs one read of that history plus a short summary, and the turn then runs on a much smaller context.
 * A warm cache is never thrown away: reading it is about a tenth of the price of rereading the history.
 */
import type { Message } from "@earendil-works/pi-ai";

/** Compact once the context reaches this share of the window, or the absolute cap, whichever is lower. */
export const AUTO_COMPACT_FRACTION = 0.4;
export const AUTO_COMPACT_MAX_TOKENS = 100_000;

const MINUTE = 60_000;

export function autoCompactionThreshold(contextWindow: number): number {
	return Math.min(contextWindow * AUTO_COMPACT_FRACTION, AUTO_COMPACT_MAX_TOKENS);
}

/**
 * How long the provider may keep a prompt cache warm after its last use, erring long: compacting a warm cache wastes
 * money, while skipping a cold one only forgoes a saving. Mirrors pi-ai's `PI_CACHE_RETENTION` handling.
 */
export function promptCacheLifetimeMs(api: string, env: NodeJS.ProcessEnv = process.env): number {
	const long = env.PI_CACHE_RETENTION === "long";
	if (api === "anthropic-messages") return long ? 60 * MINUTE : 5 * MINUTE;
	// OpenAI keeps in-memory caches for 5 to 10 minutes; extended retention lasts up to 24 hours.
	if (api.startsWith("openai-") || api.startsWith("azure-openai")) return long ? 24 * 60 * MINUTE : 10 * MINUTE;
	return long ? 24 * 60 * MINUTE : 60 * MINUTE;
}

/** Whether the next user turn should start from a summary. `messages` is the conversation's model context. */
export function shouldAutoCompact(
	messages: readonly Message[],
	context: { tokens?: number; contextWindow: number } | undefined,
	now: number,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (context?.tokens === undefined || context.tokens < autoCompactionThreshold(context.contextWindow)) return false;
	const last = messages.findLast((message) => message.role === "assistant");
	if (last?.role !== "assistant" || !Number.isFinite(last.timestamp)) return false;
	// The cache was last used by that request; its response time only makes the estimate safer.
	const lastUse = last.timestamp + (last.durationMs ?? 0);
	return now - lastUse >= promptCacheLifetimeMs(last.api, env);
}
