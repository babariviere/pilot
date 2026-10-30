/** Tool-free subscription reads through Pi's canonical credential owner, never local-client fallbacks. */
import { fileURLToPath, pathToFileURL } from "node:url";
import { PILOT_PROFILE_PATH } from "@babariviere/pi-extensions/profile";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { SubscriptionRefreshProvider, SubscriptionUsage } from "@pilot/protocol";
import { createJiti } from "jiti";

type Provider = SubscriptionRefreshProvider["provider"];
type Entry = { fetchedAt: number; snapshot: Omit<SubscriptionUsage, "fetchedAt"> };
export interface UsageSource {
	readCache(provider: Provider, agentDir: string): Entry | undefined;
	fetchWithCache(provider: Provider, token: string, agentDir: string): Promise<Entry["snapshot"] | undefined>;
}
export type RefreshResult = { outcome: "refreshed" | "cached" | "deferred" | "unavailable"; usage?: SubscriptionUsage };
let source: Promise<UsageSource> | undefined;
function usageSource(): Promise<UsageSource> {
	source ??= createJiti(import.meta.url).import<UsageSource>(
		fileURLToPath(new URL("../extensions/usage/source.ts", pathToFileURL(PILOT_PROFILE_PATH))),
	);
	return source;
}

export async function refreshSubscription(
	provider: Provider,
	agentDir: string,
	runtime: Pick<ModelRuntime, "listCredentials" | "getAuth">,
	injected?: UsageSource,
): Promise<RefreshResult> {
	const id = provider === "openai" ? "openai-codex" : "anthropic";
	// Do not execute configured API-key commands or read Claude Code/CLI stores.
	if (!(await runtime.listCredentials()).some((c) => c.providerId === id && c.type === "oauth"))
		return { outcome: "unavailable" };
	const token = (await runtime.getAuth(id))?.auth.apiKey;
	if (!token || (provider === "anthropic" && !token.startsWith("sk-ant-oat"))) return { outcome: "unavailable" };
	const api = injected ?? (await usageSource());
	const before = api.readCache(provider, agentDir);
	const result = await api.fetchWithCache(provider, token, agentDir);
	if (!result)
		return {
			outcome: "deferred",
			...(before && !before.snapshot.error ? { usage: { ...before.snapshot, fetchedAt: before.fetchedAt } } : {}),
		};
	// fetchWithCache can return a recent cache hit. Read its actual response timestamp,
	// not Date.now(), even when another process completed the coalesced request.
	const entry = api.readCache(provider, agentDir);
	if (!entry || entry.snapshot.error) return { outcome: "deferred" };
	return {
		outcome: entry.fetchedAt === before?.fetchedAt ? "cached" : "refreshed",
		usage: { ...entry.snapshot, fetchedAt: entry.fetchedAt },
	};
}
