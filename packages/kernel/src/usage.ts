/** Usage presentation only. Provider polling and credentials stay in the user's usage extension. */
import type { Message } from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { ContextView } from "@earendil-works/pi-durable";
import type { ContextUsage, SessionUsage, SubscriptionUsage } from "@pilot/protocol";

/** Match the Harness's request-size estimate, never trusting usage from before a reset/compaction. */
export function contextUsage(view: ContextView, contextWindow: number | undefined): ContextUsage | undefined {
	if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
	let measured: Message | undefined;
	const after = view.head?.id ?? Number.NEGATIVE_INFINITY;
	for (let index = view.entries.length - 1; index >= 0 && measured === undefined; index--) {
		if (view.entries[index]!.id <= after) continue;
		measured = view.contributions[index]!.findLast(
			(message) => message.role === "assistant" && calculateContextTokens(message.usage) > 0,
		);
	}
	const from = measured === undefined ? 0 : view.messages.lastIndexOf(measured) + 1;
	let tokens = measured?.role === "assistant" ? calculateContextTokens(measured.usage) : 0;
	for (const message of view.messages.slice(from)) tokens += estimateMessageTokens(message);
	return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
}

const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Validate and copy the untyped event bus payload, forwarding only display data (never credentials). */
export function subscriptionUsage(data: unknown): SubscriptionUsage | undefined {
	if (!record(data) || !finite(data.fetchedAt) || data.fetchedAt < 0 || !record(data.snapshot)) return undefined;
	const snapshot = data.snapshot;
	if (!Array.isArray(snapshot.windows)) return undefined;
	if (snapshot.provider !== undefined && snapshot.provider !== "anthropic" && snapshot.provider !== "openai")
		return undefined;
	if (snapshot.error !== undefined && typeof snapshot.error !== "string") return undefined;
	const windows: SubscriptionUsage["windows"] = [];
	for (const window of snapshot.windows) {
		if (!record(window) || typeof window.label !== "string" || !finite(window.usedPercent) || window.usedPercent < 0)
			return undefined;
		if (window.resetsAt !== undefined && typeof window.resetsAt !== "string") return undefined;
		windows.push({
			label: window.label,
			usedPercent: window.usedPercent,
			...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
		});
	}
	return {
		fetchedAt: data.fetchedAt,
		...(snapshot.provider === undefined ? {} : { provider: snapshot.provider }),
		windows,
		...(snapshot.error === undefined ? {} : { error: snapshot.error }),
	};
}

export class UsageTracker {
	#usage: SessionUsage = {};
	constructor(private readonly onChange?: (usage: SessionUsage) => void) {}
	get current(): SessionUsage {
		return structuredClone(this.#usage);
	}
	setContext(context: ContextUsage | undefined): void {
		const { context: _previous, ...rest } = this.#usage;
		this.publish({ ...rest, ...(context ? { context } : {}) });
	}
	receive(data: unknown): void {
		const subscription = subscriptionUsage(data);
		if (!subscription) return;
		this.publish({ ...this.#usage, subscription });
	}
	private publish(usage: SessionUsage): void {
		if (JSON.stringify(usage) === JSON.stringify(this.#usage)) return;
		this.#usage = structuredClone(usage);
		this.onChange?.(this.current);
	}
}
