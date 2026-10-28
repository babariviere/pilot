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
	/** Window keys admission may pass (the gate's contract). Derived from `force` for current windows. */
	forced: string[];
	/** Force work: providers whose windows are ignored until the chat has no blocked window left. */
	force?: SubscriptionProvider[];
	/** Prevent a stale/lower cache replay from releasing a known blocked window. */
	observed?: Partial<Record<SubscriptionProvider, number>>;
}

export const subscriptionWindowKey = (window: SubscriptionPauseWindow): string =>
	JSON.stringify([window.provider, window.label, window.resetsAt ?? null]);

export function windowUnexpired(window: SubscriptionPauseWindow, now = Date.now()): boolean {
	const reset = Date.parse(window.resetsAt ?? "");
	return !Number.isFinite(reset) || reset > now;
}

/** A provider rejection is newer evidence than the cache, including an already-forced window. */
export function recordSubscriptionLimit(
	previous: SubscriptionPolicy | undefined,
	source: SubscriptionUsageSource | undefined,
	limit: Pick<SubscriptionPauseWindow, "provider" | "resetsAt">,
	now = Date.now(),
): SubscriptionPolicy {
	const next = refreshSubscriptionPolicy(previous, source, now);
	const blocked = next.windows.filter((window) => window.provider === limit.provider);
	const reset = Date.parse(limit.resetsAt ?? "");
	if (!blocked.length || (Number.isFinite(reset) && reset > now)) {
		next.windows = next.windows.filter(
			(window) => window.provider !== limit.provider || window.label !== "Usage limit",
		);
		next.windows.push({
			provider: limit.provider,
			label: "Usage limit",
			usedPercent: 100,
			...(Number.isFinite(reset) && reset > now ? { resetsAt: new Date(reset).toISOString() } : {}),
		});
	}
	const keys = new Set(next.windows.filter((window) => window.provider === limit.provider).map(subscriptionWindowKey));
	next.forced = next.forced.filter((key) => !keys.has(key));
	const force = next.force?.filter((provider) => provider !== limit.provider);
	if (force?.length) next.force = force;
	else delete next.force;
	// Re-reading the snapshot that preceded the rejection cannot immediately release this hold.
	next.observed = { ...next.observed, [limit.provider]: Math.max(now + 1, next.observed?.[limit.provider] ?? 0) };
	return next;
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
	// A reading can move a window's reset time or add a window; Force work still covers it.
	const force = windows.length ? previous?.force?.filter((provider) => SUBSCRIPTION_PROVIDERS.includes(provider)) : [];
	return {
		version: 1,
		windows,
		forced: [
			...new Set([
				...(previous?.forced ?? []).filter((key) => keys.has(key)),
				...windows.filter((window) => force?.includes(window.provider)).map(subscriptionWindowKey),
			]),
		],
		...(force?.length ? { force } : {}),
		...(Object.keys(observed).length ? { observed } : {}),
	};
}
