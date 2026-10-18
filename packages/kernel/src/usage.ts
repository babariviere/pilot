/** Per-session context usage. Subscription quotas are account-wide and served by the daemon. */
import { randomUUID } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { ContextView, ConversationId, UsageState } from "@earendil-works/pi-durable";
import type { AIUsageActivity, AIUsageCost, AIUsageScope, AIUsageTokens, ContextUsage } from "@pilot/protocol";
import manifest from "../package.json" with { type: "json" };
import type { PerformanceRecord } from "./performance.ts";

const PRICING_REVISION = `pi-ai@${manifest.dependencies["@earendil-works/pi-ai"]}`;

export interface KernelAIUsageConversation {
	/** Local durable conversation identity. pilotd never exposes or exports it. */
	conversationId: string;
	/** Process-local timing identity. pilotd uses it only to deduplicate restart snapshots. */
	timingBoot: string;
	/** Active-context epoch. pilotd retains observed outcomes across resets without double attribution. */
	activityEpoch: string;
	/** Closed classification of the active head. Only compaction is counted as compaction evidence. */
	epochKind: "initial" | "compaction" | "reset" | "other";
	observedAt: number;
	direct: AIUsageScope;
	child: AIUsageScope;
}

/** What a kernel reports about its session's usage. */
export interface KernelUsage {
	context?: ContextUsage;
	/** pi provider of the physical model serving the session, resolved through virtual routers. */
	provider?: string;
	/** Aggregate-only accounting. Provider/model keys from pi's authoritative ledger never cross IPC. */
	accounting?: KernelAIUsageConversation;
}

interface TimingCounters {
	providerAttemptsObserved: number;
	requestRetriesObserved: number;
	elapsedMsObserved: number;
	activeMsObserved: number;
}

interface ActivityCounters {
	count: number;
	success: number;
	failure: number;
	cancelled: number;
	usageReports: number;
}

const zeroTiming = (): TimingCounters => ({
	providerAttemptsObserved: 0,
	requestRetriesObserved: 0,
	elapsedMsObserved: 0,
	activeMsObserved: 0,
});

function amount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.min(Number.MAX_SAFE_INTEGER, Math.round(value))
		: 0;
}

function micros(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return;
	return Math.min(Number.MAX_SAFE_INTEGER, Math.round(value * 1_000_000));
}

function add(left: number, right: number): number {
	return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function usageValues(state: UsageState | undefined, bucket: keyof UsageState): unknown[] {
	const value = state?.[bucket];
	return value && typeof value === "object" && !Array.isArray(value) ? Object.values(value) : [];
}

function tokens(values: unknown[]): AIUsageTokens {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let reasoning = 0;
	let reasoningReports = 0;
	let outputReports = 0;
	for (const value of values) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const usage = value as Record<string, unknown>;
		input = add(input, amount(usage.input));
		output = add(output, amount(usage.output));
		cacheRead = add(cacheRead, amount(usage.cacheRead));
		cacheWrite = add(cacheWrite, amount(usage.cacheWrite));
		if (amount(usage.output) > 0) outputReports++;
		if (usage.reasoning !== undefined) {
			reasoning = add(reasoning, amount(usage.reasoning));
			reasoningReports++;
		}
	}
	const reasoningStatus =
		reasoningReports === 0 ? "unavailable" : reasoningReports < outputReports ? "partial" : "reported";
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		...(reasoningReports ? { reasoning } : {}),
		reasoningStatus,
	};
}

function cost(values: unknown[]): AIUsageCost {
	let estimatedUsdMicros = 0;
	let usageReports = 0;
	let pricedReports = 0;
	for (const value of values) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const usage = value as Record<string, unknown>;
		const tokenCount =
			amount(usage.input) + amount(usage.output) + amount(usage.cacheRead) + amount(usage.cacheWrite);
		const rawCost = usage.cost;
		const estimate =
			rawCost && typeof rawCost === "object" && !Array.isArray(rawCost)
				? micros((rawCost as Record<string, unknown>).total)
				: undefined;
		if (!tokenCount && estimate === undefined) continue;
		usageReports++;
		if (estimate !== undefined) {
			pricedReports++;
			estimatedUsdMicros = Math.min(Number.MAX_SAFE_INTEGER, estimatedUsdMicros + estimate);
		}
	}
	const estimateStatus =
		pricedReports === 0
			? "unavailable"
			: pricedReports < usageReports
				? "partial_catalog_estimate"
				: "catalog_estimate";
	return {
		estimateStatus,
		...(pricedReports ? { estimatedUsdMicros, pricingRevision: PRICING_REVISION } : {}),
		billedStatus: "unavailable",
		subscriptionCoverage: "unknown",
	};
}

