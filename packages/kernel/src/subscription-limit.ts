/** Provider-reported subscription exhaustion. Never treats transient throttling or billing as a pause. */
import { setTimeout as delay } from "node:timers/promises";
import type { SubscriptionGate } from "@babariviere/pi-extensions/subscription-gate";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";

export interface SubscriptionLimitReport {
	provider: "anthropic" | "openai";
	resetsAt?: string;
}
export type ReportSubscriptionLimit = (limit: SubscriptionLimitReport) => Promise<void>;

export function subscriptionLimitReport(
	error: unknown,
	piProvider: string,
	now = Date.now(),
): SubscriptionLimitReport | undefined {
	const provider = piProvider === "openai-codex" ? "openai" : piProvider === "anthropic" ? "anthropic" : undefined;
	if (!provider) return;
	const parts: string[] = [];
	const seen = new Set<unknown>();
	for (let depth = 0; error && depth < 5 && !seen.has(error); depth++) {
		seen.add(error);
		const value = typeof error === "object" ? (error as { message?: unknown; cause?: unknown }) : undefined;
		parts.push((typeof error === "string" ? error : String(value?.message ?? "")).slice(0, 2048));
		error = value?.cause;
	}
	const text = parts.join("\n");
	if (
		!/usage_limit_reached|subscription_sharing_usage_limit_exceeded|(?:hit|reached|exceeded) your (?:ChatGPT |Claude |weekly |monthly )?(?:usage )?limit|usage limit (?:has been )?(?:reached|exceeded)/i.test(
			text,
		)
	)
		return;
	// Only machine-readable reset times are authoritative. Do not guess a timezone or a rounded delay.
	const seconds = text.match(/"resets_at"\s*:\s*(\d{10}(?:\.\d+)?)/)?.[1];
	const iso = text.match(/"resetsAt"\s*:\s*"([^"]{1,40})"/)?.[1];
	const reset = seconds ? Number(seconds) * 1000 : Date.parse(iso ?? "");
	return { provider, ...(Number.isFinite(reset) && reset > now ? { resetsAt: new Date(reset).toISOString() } : {}) };
}

/** Holds only a failed model request. Native tool results and their unsafe intent are never retried. */
export function subscriptionRecovery(
	provider: () => string,
	gate: SubscriptionGate,
	report?: ReportSubscriptionLimit,
): (error: unknown, signal?: AbortSignal) => Promise<boolean> {
	return async (error, signal) => {
		const physicalProvider = provider();
		const limit = subscriptionLimitReport(error, physicalProvider);
		if (!report || !limit) return false;
		// Persist the admission hold before reading it. IPC/disk unavailability must not turn a known
		// usage pause into a failed turn or allow a busy retry loop against the provider.
		while (true) {
			signal?.throwIfAborted();
			try {
				await awaitWithContext(
					report(limit),
					signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT,
				);
				break;
			} catch {
				signal?.throwIfAborted();
				await delay(2_000, undefined, { signal });
			}
		}
		signal?.throwIfAborted();
		await gate.wait(physicalProvider, signal);
		return true;
	};
}
