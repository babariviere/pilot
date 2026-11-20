/** A reserve-before-provider boundary, also installed on inherited helper runtimes. */
import { randomUUID } from "node:crypto";
import { SubscriptionGate } from "@babariviere/pi-extensions/subscription-gate";
import {
	type Api,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { FundingTokens } from "@pilot/protocol";

export interface FundingAdmission {
	/** Day evidence/authority must be rechecked after any subscription wait, immediately before dispatch. */
	waitBeforeReserve?: true;
	reserve(id: string, model: Model<Api>, bound: FundingBound): Promise<void>;
	settle(id: string, usage: FundingTokens): Promise<void>;
}
/** A final payload's output bound, or why it has none. The daemon refuses `hold` only while limits are on. */
export type FundingBound = { outputTokens: number } | { hold: string };
const guarded = Symbol("funding guarded request");
/** A caller's own output limit. Like a missing bound, a larger bound is held only while limits are on. */
export const fundingOutputLimit = Symbol("funding output limit");
export type FundingStreamOptions = ModelsSimpleStreamOptions & { [fundingOutputLimit]?: number };
/** Fund the chosen model only. Suppress the SDK's generated automatic fallback list, not saved settings. */
export function fundingPayload(payload: unknown, model: Model<Api>): unknown {
	if (
		model.api !== "anthropic-messages" ||
		!model.compat ||
		!("allowedFallbackModels" in model.compat) ||
		!model.compat.allowedFallbackModels?.length
	)
		return payload;
	const p = payload as Record<string, unknown>;
	const generated = model.compat.allowedFallbackModels.map((f) => ({ model: f.model }));
	if (JSON.stringify(p?.fallbacks) !== JSON.stringify(generated)) return payload;
	const single = { ...p };
	delete single.fallbacks;
	return single;
}
/**
 * APIs whose backend refuses a request output cap, so the model's own output maximum is the only bound.
 * The ChatGPT Codex backend (subscription OAuth only) answers `max_output_tokens` with "Unsupported parameter".
 * The daemon reserves its canonical catalog maximum for these. Pay-per-token APIs still need a payload cap.
 */
export const modelLimitedOutputApis: ReadonlySet<string> = new Set(["openai-codex-responses"]);
/** Inspect the final payload after extension hooks, not the caller's suggested output limit. */
export function fundingOutputBound(
	api: string,
	payload: unknown,
	expectedModel?: string,
	modelMaxTokens?: number,
): number {
	const p = payload as Record<string, unknown> | undefined;
	if (expectedModel !== undefined && p?.model !== expectedModel)
		throw new Error("Allowance hold: final payload changed the priced model");
	if (Array.isArray(p?.fallbacks) && p.fallbacks.length)
		throw new Error("Allowance hold: fallback model prices are not bounded");
	if (p?.background === true) throw new Error("Allowance hold: deferred request bounds are not qualified");
	if (p?.n !== undefined && p.n !== 1) throw new Error("Allowance hold: multiple completions have no qualified bound");
	if (
		Array.isArray(p?.tools) &&
		p.tools.some((t) => t && typeof t === "object" && "type" in t && !["function", "custom"].includes(String(t.type)))
	)
		throw new Error("Allowance hold: hosted-tool prices are unavailable");
	const raw =
		api === "anthropic-messages"
			? p?.max_tokens
			: api === "openai-responses"
				? p?.max_output_tokens
				: api === "openai-completions"
					? (p?.max_completion_tokens ?? p?.max_tokens)
					: modelLimitedOutputApis.has(api)
						? modelMaxTokens
						: undefined;
	if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1)
		throw new Error("Allowance hold: this provider request has no verified output bound");
	return raw;
}
export function fundingBound(
	api: string,
	payload: unknown,
	expectedModel: string,
	modelMaxTokens: number,
): FundingBound {
	try {
		return { outputTokens: fundingOutputBound(api, payload, expectedModel, modelMaxTokens) };
	} catch (e) {
		return { hold: e instanceof Error ? e.message : "Allowance hold: request bound unavailable" };
	}
}
export function fundingUsage(message: AssistantMessage): FundingTokens | undefined {
	if (!["stop", "length", "toolUse"].includes(message.stopReason)) return;
	if (message.responseModel && message.responseModel !== message.model) return;
	const { input, output, cacheRead, cacheWrite } = message.usage;
	if (
		![input, output, cacheRead, cacheWrite].every((n) => Number.isSafeInteger(n) && n >= 0) ||
		input + output + cacheRead + cacheWrite === 0
	)
		return;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		...(message.usage.cacheWrite1h !== undefined ? { cacheWrite1h: message.usage.cacheWrite1h } : {}),
	};
}
export function installFundingRuntime(runtime: ModelRuntime, admission: FundingAdmission): void {
	const subscription = new SubscriptionGate(process.env.PILOT_SUBSCRIPTION_POLICY);
	for (const method of ["stream", "streamSimple"] as const) {
		const original = runtime[method].bind(runtime);
		const wrapped = (
			model: Model<Api>,
			context: Context,
			options?: FundingStreamOptions & { [guarded]?: boolean },
		) => {
			if (options?.[guarded]) return original(model, context, options);
			const out = createAssistantMessageEventStream();
			void (async () => {
				let reserved: { id: string; provider: string; model: string } | undefined;
				try {
					const opts: ModelsSimpleStreamOptions & { [guarded]: boolean } = {
						...options,
						[guarded]: true,
						maxRetries: 0,
						disableContinuation: true,
						onPayload: async (payload, physical) => {
							const single = fundingPayload(payload, physical);
							const final = (await options?.onPayload?.(single, physical)) ?? single;
							const id = randomUUID();
							let bound = fundingBound(physical.api, final, physical.id, physical.maxTokens);
							const limit = options?.[fundingOutputLimit];
							if (limit !== undefined && "outputTokens" in bound && bound.outputTokens > limit)
								bound = {
									hold: `Allowance hold: output limit is ${limit} tokens; got ${bound.outputTokens}. Choose a model that supports this bound.`,
								};
							if (admission.waitBeforeReserve) await subscription.wait(physical.provider, options?.signal);
							options?.signal?.throwIfAborted();
							await admission.reserve(id, physical, bound);
							if (!admission.waitBeforeReserve) await subscription.wait(physical.provider, options?.signal);
							options?.signal?.throwIfAborted();
							reserved = { id, provider: physical.provider, model: physical.id };
							return final;
						},
					};
					const source = original(model, context, opts);
					for await (const event of source) if (event.type !== "done" && event.type !== "error") out.push(event);
					const result = await source.result(),
						evidence = fundingUsage(result);
					if (reserved && evidence && result.provider === reserved.provider && result.model === reserved.model)
						await admission.settle(reserved.id, evidence);
					if (result.stopReason === "error" || result.stopReason === "aborted")
						out.push({ type: "error", reason: result.stopReason, error: result });
					else if (result.stopReason !== "pending")
						out.push({ type: "done", reason: result.stopReason, message: result });
					out.end(result);
				} catch (e) {
					const error: AssistantMessage = {
						role: "assistant",
						content: [],
						api: model.api,
						provider: model.provider,
						model: model.id,
						timestamp: Date.now(),
						stopReason: "error",
						errorMessage: e instanceof Error ? e.message : "Allowance unavailable",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					};
					out.push({ type: "error", reason: "error", error });
					out.end(error);
				}
			})();
			return out;
		};
		// The provider-specific stream keeps all options; only common request hooks change.
		Object.defineProperty(runtime, method, { value: wrapped, configurable: true, writable: true });
	}
	// These APIs have no qualified monetary bound at this boundary yet.
	for (const method of [
		"embed",
		"classify",
		"generateImage",
		"images",
		"generateSpeech",
		"transcribe",
		"fetchDeferred",
	] as const) {
		if (method in runtime)
			Object.defineProperty(runtime, method, {
				value: () => {
					throw new Error("Allowance hold: request pricing or bound unavailable");
				},
				configurable: true,
			});
	}
}