function committedActivity(
	view: ContextView,
	conversationId: ConversationId,
	kind: AIUsageActivity["kind"],
): ActivityCounters {
	const counters: ActivityCounters = { count: 0, success: 0, failure: 0, cancelled: 0, usageReports: 0 };
	const reported = (message: Message): boolean => {
		if (message.role !== "assistant" && message.role !== "toolResult") return false;
		const usage = message.usage;
		if (!usage) return false;
		return (
			amount(usage.input) +
				amount(usage.output) +
				amount(usage.cacheRead) +
				amount(usage.cacheWrite) +
				(micros(usage.cost.total) ?? 0) >
			0
		);
	};
	for (let index = 0; index < view.entries.length; index++) {
		if (view.entries[index]?.conversationId !== conversationId) continue;
		for (const message of view.contributions[index] ?? []) {
			if (kind === "model_requests" && message.role === "assistant") {
				counters.count++;
				if (reported(message)) counters.usageReports++;
				if (message.stopReason === "aborted") counters.cancelled++;
				else if (message.stopReason === "error") counters.failure++;
				else counters.success++;
			} else if (kind === "child_operations" && message.role === "toolResult" && message.usage) {
				counters.count++;
				if (reported(message)) counters.usageReports++;
				if (message.isError) counters.failure++;
				else counters.success++;
			}
		}
	}
	return counters;
}

function scope(
	values: unknown[],
	activity: ActivityCounters,
	timing: TimingCounters,
	kind: AIUsageActivity["kind"],
): AIUsageScope {
	return {
		tokens: tokens(values),
		cost: cost(values),
		activity: { ...activity, ...timing, kind, outcomeCoverage: "partial", timingCoverage: "partial" },
	};
}

export function aiUsageConversation(
	view: ContextView,
	conversationId: ConversationId,
	state: UsageState | undefined,
	timingBoot: string,
	timing: { direct: TimingCounters; child: TimingCounters },
	now = Date.now(),
): KernelAIUsageConversation {
	return {
		conversationId: String(conversationId),
		timingBoot,
		activityEpoch: view.head ? String(view.head.id) : "initial",
		epochKind:
			view.head === undefined
				? "initial"
				: view.head.kind === "pi.compaction"
					? "compaction"
					: view.head.kind === "pi.reset"
						? "reset"
						: "other",
		observedAt: now,
		direct: scope(
			usageValues(state, "models"),
			committedActivity(view, conversationId, "model_requests"),
			timing.direct,
			"model_requests",
		),
		child: scope(
			usageValues(state, "tools"),
			committedActivity(view, conversationId, "child_operations"),
			timing.child,
			"child_operations",
		),
	};
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
	readonly #timingBoot = randomUUID();
	readonly #timing = { direct: zeroTiming(), child: zeroTiming() };
	private readonly onChange?: (usage: KernelUsage) => void;
	constructor(onChange?: (usage: KernelUsage) => void) {
		this.onChange = onChange;
	}
	get current(): KernelUsage {
		return structuredClone(this.#usage);
	}
	set(
		context: ContextUsage | undefined,
		provider: string | undefined,
		accounting?: {
			view: ContextView;
			conversationId: ConversationId;
			state: UsageState | undefined;
			observedAt: number;
		},
	): void {
		let report = accounting
			? aiUsageConversation(
					accounting.view,
					accounting.conversationId,
					accounting.state,
					this.#timingBoot,
					this.#timing,
					accounting.observedAt,
				)
			: undefined;
		const previous = this.#usage.accounting;
		if (
			report &&
			previous &&
			JSON.stringify({ ...report, observedAt: 0 }) === JSON.stringify({ ...previous, observedAt: 0 })
		)
			report = { ...report, observedAt: previous.observedAt };
		this.publish({
			...(context ? { context } : {}),
			...(provider ? { provider } : {}),
			...(report ? { accounting: report } : {}),
		});
	}
	/** Request timing is observational and partial; committed entries remain the request/outcome source of truth. */
	recordRequest(record: PerformanceRecord): void {
		const counters = record.source === "generation" ? this.#timing.direct : this.#timing.child;
		counters.providerAttemptsObserved = add(
			counters.providerAttemptsObserved,
			Math.max(1, amount(record.httpAttempts)),
		);
		counters.requestRetriesObserved = add(
			counters.requestRetriesObserved,
			Math.max(0, amount(record.httpAttempts) - 1),
		);
		counters.elapsedMsObserved = add(counters.elapsedMsObserved, amount(record.totalMs));
		counters.activeMsObserved = add(counters.activeMsObserved, amount(record.providerMs));
		const accounting = this.#usage.accounting;
		if (!accounting) return;
		const kind = record.source === "generation" ? "direct" : "child";
		this.publish({
			...this.#usage,
			accounting: {
				...accounting,
				observedAt: Date.now(),
				[kind]: {
					...accounting[kind],
					activity: { ...accounting[kind].activity, ...counters },
				},
			},
		});
	}
	private publish(usage: KernelUsage): void {
		if (JSON.stringify(usage) === JSON.stringify(this.#usage)) return;
		this.#usage = structuredClone(usage);
		this.onChange?.(this.current);
	}
}
