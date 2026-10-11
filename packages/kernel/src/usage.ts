/** Per-session context usage. Subscription quotas are account-wide and served by the daemon. */
import type { Message } from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { ContextView } from "@earendil-works/pi-durable";
import type { ContextUsage } from "@pilot/protocol";

/** What a kernel reports about its session's usage. */
export interface KernelUsage {
	context?: ContextUsage;
	/** pi provider of the physical model serving the session, resolved through virtual routers. */
	provider?: string;
}

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

export class UsageTracker {
	#usage: KernelUsage = {};
	private readonly onChange?: (usage: KernelUsage) => void;
	constructor(onChange?: (usage: KernelUsage) => void) {
		this.onChange = onChange;
	}
	get current(): KernelUsage {
		return structuredClone(this.#usage);
	}
	set(context: ContextUsage | undefined, provider: string | undefined): void {
		this.publish({ ...(context ? { context } : {}), ...(provider ? { provider } : {}) });
	}
	private publish(usage: KernelUsage): void {
		if (JSON.stringify(usage) === JSON.stringify(this.#usage)) return;
		this.#usage = structuredClone(usage);
		this.onChange?.(this.current);
	}
}
