import type { SubscriptionUsage } from "./index.ts";

/** Account-wide provider limits, independent of Local historical token aggregates. */
export interface SubscriptionRefreshProvider {
	provider: "anthropic" | "openai";
	/** The current cache protocol does not identify the account. Never infer one from a chat. */
	account: "not_reported";
	state: "idle" | "refreshing" | "refreshed" | "cached" | "deferred" | "unavailable" | "error";
	/** Authoritative provider-response time, never the time the UI read this envelope. */
	usage?: SubscriptionUsage;
}

/** GET /api/subscription-usage; POST /api/subscription-usage/refresh?provider=anthropic|openai.
 * Both require pinned daemonId and lineageId query parameters. POST may contact the provider;
 * concurrent requests coalesce, respecting Pi's existing cache, request lock and backoff.
 */
export interface SubscriptionRefreshSnapshot {
	providers: SubscriptionRefreshProvider[];
}
