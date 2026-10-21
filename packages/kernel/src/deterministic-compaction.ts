/**
 * The normal compaction path for ordinary chats: a deterministic digest from the retained original transcript,
 * validated before the Harness switches context. The Harness still selects the range (tool-safe) and places the
 * summary entry atomically; original entries stay in storage. When the digest cannot be used, a target compaction is declined with backoff (the request still fits), and a
 * required one (window safety, overflow, manual) falls back to the Harness model summary.
 */
import { performance } from "node:perf_hooks";
import type { Usage } from "@earendil-works/pi-ai";
import {
	calculateContextTokens,
	estimateContextTokens,
	estimateMessageTokens,
} from "@earendil-works/pi-ai/utils/estimate";
import {
	CompactionTask,
	type Extension,
	GenerationTask,
	type Harness,
	hook,
	LiveDoc,
} from "@earendil-works/pi-durable";
import {
	COMPACTION_TARGETS,
	type CompactionTargets,
	compactionPolicy,
	type PilotCompactionPolicy,
} from "./compaction-policy.ts";
import { DigestCompiler, renderDigest, validateDigest } from "./context-digest.ts";

export type CompactionRegime = "target" | "window" | "overflow" | "manual";
export type CompactionOutcome = "digest" | "declined" | "model";
export type CompactionWhy =
	| "instructions"
	| "insufficient_reduction"
	| "empty"
	| "oversized"
	| "unredacted"
	| "framing"
	| "references"
	| "error";

/** Content-free numbers and closed enums only. Never text, paths, commands or errors. */
export type CompactionRecord =
	| {
			v: 1;
			source: "compaction";
			at: number;
			regime: CompactionRegime;
			outcome: CompactionOutcome;
			why?: CompactionWhy;
			priorFailure?: boolean;
			window: number;
			trigger: number;
			safety: number;
			keepRecentTokens: number;
			digestBudget: number;
			beforeTokens: number;
			overheadTokens: number;
			keptTokens: number;
			digestTokens?: number;
			afterTokens?: number;
			folded?: number;
			compileMs: number;
			/** Measured provider prompt tokens per pi-ai estimated token for this chat; 1 before any measurement. */
			providerTokensPerEstimate: number;
	  }
	| {
			v: 1;
			source: "compaction_usage";
			at: number;
			/** Our estimate of total input right after the compaction. */
			estimatedTokens: number;
			/** The provider's first reported total input afterwards. */
			actualTokens: number;
			input: number;
			cacheRead: number;
			cacheWrite: number;
			output: number;
	  };

const ENUMS: Record<string, readonly string[]> = {
	regime: ["target", "window", "overflow", "manual"],
	outcome: ["digest", "declined", "model"],
	why: [
		"instructions",
		"insufficient_reduction",
		"empty",
		"oversized",
		"unredacted",
		"framing",
		"references",
		"error",
	],
};

/** Whitelisted serializer for the private, capped compaction log. */
export function compactionLine(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return;
	const record = value as Record<string, unknown>;
	if (record.v !== 1 || (record.source !== "compaction" && record.source !== "compaction_usage")) return;
	const safe: Record<string, number | string | boolean> = { v: 1, source: record.source };
	for (const [key, item] of Object.entries(record)) {
		if (key === "v" || key === "source") continue;
		if (typeof item === "number" && Number.isFinite(item) && item >= 0) safe[key] = Math.round(item * 100) / 100;
		else if (typeof item === "boolean") safe[key] = item;
		else if (typeof item === "string" && ENUMS[key]?.includes(item)) safe[key] = item;
	}
	return `${JSON.stringify(safe)}\n`;
}

/**
 * Default rollout stays blocked until the digest is validated against real providers: ordinary chats keep the
 * Harness defaults and model summaries unless PILOT_DETERMINISTIC_COMPACTION=1 is set for pilotd and its kernels.
 */
export function deterministicCompactionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.PILOT_DETERMINISTIC_COMPACTION === "1";
}

export type DeterministicCompactionOptions = {
	harness: () => Harness | undefined;
	/** history_recall is available, so the digest can point to it. */
	recall: boolean;
	log?: { record(record: CompactionRecord): void };
	targets?: CompactionTargets;
};

