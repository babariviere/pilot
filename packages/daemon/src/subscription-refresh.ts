/** Explicit app requests only. No timers, agent starts, token retention or credential access here. */
import type { RefreshResult } from "@pilot/kernel/subscription-refresh";
import type { SubscriptionRefreshProvider, SubscriptionRefreshSnapshot } from "@pilot/protocol";
import { parseUsageCache } from "./subscription-usage.ts";

type Provider = SubscriptionRefreshProvider["provider"];
export class SubscriptionRefresh {
	private readonly values = new Map<Provider, SubscriptionRefreshProvider>();
	private readonly pending = new Map<Provider, Promise<SubscriptionRefreshProvider>>();
	private readonly collect: (provider: Provider) => Promise<RefreshResult>;
	constructor(collect: (provider: Provider) => Promise<RefreshResult>) {
		this.collect = collect;
	}
	snapshot(): SubscriptionRefreshSnapshot {
		return {
			providers: (["anthropic", "openai"] as const).map((provider) =>
				structuredClone(this.values.get(provider) ?? { provider, account: "not_reported", state: "idle" }),
			),
		};
	}
	refresh(provider: Provider): Promise<SubscriptionRefreshProvider> {
		const pending = this.pending.get(provider);
		if (pending) return pending;
		const previous = this.values.get(provider);
		this.values.set(provider, { ...previous, provider, account: "not_reported", state: "refreshing" });
		const work = this.run(provider).finally(() => this.pending.delete(provider));
		this.pending.set(provider, work);
		return work;
	}
	private async run(provider: Provider): Promise<SubscriptionRefreshProvider> {
		let state: SubscriptionRefreshProvider["state"] = "error";
		let usage = this.values.get(provider)?.usage;
		try {
			const result = await this.collect(provider);
			state = result.outcome;
			if ((state === "refreshed" || state === "cached") && !result.usage) state = "error";
			if (result.usage) {
				const parsed = parseUsageCache({ fetchedAt: result.usage.fetchedAt, snapshot: result.usage }, provider);
				if (!parsed || parsed.error) state = "error";
				else usage = parsed;
			}
		} catch {
			/* No raw provider/account errors leave the owner. Keep the previous dated report. */
		}
		const value: SubscriptionRefreshProvider = {
			provider,
			account: "not_reported",
			state,
			...(usage ? { usage } : {}),
		};
		this.values.set(provider, value);
		return structuredClone(value);
	}
}
