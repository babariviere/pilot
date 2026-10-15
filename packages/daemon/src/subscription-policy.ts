import type { SubscriptionPauseWindow } from "@pilot/protocol";
import {
	SUBSCRIPTION_PROVIDERS,
	SUBSCRIPTION_USAGE_MAX_AGE_MS,
	type SubscriptionProvider,
	type SubscriptionUsageSource,
} from "./subscription-usage.ts";

export const SUBSCRIPTION_PAUSE_PERCENT = 95;

/** Also written to a private, host-owned file read by parent and child admission gates. */
export interface SubscriptionPolicy {
	version: 1;
	windows: SubscriptionPauseWindow[];
	forced: string[];
	/** Prevent a stale/lower cache replay from releasing a known blocked window. */
	observed?: Partial<Record<SubscriptionProvider, number>>;
}

export const subscriptionWindowKey = (window: SubscriptionPauseWindow): string =>
	JSON.stringify([window.provider, window.label, window.resetsAt ?? null]);

export function windowUnexpired(window: SubscriptionPauseWindow, now = Date.now()): boolean {
	const reset = Date.parse(window.resetsAt ?? "");
	return !Number.isFinite(reset) || reset > now;
}

/** Unknown/error readings never thaw a known pause. A reset does not require a provider round trip. */
export function refreshSubscriptionPolicy(
	previous: SubscriptionPolicy | undefined,
	source: SubscriptionUsageSource | undefined,
	now = Date.now(),
): SubscriptionPolicy {
	const windows: SubscriptionPauseWindow[] = [];
	const observed: NonNullable<SubscriptionPolicy["observed"]> = {};
	for (const provider of SUBSCRIPTION_PROVIDERS) {
		const old =
			previous?.windows.filter((window) => window.provider === provider && windowUnexpired(window, now)) ?? [];
		const usage = source?.get(provider);
		const current =
			usage &&
			!usage.error &&
			usage.windows.length &&
			usage.fetchedAt <= now &&
			now - usage.fetchedAt < SUBSCRIPTION_USAGE_MAX_AGE_MS &&
			usage.fetchedAt >= (previous?.observed?.[provider] ?? 0);
		if (current) {
			const blocked = usage.windows
				.filter(
					(window) =>
						!window.label.startsWith("Extra") &&
						Number.isFinite(window.usedPercent) &&
						window.usedPercent >= SUBSCRIPTION_PAUSE_PERCENT,
				)
				.map((window) => ({ ...window, provider }))
				.filter((window) => windowUnexpired(window, now));
			windows.push(...blocked);
			if (blocked.length) observed[provider] = usage.fetchedAt;
		} else {
			windows.push(...old);
			if (old.length && previous?.observed?.[provider] !== undefined)
				observed[provider] = previous.observed[provider];
		}
	}
	const keys = new Set(windows.map(subscriptionWindowKey));
	return {
		version: 1,
		windows,
		forced: (previous?.forced ?? []).filter((key) => keys.has(key)),
		...(Object.keys(observed).length ? { observed } : {}),
	};
}