function sum(messages: readonly import("@earendil-works/pi-ai").Message[]): number {
	return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

export class DeterministicCompaction {
	readonly #options: DeterministicCompactionOptions;
	readonly #targets: CompactionTargets;
	readonly #compiler = new DigestCompiler();
	/** Total input of the last declined target compaction, per conversation. */
	readonly #backoff = new Map<string, number>();
	/** The estimate after a placed digest, compared with the next provider usage. */
	readonly #pending = new Map<string, number>();
	/**
	 * Provider prompt tokens per pi-ai estimated token, measured per conversation from its own requests. Character
	 * estimates undercount code-heavy chats, so budgets in estimated tokens are scaled to stay near their real size.
	 * Nothing is assumed: without a measurement the scale is 1.
	 */
	readonly #ratio = new Map<string, number>();
	readonly #sample = new Map<string, number>();
	#requests = 0;

	constructor(options: DeterministicCompactionOptions) {
		this.#options = options;
		this.#targets = options.targets ?? COMPACTION_TARGETS;
	}

	/** Record one request's provider prompt tokens against pi-ai's estimate of the same messages. */
	calibrate(conversationId: unknown, providerTokens: number, estimatedTokens: number): void {
		if (!(providerTokens > 0) || !(estimatedTokens > 1_000)) return;
		this.#ratio.set(String(conversationId), Math.min(2.5, Math.max(1, providerTokens / estimatedTokens)));
	}

	/** The measured provider tokens per estimated token for a conversation, or 1 before any measurement. */
	ratio(conversationId?: unknown): number {
		return conversationId === undefined ? 1 : (this.#ratio.get(String(conversationId)) ?? 1);
	}

	/** The Harness policy for a window, with this conversation's backoff. Read on every request preparation. */
	policy(window: number, conversationId?: unknown): PilotCompactionPolicy {
		const scale = this.ratio(conversationId);
		return compactionPolicy(
			window,
			conversationId === undefined ? undefined : this.#backoff.get(String(conversationId)),
			scale === 1
				? this.#targets
				: {
						...this.#targets,
						keepRecentTokens: Math.round(this.#targets.keepRecentTokens / scale),
						digestTokens: Math.round(this.#targets.digestTokens / scale),
					},
		);
	}

	extension(extension: Extension): Extension {
		return {
			...extension,
			hooks: [
				...(extension.hooks ?? []),
				hook(CompactionTask, {
					beforeCompact: (compaction, api, context) => this.#compact(compaction, api, context),
				}),
				hook(GenerationTask, {
					beforeRequest: (request, api) => {
						// Sample occasionally: estimating the whole request is linear in its size.
						const key = String(api.conversationId);
						if (this.#ratio.has(key) && this.#requests++ % 8 !== 0) return undefined;
						this.#sample.set(key, sum(request.messages));
						return undefined;
					},
					afterResponse: (message, api) => {
						const key = String(api.conversationId);
						const sampled = this.#sample.get(key);
						if (sampled !== undefined && message.stopReason !== "error" && message.stopReason !== "aborted") {
							this.#sample.delete(key);
							const usage = message.usage as Usage;
							this.calibrate(
								key,
								(usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
								sampled,
							);
						}
						const estimated = this.#pending.get(key);
						if (estimated === undefined || message.stopReason === "error" || message.stopReason === "aborted")
							return;
						const usage = message.usage as Usage;
						const actual = calculateContextTokens(usage);
						if (!(actual > 0)) return;
						this.#pending.delete(key);
						this.#options.log?.record({
							v: 1,
							source: "compaction_usage",
							at: Date.now(),
							estimatedTokens: estimated,
							actualTokens: actual,
							input: usage.input ?? 0,
							cacheRead: usage.cacheRead ?? 0,
							cacheWrite: usage.cacheWrite ?? 0,
							output: usage.output ?? 0,
						});
					},
				}),
			],
		};
	}

	async #compact(
		compaction: Parameters<NonNullable<import("@earendil-works/pi-durable").CompactionHooks["beforeCompact"]>>[0],
		api: import("@earendil-works/pi-durable").HookApi,
		context: import("@earendil-works/chord").Context,
	): Promise<{ summary: string } | { decline: true } | undefined> {
		const started = performance.now();
		const harness = this.#options.harness();
		const conversation = harness ? await harness.conversation(api.conversationId, context) : undefined;
		if (!conversation) return undefined;
		const key = String(api.conversationId);
		const agent = await conversation.agent(context);
		const window = agent.model
			? (api.models.getModel(agent.model.provider, agent.model.modelId)?.contextWindow ?? 0)
			: 0;
		const view = await conversation.context(context);
		const measured = estimateContextTokens(view.messages);
		// Provider usage counts more tokens than pi-ai's character estimate (code tokenizes densely). Measure the
		// ratio from this context's own last usage when no request sample exists yet, so before and after use one unit.
		if (!this.#ratio.has(key) && measured.lastUsageIndex !== null && measured.usageTokens > 0)
			this.calibrate(key, measured.usageTokens, sum(view.messages.slice(0, measured.lastUsageIndex + 1)));
		const ratio = this.ratio(key);
		const policy = this.policy(window, key);
		const beforeTokens = measured.tokens;
		// What remains after scaling the messages: tool schemas and other request parts outside the transcript.
		const overheadTokens = Math.max(0, Math.round(beforeTokens - ratio * sum(view.messages)));
		const firstKept = Number(compaction.firstKept);
		const keptTokens = sum(
			view.entries.flatMap((entry, index) => (Number(entry.id) >= firstKept ? view.contributions[index]! : [])),
		);
		const priorFailure = !!(await api.snapshot(LiveDoc, api.conversationId, context))?.compactionFailure;
		const regime: CompactionRegime =
			compaction.reason === "manual"
				? "manual"
				: compaction.reason === "overflow"
					? "overflow"
					: beforeTokens > policy.safety
						? "window"
						: "target";
		const base = {
			v: 1 as const,
			source: "compaction" as const,
			regime,
			...(priorFailure ? { priorFailure } : {}),
			window: policy.window,
			providerTokensPerEstimate: this.ratio(key),
			trigger: policy.trigger,
			safety: policy.safety,
			keepRecentTokens: policy.keepRecentTokens,
			digestBudget: policy.digestTokens,
			beforeTokens,
			overheadTokens,
			keptTokens,
		};
		const finish = (outcome: CompactionOutcome, extra: Partial<CompactionRecord & { source: "compaction" }> = {}) =>
			this.#options.log?.record({
				...base,
				...extra,
				at: Date.now(),
				outcome,
				compileMs: performance.now() - started,
			} as CompactionRecord);
		const unusable = (why: CompactionWhy) => {
			if (regime === "target") {
				// The request still fits: keep the context, and wait for growth before trying again.
				this.#backoff.set(key, beforeTokens);
				finish("declined", { why });
				return { decline: true as const };
			}
			finish("model", { why });
			return undefined;
		};
		// An explicit manual focus is a prompt for the model summarizer, unless the model summary already failed.
		if (compaction.instructions?.trim() && !priorFailure) {
			finish("model", { why: "instructions" });
			return undefined;
		}
		try {
			const { state, folded } = await this.#compiler.fold(conversation, firstKept, context);
			const summary = renderDigest(state, {
				budgetTokens: policy.digestTokens,
				firstKept,
				recall: this.#options.recall,
			});
			const valid = validateDigest(summary, { budgetTokens: policy.digestTokens, firstKept });
			if (!valid.ok) return unusable(valid.reason);
			const afterTokens = Math.round(overheadTokens + ratio * (valid.tokens + keptTokens));
			if (regime === "target" && afterTokens > beforeTokens * this.#targets.maxAfterRatio)
				return unusable("insufficient_reduction");
			this.#backoff.delete(key);
			this.#pending.set(key, afterTokens);
			finish("digest", { digestTokens: valid.tokens, afterTokens, folded });
			return { summary };
		} catch {
			return unusable("error");
		}
	}
}
