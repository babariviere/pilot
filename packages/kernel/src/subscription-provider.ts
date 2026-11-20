import type { SubscriptionUsage } from "@pilot/protocol";

export type SubscriptionProvider = NonNullable<SubscriptionUsage["provider"]>;

/** The pi provider each reported subscription belongs to. */
const PI_PROVIDERS = { anthropic: "anthropic", openai: "openai-codex" } as const satisfies Record<
	SubscriptionProvider,
	string
>;

/** The subscription a pi provider's windows report, or undefined when it reports none. */
export function subscriptionProvider(piProvider: string | undefined): SubscriptionProvider | undefined {
	return (Object.keys(PI_PROVIDERS) as SubscriptionProvider[]).find(
		(provider) => PI_PROVIDERS[provider] === piProvider,
	);
}

export function subscriptionPiProvider(provider: SubscriptionProvider): string {
	return PI_PROVIDERS[provider];
}
